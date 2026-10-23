import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc, sha256, fmtDate } from './lib.ts';
import { ACTIVE_STATUSES } from './billing.ts';
import { inviteLimits, mmss } from './limits.ts';
import { lastVerificationAt } from './email-verify.ts';

/**
 * 1.ª entrevista grátis: oferta do quietinterview a quem se regista, para experimentar o produto sem pagar. Só para o
 * entrevistador sem entidade (as entidades têm faturação própria), sem subscrição ativa nem anterior (qualquer linha em
 * `subscriptions`: paga, oferta do administrador ou criada à mão), que nunca a usou e com o email da conta confirmado. Uma por
 * caixa de correio: o email da conta normalizado (como o do convidado) fica em `users.free_owner_hash` no envio, e outra conta
 * com o mesmo email normalizado (eve+1@gmail.com, e.v.e@gmail.com) já não a tem.
 * Tetos globais por dia e por mês (UTC), contados na base (`interviews.free_at`); 0 desliga a oferta. Cada convidado
 * (email normalizado) recebe no máximo uma em todo o portal, seja quem for que o convide (índice único na impressão).
 * Limites da entrevista: os do plano Start (tabela `plans`); regenerações incluídas como num plano; a animação por IA
 * continua por orçamento e com créditos, e a introdução animada não é oferecida por ela (ver routes/intro.ts). A entrevista
 * grátis não conta para a quota de um plano subscrito depois (quotaFor exclui-a, como as extra).
 */
export type FreeReason = 'role' | 'entity' | 'subscribed' | 'used' | 'had_subscription' | 'off' | 'unverified' | 'cap_day' | 'cap_month' | 'guest_used';
export interface FreeState { eligible: boolean; reason: FreeReason | null; usedAt: Date | null; interviewId: string | null; verified: boolean }

/** Bloqueio consultivo das entrevistas grátis: serializa todos os pedidos (tetos globais, uma por caixa de correio e um convidado em todo o portal). */
const FREE_LOCK = 7710361;

/** A oferta está ligada (os dois tetos acima de 0). */
export const freeOfferOn = () => config.limits.freePerDay > 0 && config.limits.freePerMonth > 0;

/**
 * Email normalizado para as regras «uma por convidado» e «uma por caixa de correio» (o email da conta): minúsculas e sem
 * espaços, sem o sub-endereço («+…» antes da @, que a maioria dos fornecedores entrega na mesma caixa) e, no Gmail, sem
 * pontos e com googlemail.com como gmail.com. Outros domínios mantêm os pontos (podem ser caixas diferentes).
 */
