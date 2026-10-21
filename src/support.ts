import type { Db } from './db.ts';
import { esc, rateLimit } from './lib.ts';
import { t, type Lang } from './i18n.ts';

/** Suporte interno (in-mail): pedidos ao administrador dentro do portal. Nenhum email é enviado por aqui. */
export const SUPPORT_MAX_BODY = 5000;
export const SUPPORT_MAX_SUBJECT = 140;
/** Mensagens por hora: por utilizador ou convidado, e por IP (vários utilizadores atrás do mesmo router). */
export const SUPPORT_RATE = { perSender: 10, perIp: 30, windowMs: 3600_000 };

export type SupportStatus = 'open' | 'answered' | 'closed';
export type SupportAuthor = 'user' | 'guest' | 'admin' | 'assistant';
export type SupportOrigin = 'portal' | 'guest' | 'assistant';

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

/** Limite de envio: o remetente (utilizador ou convidado) e o IP têm de estar dentro do limite. */
export const supportAllowed = (sender: string, ip: string) =>
  rateLimit(`support:${sender}`, SUPPORT_RATE.perSender, SUPPORT_RATE.windowMs) && rateLimit(`support-ip:${ip}`, SUPPORT_RATE.perIp, SUPPORT_RATE.windowMs);

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

/** Acrescenta uma mensagem: a do administrador marca o pedido como respondido e por ler pelo utilizador; as outras reabrem-no para o administrador. */
export async function addMessage(db: Db, threadId: string, author: SupportAuthor, body: string, authorUserId: string | null = null) {
  const fromAdmin = author === 'admin';
  await db.tx(async tx => {
    await tx.query(`INSERT INTO support_messages(thread_id, author, author_user_id, body) VALUES ($1,$2,$3,$4)`, [threadId, author, authorUserId, body]);
    await tx.query(`UPDATE support_threads SET status=$2, unread_admin=$3, unread_user=$4, closed_at=NULL, updated_at=now() WHERE id=$1`,
      [threadId, fromAdmin ? 'answered' : 'open', !fromAdmin, fromAdmin]);
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
