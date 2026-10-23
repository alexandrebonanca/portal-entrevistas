import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc, newToken, sha256 } from './lib.ts';
import { queueEmail, emailShell } from './mail.ts';

/**
 * Confirmação do email da conta («Confirm your email»), exigida só para a 1.ª entrevista grátis (subscrever e pagar
 * continuam sem ela). O registo público (sem entidade) envia o link, só com a oferta ligada (o email fala dela; ver
 * routes/site.ts, que também não o reenvia com a oferta desligada); as contas criadas pelo administrador, a primeira
 * (administradora) e as de uma entidade ficam confirmadas. O token é aleatório (256 bits): na tabela `email_verifications`
 * fica só a impressão (sha256); o link completo fica, como os dos convites, na cópia do email (tabela `emails`, que a
 * /privacy refere). Vale VERIFY_HOURS e uma só vez. O GET mostra a página e só o POST (botão) confirma, como nas outras
 * ações com efeitos (um leitor de links do correio não confirma nada sozinho).
 */
export const VERIFY_HOURS = 48;
/** «Reenviar»: pedidos por conta e por hora (em memória, contra pedidos em série; os emails contam-se na base, abaixo). */
export const VERIFY_RESEND_PER_HOUR = 10;
/**
 * Emails de confirmação por conta, contados na base (`email_verifications`, o do registo incluído): no máximo
 * VERIFY_PER_DAY em 24 horas e VERIFY_TOTAL ao todo. O endereço nunca foi provado: sem este total, uma conta registada
 * com o email de outra pessoa mandava-lhe emails sem fim. Acima dele, nada se envia e o teto global não se gasta.
 */
export const VERIFY_PER_DAY = 3;
export const VERIFY_TOTAL = 5;
/** Bloqueio consultivo que serializa a contagem do teto global e a inserção do email (dois registos não passam o teto). */
const VERIFY_LOCK = 7710362;

/** Forma de um token (newToken(32): 43 caracteres base64url); outra forma não chega à base de dados. */
export const tokenShape = (t: unknown) => typeof t === 'string' && /^[A-Za-z0-9_-]{43}$/.test(t);

/** Emails de confirmação postos na fila na última hora e no último dia (todas as contas), contra os tetos da configuração. */
async function capReached(t: Db) {
  const { verifyEmailsPerHour: h, verifyEmailsPerDay: d } = config.limits;
  if (!h || !d) return true;
  const r = await t.one(`SELECT count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int AS h, count(*)::int AS d
    FROM emails WHERE starts_with(dedupe_key, 'verify:') AND created_at > now() - interval '1 day'`);
  return Number(r?.h ?? 0) >= h || Number(r?.d ?? 0) >= d;
}

let lastCapWarn = 0;
/** Emails de confirmação já enviados à conta: nas últimas 24 horas e ao todo (contra VERIFY_PER_DAY e VERIFY_TOTAL). */
export async function verificationsSent(db: Db, userId: string): Promise<{ day: number; total: number }> {
  const r = await db.one(`SELECT count(*) FILTER (WHERE created_at > now() - interval '1 day')::int AS day, count(*)::int AS total
    FROM email_verifications WHERE user_id=$1`, [userId]);
  return { day: Number(r?.day ?? 0), total: Number(r?.total ?? 0) };
}

/**
 * Põe na fila o email com um link novo (os anteriores continuam válidos até expirarem). 'verified': a conta já está
 * confirmada (nada a enviar); 'total_limit' e 'day_limit': a conta já recebeu VERIFY_TOTAL emails, ou VERIFY_PER_DAY nas
 * últimas 24 horas (nada enviado, e o teto global fica como estava); 'cap': teto global atingido (nada enviado; o painel
 * deixa pedir outro mais tarde). Os totais da conta contam-se com o mesmo bloqueio do teto global (dois pedidos em
 * simultâneo não passam os dois). O email é fixo: nunca leva texto escrito por quem se registou (nem o nome), porque o
 * endereço pode ser de outra pessoa.
 */