export function normGuestEmail(email: string) {
  const e = String(email ?? '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at).split('+')[0], domain = e.slice(at + 1);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local || e.slice(0, at)}@${domain}`;
}
/** Impressão guardada na entrevista grátis (o email em claro já está na entrevista; a impressão serve o índice único). */
export const guestHash = (email: string) => sha256(`free-guest:${normGuestEmail(email)}`);
/** Impressão do email da conta normalizado, guardada no envio (`users.free_owner_hash`): uma entrevista grátis por caixa de correio. */
export const ownerHash = (email: string) => sha256(`free-owner:${normGuestEmail(email)}`);

/** Limites da entrevista grátis: os do plano Start (mesmo inativo); sem ele, os gerais (como um convite sem plano). */
export async function freeLimits(db: Db) {
  const plan = await db.one(`SELECT max_questions, max_answer_total_sec FROM plans WHERE id='start'`);
  return inviteLimits({ exempt: false, plan: plan ?? null });
}

/** Entrevistas grátis enviadas hoje e neste mês (dias e meses em UTC), todas as contas juntas. */
export async function freeCounts(db: Db): Promise<{ day: number; month: number }> {
  const r = await db.one(`SELECT count(*) FILTER (WHERE free_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS day, count(*)::int AS month
    FROM interviews WHERE free_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
  return { day: Number(r?.day ?? 0), month: Number(r?.month ?? 0) };
}

/**
 * Elegibilidade (uma só função, pela ordem das razões): perfil, entidade, subscrição ativa, oferta já usada, subscrição
 * anterior, oferta desligada, email por confirmar, oferta já usada por outra conta com o mesmo email normalizado (`used`; só
 * depois do email confirmado, para nada se dizer sobre uma caixa de correio a quem ainda não provou que é dela), teto do
 * dia, teto do mês e, com `guestEmail`, o convidado que já recebeu uma entrevista grátis. Com `t` numa transação que tem o
 * bloqueio (claimFree), a contagem dos tetos é a definitiva.
 */
export async function freeInterviewFor(db: Db, user: { id: string }, opts: { guestEmail?: string } = {}): Promise<FreeState> {
  const u = await db.one(`SELECT u.email, u.role, u.entity_id, u.email_verified_at, u.free_interview_at, u.free_interview_id, s.status AS sub_status, (s.id IS NOT NULL) AS had_sub
    FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE u.id=$1`, [user.id]);
  const base = { usedAt: u?.free_interview_at ? new Date(u.free_interview_at) : null, interviewId: u?.free_interview_id ?? null, verified: !!u?.email_verified_at };
  const no = (reason: FreeReason): FreeState => ({ eligible: false, reason, ...base });
  if (!u || u.role !== 'interviewer') return no('role');
  if (u.entity_id) return no('entity');
  if (u.sub_status && ACTIVE_STATUSES.includes(u.sub_status)) return no('subscribed');
  if (u.free_interview_at) return no('used');
  if (u.had_sub) return no('had_subscription');
  if (!freeOfferOn()) return no('off');
  if (!u.email_verified_at) return no('unverified');
  if (await db.one('SELECT 1 FROM users WHERE free_owner_hash=$1 AND id<>$2', [ownerHash(u.email), user.id])) return no('used');
  const c = await freeCounts(db);
  if (c.day >= config.limits.freePerDay) return no('cap_day');
  if (c.month >= config.limits.freePerMonth) return no('cap_month');
  if (opts.guestEmail !== undefined && await db.one('SELECT 1 FROM interviews WHERE free_guest_hash=$1', [guestHash(opts.guestEmail)])) return no('guest_used');
  return { eligible: true, reason: null, ...base };
}

/**
 * Marca o envio grátis dentro da transação `t`: com o bloqueio das entrevistas grátis, o titular e a entrevista bloqueados,
 * a elegibilidade (tetos e convidado incluídos) volta a contar-se e a entrevista passa a convidada, grátis e com os limites
 * do Start, e a conta fica com a oferta usada e a impressão da caixa de correio, tudo de uma vez. Dois pedidos em simultâneo
 * (dois separadores, duas contas a convidar a mesma pessoa, a última vaga do teto) nunca passam os dois. Devolve a entrevista
 * como ficou gravada, lida com o bloqueio: o convite (email) envia-se depois, fora desta transação, a partir dela e nunca de
 * uma leitura anterior (um «Guardar» pelo meio mudaria o convidado: o email sairia para um e a marca ficaria com outro);
 * depois de convidada, o «Guardar» já não muda o convidado. Se o envio falhar, releaseFree desfaz.
 */
export async function claimFree(t: Db, userId: string, interviewId: string): Promise<{ ok: true; limits: ReturnType<typeof inviteLimits>; interview: any } | { ok: false; reason: FreeReason | 'done' }> {
  await t.query('SELECT pg_advisory_xact_lock($1)', [FREE_LOCK]);
  const owner = await t.one('SELECT email FROM users WHERE id=$1 FOR UPDATE', [userId]);
  const cur = await t.one('SELECT collection_status, guest_email FROM interviews WHERE id=$1 FOR UPDATE', [interviewId]);
  if (!owner || cur?.collection_status !== 'draft') return { ok: false, reason: 'done' };
  const f = await freeInterviewFor(t, { id: userId }, { guestEmail: cur.guest_email });
  if (!f.eligible) return { ok: false, reason: f.reason! };
  const limits = await freeLimits(t);
  const interview = await t.one(`UPDATE interviews SET collection_status='invited', invited_at=now(), answer_limit_sec=$2, question_limit=$3, free_at=now(), free_guest_hash=$4 WHERE id=$1 RETURNING *`,
    [interviewId, limits.answerLimitSec, limits.questionLimit, guestHash(cur.guest_email)]);
  await t.query('UPDATE users SET free_interview_at=now(), free_interview_id=$2, free_owner_hash=$3 WHERE id=$1', [userId, interviewId, ownerHash(owner.email)]);
  return { ok: true, limits, interview };
}

/** O convite não saiu: a entrevista volta a rascunho (sem a marca nem os limites), o link criado é revogado e a oferta fica por usar (também para a caixa de correio). */
export async function releaseFree(db: Db, userId: string, interviewId: string) {
  await db.tx(async t => {
    await t.query(`UPDATE interviews SET collection_status='draft', invited_at=NULL, answer_limit_sec=NULL, question_limit=NULL, free_at=NULL, free_guest_hash=NULL
      WHERE id=$1 AND collection_status='invited' AND free_at IS NOT NULL`, [interviewId]);
    await t.query('UPDATE invitations SET revoked_at=now() WHERE interview_id=$1 AND revoked_at IS NULL', [interviewId]);
    await t.query('UPDATE users SET free_interview_at=NULL, free_interview_id=NULL, free_owner_hash=NULL WHERE id=$1 AND free_interview_id=$2', [userId, interviewId]);
  });
}

/** Estado da oferta numa conta, para o administrador. */
export const FREE_REASON_PT: Record<FreeReason, string> = {
  role: 'não se aplica (perfil)', entity: 'não se aplica (conta de uma entidade)', subscribed: 'não se aplica (subscrição ativa)', used: 'já usada por outra conta com o mesmo email (normalizado)',
  had_subscription: 'não se aplica (já teve subscrição)', off: 'oferta desligada (teto a 0)', unverified: 'à espera da confirmação do email',
  cap_day: 'teto do dia atingido', cap_month: 'teto do mês atingido', guest_used: 'convidado com entrevista grátis',
};

/** Recusa do envio grátis (POST do convite), em português; null quando a razão não é da oferta (fica a mensagem da subscrição). */
export function freeRefusal(reason: FreeReason | 'done' | null): string | null {
  switch (reason) {
    case 'unverified': return 'Para enviar a 1.ª entrevista grátis, confirme primeiro o email da sua conta (use «Reenviar» se não recebeu a ligação). Também pode enviar o convite com uma subscrição ativa (Conta).';
    case 'used': return 'Já usou a sua entrevista grátis. Para enviar mais convites, precisa de uma subscrição ativa (Conta).';
    case 'cap_day': case 'cap_month': return 'A oferta da 1.ª entrevista grátis está temporariamente indisponível. Pode tentar mais tarde ou enviar o convite com uma subscrição ativa (Conta).';
    case 'guest_used': return 'A entrevista grátis não está disponível para este entrevistado. Pode enviar o convite com uma subscrição ativa (Conta).';
    case 'subscribed': return 'A sua conta tem agora uma subscrição ativa: carregue de novo em «Enviar convite».';
    default: return null;
  }
}

const T = {
  pt: {
    limits: (l: ReturnType<typeof inviteLimits>) => `com os limites do plano Start (até ${l.questionLimit} perguntas, incluindo as adicionais, e até ${mmss(l.answerLimitSec!)} min de respostas do entrevistado)`,
    eligible: (l: ReturnType<typeof inviteLimits>, where: 'painel' | 'convite') => `<strong>A sua 1.ª entrevista é grátis.</strong> ${where === 'convite' ? 'Este convite segue' : 'Envie o primeiro convite'} sem pagamento nem dados de cartão, ${T.pt.limits(l)}. É uma por pessoa e por organização${where === 'painel' ? ': crie a entrevista e, em «Rever e convidar», carregue em «Enviar convite grátis»' : ''}.`,
    unverified: (email: string, sent: Date | null) => `<strong>A sua 1.ª entrevista é grátis</strong>, depois de confirmar o email da sua conta. ${sent ? `Enviámos uma ligação para ${esc(email)} em ${esc(fmtDate(sent))} (válida 48 horas).` : `Ainda não foi possível enviar a ligação para ${esc(email)}: carregue em «Reenviar».`}`,
    resend: 'Reenviar',
    used: (at: Date | null) => `Já usou a sua entrevista grátis${at ? ` (enviada em ${esc(fmtDate(at))})` : ''}. Para enviar mais convites, escolha um plano em <a href="/account">Conta</a>.`,
    cap: 'A oferta da 1.ª entrevista grátis está temporariamente indisponível. Pode tentar mais tarde ou escolher um plano em <a href="/account">Conta</a>.',
  },
  en: {
    limits: (l: ReturnType<typeof inviteLimits>) => `with the Start plan limits (up to ${l.questionLimit} questions, additional ones included, and ${mmss(l.answerLimitSec!)} min of answers)`,
    eligible: (l: ReturnType<typeof inviteLimits>) => `<strong>Your first interview is free.</strong> Send your first invitation with no payment and no card details, ${T.en.limits(l)}: create it on the dashboard (Painel) and press «Enviar convite grátis» (Send free invitation). One per person and organisation.`,
    unverified: (email: string, sent: Date | null) => `<strong>Your first interview is free</strong> once you confirm your account’s email. ${sent ? `We sent a link to ${esc(email)} on ${esc(fmtDate(sent))} (valid for 48 hours).` : `We could not send the link to ${esc(email)} yet: press «Resend».`}`,
    resend: 'Resend',
    used: (at: Date | null) => `You have used your free interview${at ? ` (sent on ${esc(fmtDate(at))})` : ''}. To send more invitations, choose a plan below.`,
    cap: 'The free first interview offer is temporarily unavailable. You can try again later or choose a plan below.',
  },
};

/**
 * Aviso do estado da oferta (painel e página do convite em português; Conta em inglês): disponível, falta confirmar o email
 * (com «Reenviar»), usada ou indisponível por teto (texto neutro). Vazio quando a oferta não se aplica à conta.
 * `back`: a página para onde «Reenviar» volta.
 */
export async function freeNotice(db: Db, f: FreeState, user: { id: string; email: string }, o: { lang: 'pt' | 'en'; where?: 'painel' | 'convite'; back: string }): Promise<string> {
  const d = T[o.lang];
  const box = (inner: string, kind = '') => `<div class="flash${kind ? ` ${kind}` : ''}" id="gratis">${inner}</div>`;
  if (f.eligible) return box(o.lang === 'pt' ? T.pt.eligible(await freeLimits(db), o.where ?? 'painel') : T.en.eligible(await freeLimits(db)), 'ok');
  switch (f.reason) {
    case 'unverified': return box(`${d.unverified(user.email, await lastVerificationAt(db, user.id))}
<form method="post" action="/confirmar-email/reenviar" style="margin-top:8px"><input type="hidden" name="voltar" value="${esc(o.back)}"><button class="ghost" style="padding:6px 14px;min-height:0">${d.resend}</button></form>`);
    case 'used': return box(d.used(f.usedAt));
    case 'cap_day': case 'cap_month': return box(d.cap);
    default: return '';
  }
}
