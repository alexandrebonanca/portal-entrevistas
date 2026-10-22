import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc, rateLimitAll, rateRoom, sha256, newToken, sign } from './lib.ts';
import { t, type Lang } from './i18n.ts';
import { queueEmail, emailShell } from './mail.ts';

/**
 * Suporte interno (in-mail): pedidos ao administrador dentro do portal. Utilizadores e convidados não recebem emails por
 * aqui; os visitantes sem conta (formulário de contacto) recebem só o aviso com o link privado para a conversa.
 */
export const SUPPORT_MAX_BODY = 5000;
export const SUPPORT_MAX_SUBJECT = 140;
/** Mensagens por hora: por utilizador ou convidado, e por IP (vários utilizadores atrás do mesmo router). */
export const SUPPORT_RATE = { perSender: 10, perIp: 30, windowMs: 3600_000 };

export type SupportStatus = 'open' | 'answered' | 'closed';
export type SupportAuthor = 'user' | 'guest' | 'admin' | 'assistant' | 'visitor';
export type SupportOrigin = 'portal' | 'guest' | 'assistant' | 'visitor';

export const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Texto de uma mensagem: quebras de linha uniformes e sem caracteres de controlo; recusa vazio ou longo demais. */
export function cleanBody(raw: unknown): { ok: true; text: string } | { ok: false; error: 'empty' | 'long' } {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (!text) return { ok: false, error: 'empty' };
  if (text.length > SUPPORT_MAX_BODY) return { ok: false, error: 'long' };
  return { ok: true, text };
}

/** Assunto numa linha (cortado por caracteres, não por metades de emoji); sem assunto, o início da mensagem. */
export function cleanSubject(raw: unknown, body: string): string {
  const one = (s: string) => s.replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = (s: string, n: number) => { const c = [...s]; return c.length > n ? c.slice(0, n - 1).join('').trimEnd() + '…' : s; };
  return cut(one(String(raw ?? '')), SUPPORT_MAX_SUBJECT) || cut(one(body.split('\n')[0]), 80) || '—';
}

/** Limite de envio: o remetente (utilizador ou convidado) e o IP têm de estar dentro do limite; um envio recusado não gasta nenhum dos dois. */
export const supportAllowed = (sender: string, ip: string) =>
  rateLimitAll([[`support:${sender}`, SUPPORT_RATE.perSender, SUPPORT_RATE.windowMs], [`support-ip:${ip}`, SUPPORT_RATE.perIp, SUPPORT_RATE.windowMs]]);

export interface OpenThread {
  userId?: string | null; interviewId?: string | null; entityId?: string | null;
  subject: string; body: string; origin: SupportOrigin; author: 'user' | 'guest'; authorUserId?: string | null; lang: string;
  /** Resposta do assistente virtual, guardada como segunda mensagem do pedido (origem «assistant»). */
  assistantBody?: string;
}