export async function sendVerification(db: Db, userId: string): Promise<'sent' | 'verified' | 'day_limit' | 'total_limit' | 'cap' | 'gone'> {
  const r = await db.tx(async t => {
    await t.query('SELECT pg_advisory_xact_lock($1)', [VERIFY_LOCK]);
    const u = await t.one('SELECT email, email_verified_at FROM users WHERE id=$1', [userId]);
    if (!u) return 'gone' as const;
    if (u.email_verified_at) return 'verified' as const;
    const n = await verificationsSent(t, userId);
    if (n.total >= VERIFY_TOTAL) return 'total_limit' as const;
    if (n.day >= VERIFY_PER_DAY) return 'day_limit' as const;
    if (await capReached(t)) return 'cap' as const;
    const token = newToken(32);
    const v = await t.one(`INSERT INTO email_verifications(user_id, token_hash, expires_at) VALUES ($1,$2, now() + ($3 || ' hours')::interval) RETURNING id`,
      [userId, sha256(token), String(VERIFY_HOURS)]);
    const url = `${config.baseUrl}/confirmar-email/${token}`;
    const b = config.brand;
    const lines = [
      `Please confirm that this is the email address of your ${b} account.`,
      `The link is valid for ${VERIFY_HOURS} hours and can be used once. A confirmed email is needed only to send your free first interview; everything else in your account works without it.`,
      `If you did not create a ${b} account, you can ignore this email: the account stays unconfirmed.`,
    ];
    await queueEmail(t, {
      key: `verify:${v.id}`, to: u.email, subject: `Confirm your email for ${b}`,
      html: emailShell('Confirm your email', lines.map(l => `<p>${esc(l)}</p>`).join(''), { label: 'Confirm my email', url }, { lang: 'en' }),
      text: ['Confirm your email', ...lines, `Confirm my email: ${url}`, `${b} · ${config.baseUrl}/contact · ${config.baseUrl}/privacy`].join('\n\n'),
    });
    return 'sent' as const;
  });
  if (r === 'cap' && Date.now() - lastCapWarn > 300_000) {
    lastCapWarn = Date.now();
    console.warn('[verificação do email] teto global de emails de confirmação atingido: conta sem email (pode pedir outro no painel)');
  }
  return r;
}

/** Último link enviado à conta (para o aviso do painel); null se nunca foi enviado. */
export async function lastVerificationAt(db: Db, userId: string): Promise<Date | null> {
  const r = await db.one('SELECT max(created_at) AS at FROM email_verifications WHERE user_id=$1', [userId]);
  return r?.at ? new Date(r.at) : null;
}

export type TokenState = 'valid' | 'used' | 'expired' | 'invalid';

/** Estado de um link, sem o gastar (página do GET). */
export async function verificationState(db: Db, token: unknown): Promise<{ state: TokenState; verified: boolean }> {
  if (!tokenShape(token)) return { state: 'invalid', verified: false };
  const v = await db.one(`SELECT v.used_at, v.expires_at <= now() AS expired, u.email_verified_at FROM email_verifications v JOIN users u ON u.id=v.user_id WHERE v.token_hash=$1`, [sha256(token as string)]);
  if (!v) return { state: 'invalid', verified: false };
  return { state: v.used_at ? 'used' : v.expired ? 'expired' : 'valid', verified: !!v.email_verified_at };
}

/**
 * Confirma o email pelo link (POST): o link e a conta bloqueados, o link gasto e a conta confirmada na mesma transação.
 * 'ok': confirmado agora; 'already': o link era válido mas a conta já estava confirmada (por outro link); 'used', 'expired'
 * e 'invalid' não mudam nada.
 */
export async function confirmEmail(db: Db, token: unknown): Promise<{ result: 'ok' | 'already' | 'used' | 'expired' | 'invalid'; userId?: string; verified?: boolean }> {
  if (!tokenShape(token)) return { result: 'invalid' };
  return db.tx(async t => {
    const v = await t.one(`SELECT id, user_id, used_at, expires_at <= now() AS expired FROM email_verifications WHERE token_hash=$1 FOR UPDATE`, [sha256(token as string)]);
    if (!v) return { result: 'invalid' as const };
    const u = await t.one('SELECT email_verified_at FROM users WHERE id=$1 FOR UPDATE', [v.user_id]);
    if (v.used_at) return { result: 'used' as const, userId: v.user_id, verified: !!u?.email_verified_at };
    if (v.expired) return { result: 'expired' as const, userId: v.user_id, verified: !!u?.email_verified_at };
    await t.query('UPDATE email_verifications SET used_at=now() WHERE id=$1', [v.id]);
    if (u?.email_verified_at) return { result: 'already' as const, userId: v.user_id, verified: true };
    await t.query('UPDATE users SET email_verified_at=now() WHERE id=$1', [v.user_id]);
    return { result: 'ok' as const, userId: v.user_id, verified: true };
  });
}