/** Abre um pedido com a primeira mensagem; fica por ler para o administrador. */
export async function openThread(db: Db, o: OpenThread): Promise<string> {
  return db.tx(async tx => {
    const th = await tx.one(`INSERT INTO support_threads(user_id, interview_id, entity_id, subject, origin, lang) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [o.userId ?? null, o.interviewId ?? null, o.entityId ?? null, o.subject, o.origin, o.lang]);
    await tx.query(`INSERT INTO support_messages(thread_id, author, author_user_id, body) VALUES ($1,$2,$3,$4)`, [th.id, o.author, o.authorUserId ?? null, o.body]);
    if (o.assistantBody) await tx.query(`INSERT INTO support_messages(thread_id, author, body, created_at) VALUES ($1,'assistant',$2, now() + interval '1 millisecond')`, [th.id, o.assistantBody]);
    return th.id as string;
  });
}

/**
 * Acrescenta uma mensagem: a do administrador marca o pedido como respondido e por ler pelo utilizador; as outras reabrem-no
 * para o administrador. Devolve o id da mensagem (chave do aviso por email ao visitante).
 */
export async function addMessage(db: Db, threadId: string, author: SupportAuthor, body: string, authorUserId: string | null = null): Promise<string> {
  const fromAdmin = author === 'admin';
  return db.tx(async tx => {
    const m = await tx.one(`INSERT INTO support_messages(thread_id, author, author_user_id, body) VALUES ($1,$2,$3,$4) RETURNING id`, [threadId, author, authorUserId, body]);
    await tx.query(`UPDATE support_threads SET status=$2, unread_admin=$3, unread_user=$4, closed_at=NULL, updated_at=now() WHERE id=$1`,
      [threadId, fromAdmin ? 'answered' : 'open', !fromAdmin, fromAdmin]);
    return m.id as string;
  });
}

/** Fechar ou reabrir. Reabrir volta a «aberto» (fica na lista de trabalho do administrador). */
export async function setThreadStatus(db: Db, threadId: string, close: boolean) {
  await db.query(close ? `UPDATE support_threads SET status='closed', closed_at=now(), updated_at=now() WHERE id=$1`
    : `UPDATE support_threads SET status='open', closed_at=NULL, updated_at=now() WHERE id=$1`, [threadId]);
}

export const threadMessages = (db: Db, threadId: string) =>
  db.query(`SELECT m.*, u.name AS author_name FROM support_messages m LEFT JOIN users u ON u.id=m.author_user_id WHERE m.thread_id=$1 ORDER BY m.created_at, m.id`, [threadId]);

/** Estilos das conversas (corpo das mensagens com as quebras de linha preservadas). */
export const SUPPORT_CSS = `.msg{border-left:3px solid var(--line);padding:4px 0 4px 14px;margin:14px 0}.msg.admin{border-color:var(--accent)}.msg.assistant{border-color:var(--ok)}
.msg .who{margin:0 0 4px}.msgbody{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.threads{list-style:none;padding:0;margin:0}.threads li{padding:12px 0;border-bottom:1px solid var(--line)}.threads li:last-child{border-bottom:0}
.filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}.filters a{padding:6px 12px;border:1px solid var(--line);border-radius:99px;text-decoration:none;color:var(--ink);font:.9rem system-ui}.filters a[aria-current]{background:var(--ink);color:var(--bg)}`;

/** Ligação com o número de por ler (o número é lido pelos leitores de ecrã como texto, não como «badge»). */
const countLink = (href: string, label: string, n: number, sr: string) =>
  `<a href="${href}">${esc(label)}${n > 0 ? ` <span class="badge" aria-hidden="true">${n}</span><span class="vh"> (${esc(sr)})</span>` : ''}</a>`;

/** Navegação de quem tem sessão: «Ajuda» com as respostas por ler; o administrador vê «Suporte» com os pedidos por ler. */
export function helpNav(u: { role?: string; support_unread?: number; support_inbox?: number } | undefined, lang: 'pt' | 'en' = 'pt') {
  if (!u) return '';
  if (u.role === 'admin') {
    const n = Number(u.support_inbox) || 0;
    return countLink('/admin/suporte', 'Suporte', n, `${n} ${n === 1 ? 'pedido por ler' : 'pedidos por ler'}`);
  }
  const n = Number(u.support_unread) || 0;
  return countLink('/ajuda', lang === 'en' ? 'Help' : 'Ajuda', n, lang === 'en' ? `${n} unread ${n === 1 ? 'reply' : 'replies'}` : `${n} ${n === 1 ? 'resposta por ler' : 'respostas por ler'}`);
}

/** Navegação das páginas do convidado (na língua dele), só com sessão de convidado. */
export function guestHelpNav(g: { supportUnread?: number } | undefined, lang: Lang) {
  if (!g) return '';
  const d = t(lang), n = Number(g.supportUnread) || 0;
  return countLink('/entrevista/ajuda', d.helpNav, n, d.supportUnreadSr(n));
}

// ================= visitantes sem conta: formulário público de contacto =================
/**
 * Pedidos novos pelo formulário: por email (por hora e por dia, porque cada pedido manda um email a esse endereço) e por
 * IP; acima destes, o teto global (config.limits.contactPerHour e contactPerDay). As respostas pelo link privado contam
 * no limite geral do suporte (SUPPORT_RATE), por pedido.
 */
export const CONTACT_RATE = { perEmailHour: 3, perEmailDay: 10, perIpHour: 10 };
/** Tempo mínimo entre abrir o formulário e enviá-lo (um robô envia logo) e máximo (um formulário velho volta a ser mostrado). */
export const CONTACT_MIN_MS = 3000;
export const CONTACT_MAX_MS = 24 * 3600_000;
export const CONTACT_MAX_NAME = 100;
export const CONTACT_MAX_REF = 200;
export const CONTACT_TOPICS = ['sales', 'interview', 'episode', 'privacy', 'other'] as const;
export type ContactTopic = typeof CONTACT_TOPICS[number];
/** Temas no formulário (inglês, como a landing) e na caixa do administrador (português). */
export const TOPIC_EN: Record<ContactTopic, string> = {
  sales: 'Sales and plans', interview: 'Help with an interview', episode: 'Correction or withdrawal of a published episode', privacy: 'Privacy request', other: 'Other',
};
export const TOPIC_PT: Record<ContactTopic, string> = {
  sales: 'Vendas e planos', interview: 'Ajuda com uma entrevista', episode: 'Correção ou retirada de um episódio publicado', privacy: 'Pedido de privacidade', other: 'Outro',
};
export const topicOf = (v: unknown): ContactTopic | '' => ((CONTACT_TOPICS as readonly string[]).includes(String(v)) ? (v as ContactTopic) : '');

/** Ligação ao formulário de contacto, com o tema e a referência de um episódio já preenchidos. */
export const contactHref = (topic?: ContactTopic, episode?: string) => {
  const q = new URLSearchParams();
  if (topic) q.set('topic', topic);
  if (episode) q.set('episode', episode);
  const s = q.toString();
  return s ? `/contact?${s}` : '/contact';
};

/** Uma linha de texto (nome, referência do episódio): sem caracteres de controlo nem quebras, espaços simples, cortada por caracteres. */
export const oneLine = (raw: unknown, max: number) => {
  const c = [...String(raw ?? '').replace(/[\u0000-\u001F\u007F\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()];
  return (c.length > max ? c.slice(0, max) : c).join('').trim();
};

/** Carimbo do formulário (hora de abertura, assinada com o APP_SECRET): mede o tempo de preenchimento sem cookies nem sessão. */
export const contactStamp = (now = Date.now()) => `${now}.${sign(`contact-form:${now}`)}`;
/** Quanto tempo passou desde o carimbo (ms); null se não for um carimbo deste servidor. */
export function contactStampAge(raw: unknown, now = Date.now()): number | null {
  const m = /^(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(String(raw ?? ''));
  if (!m) return null;
  const e = Buffer.from(sign(`contact-form:${m[1]}`)), g = Buffer.from(m[2]);
  return e.length === g.length && timingSafeEqual(e, g) ? now - Number(m[1]) : null;
}

/**
 * Limite de pedidos novos pelo formulário: o teto global (hora e dia, todos os visitantes juntos; config.limits), o email
 * (hora e dia) e o IP. O teto global confere-se primeiro e sem gastar: cheio, recusa sem criar contadores novos em memória
 * (um por email e por IP, que uma inundação com endereços e IP forjados multiplicaria). Um envio recusado não gasta
 * nenhum limite. 'global' quando quem recusa é o teto global, 'sender' quando é o do email ou o do IP.
 */
export function contactAllowed(email: string, ip: string): 'ok' | 'sender' | 'global' {
  const hour: [string, number, number] = ['contact-global:hour', config.limits.contactPerHour, 3600_000];
  const day: [string, number, number] = ['contact-global:day', config.limits.contactPerDay, 24 * 3600_000];
  if (!rateRoom(...hour) || !rateRoom(...day)) return 'global';
  return rateLimitAll([
    [`contact:${email.toLowerCase()}`, CONTACT_RATE.perEmailHour, 3600_000],
    [`contact-day:${email.toLowerCase()}`, CONTACT_RATE.perEmailDay, 24 * 3600_000],
    [`contact-ip:${ip}`, CONTACT_RATE.perIpHour, 3600_000],
    hour, day,
  ]) ? 'ok' : 'sender';
}

/**
 * Token do link privado de um visitante: HMAC-SHA256 (APP_SECRET) do pedido e de um valor aleatório de 128 bits, em
 * base64url. Na base ficam só o hash (sha256) do token e esse valor aleatório: sem o segredo do servidor não se abre o
 * link, e o servidor pode voltar a mandá-lo em cada resposta sem o guardar.
 */
export const visitorToken = (threadId: string, nonce: string) => createHmac('sha256', config.secret).update(`support-visitor:${threadId}:${nonce}`).digest('base64url');
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Pedido de um visitante pelo token do link (os hashes comparados em tempo constante); undefined se não existir. */
export async function visitorThread(db: Db, token: unknown) {
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return undefined;
  const h = sha256(token);
  const th = await db.one(`SELECT * FROM support_threads WHERE visitor_token_hash=$1 AND origin='visitor'`, [h]);
  if (!th) return undefined;
  const a = Buffer.from(String(th.visitor_token_hash), 'hex'), b = Buffer.from(h, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? th : undefined;
}

type VisitorKeys = { id: string; visitor_email: string; visitor_token_hash: string; visitor_token_nonce: string };

/**
 * Link privado de um pedido de visitante (para os emails). Se o APP_SECRET mudou, o token antigo já não se deriva: gera-se
 * outro valor aleatório e o link antigo deixa de valer.
 */
export async function visitorLink(db: Db, th: VisitorKeys) {
  let token = visitorToken(th.id, th.visitor_token_nonce);
  if (sha256(token) !== th.visitor_token_hash) {
    const nonce = newToken(16);
    token = visitorToken(th.id, nonce);
    await db.query('UPDATE support_threads SET visitor_token_hash=$2, visitor_token_nonce=$3 WHERE id=$1', [th.id, sha256(token), nonce]);
  }
  return `${config.baseUrl}/contact/t/${token}`;
}

export interface VisitorRequest { name: string; email: string; topic: ContactTopic; episodeRef: string | null; body: string }

/** Abre o pedido de um visitante (por ler na caixa do administrador) e põe na fila o email com o link privado. */
export async function openVisitorThread(db: Db, o: VisitorRequest): Promise<{ id: string; token: string }> {
  const id = randomUUID(), nonce = newToken(16), token = visitorToken(id, nonce);
  await db.tx(async tx => {
    await tx.query(`INSERT INTO support_threads(id, subject, origin, lang, visitor_name, visitor_email, visitor_token_hash, visitor_token_nonce, topic, episode_ref) VALUES ($1,$2,'visitor','en',$3,$4,$5,$6,$7,$8)`,
      [id, cleanSubject('', o.body), o.name, o.email, sha256(token), nonce, o.topic, o.episodeRef]);
    await tx.query(`INSERT INTO support_messages(thread_id, author, body) VALUES ($1,'visitor',$2)`, [id, o.body]);
    await visitorEmail(tx, { id, visitor_email: o.email, visitor_token_hash: sha256(token), visitor_token_nonce: nonce }, 'received');
  });
  return { id, token };
}

/** Chaves (dedupe_key) dos emails de um pedido de visitante: a confirmação e o aviso de cada resposta. */
export const visitorEmailKeys = (threadId: string) => ({ received: `contact:${threadId}`, replyPrefix: `contact-reply:${threadId}:` });

/**
 * Emails ao visitante (remetente noreply, pela fila): a confirmação do pedido e o aviso de cada resposta, sempre com o link
 * privado. Nunca levam texto escrito pelo visitante (nome, mensagem, referência) nem o texto da resposta: o formulário não
 * serve para mandar mensagens a terceiros, e o conteúdo fica só no portal.
 */
export async function visitorEmail(db: Db, th: VisitorKeys, kind: 'received' | 'reply', messageId?: string) {
  const url = await visitorLink(db, th), keys = visitorEmailKeys(th.id);
  const privacy = 'This link is private: anyone who has it can read the conversation and reply. Do not forward this email.';
  const small = (s: string) => `<p style="font-size:14px;color:#6b655c">${esc(s)}</p>`;
  if (kind === 'received') {
    const lead = `Thank you for writing to ${config.brand}. The team replies on a private page of the portal, and we will email you when there is a reply.`;
    const ignore = `If you did not write to ${config.brand}, you can ignore this email.`;
    await queueEmail(db, {
      key: keys.received, to: th.visitor_email, subject: `We received your message — ${config.brand}`,
      html: emailShell('We received your message', `<p>${esc(lead)}</p><p>Use this link to read the conversation or add information at any time.</p>`,
        { label: 'Open the conversation', url }, { lang: 'en', after: small(`${privacy} ${ignore}`) }),
      text: ['We received your message', lead, `Open the conversation: ${url}`, privacy, ignore].join('\n\n'),
    });
    return;
  }
  const lead = `There is a new reply to your message to ${config.brand}. For your privacy, the reply is not copied into this email: open the conversation to read it and reply.`;
  await queueEmail(db, {
    key: `${keys.replyPrefix}${messageId}`, to: th.visitor_email, subject: `You have a reply — ${config.brand}`,
    html: emailShell('You have a reply', `<p>${esc(lead)}</p>`, { label: 'Read the reply', url }, { lang: 'en', after: small(privacy) }),
    text: ['You have a reply', lead, `Read the reply: ${url}`, privacy].join('\n\n'),
  });
}

/** Apaga o pedido de um visitante, as mensagens e os emails dele (o link deixa de funcionar); false se não for de um visitante. */
export async function deleteVisitorThread(db: Db, threadId: string) {
  const k = visitorEmailKeys(threadId);
  return db.tx(async tx => {
    const gone = await tx.one(`DELETE FROM support_threads WHERE id=$1 AND origin='visitor' RETURNING id`, [threadId]);
    if (gone) await tx.query(`DELETE FROM emails WHERE dedupe_key=$1 OR starts_with(dedupe_key, $2)`, [k.received, k.replyPrefix]);
    return !!gone;
  });
}
