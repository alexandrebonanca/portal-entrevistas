import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { esc } from '../lib.ts';
import { page, flash, pill, STATUS_LABEL } from '../views.ts';
import { requireUser, audit } from '../app.ts';
import { t, normLang, type Lang } from '../i18n.ts';
import { entityOfInterview } from '../settings.ts';
import { nav as interviewerNav } from './interviewer.ts';
import { adminNav } from './admin.ts';
import {
  SUPPORT_CSS, SUPPORT_MAX_BODY, cleanBody, cleanSubject, supportAllowed, openThread, addMessage, setThreadStatus, threadMessages, isUuid,
  guestHelpNav,
} from '../support.ts';
import { cleanQuestion, assistantAllowed, answerQuestion, assistantSig, assistantSigOk, loadAnswer, assistantTranscript, assistantAiFor, faqLang, ASSISTANT_MAX_QUESTION, type Audience } from '../assistant.ts';
import { config } from '../config.ts';
import { assistantSection, assistantResult, asStateFrom, ASSISTANT_CSS, type AsCtx, type AsState, type Escalation } from './assistant.ts';

type Dict = ReturnType<typeof t>;
const HTML = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const STATUS_KIND: Record<string, '' | 'ok' | 'warn'> = { open: 'warn', answered: 'ok', closed: '' };
const ROLE_LABEL: Record<string, string> = { interviewer: 'Entrevistador', entity_admin: 'Gestor de entidade', admin: 'Administrador' };
const ORIGIN_LABEL: Record<string, string> = { portal: 'Portal (utilizador)', guest: 'Páginas do convidado', assistant: 'Assistente virtual' };
const LANG_LABEL: Record<string, string> = { 'pt-PT': 'Português', en: 'Inglês' };

const when = (d: unknown, lang: string) => (d ? new Date(d as string).toLocaleString(lang === 'en' ? 'en-GB' : 'pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const statusPill = (s: string, d: Dict) => pill((d.supportStatus as Record<string, string>)[s] ?? s, STATUS_KIND[s] ?? '');
/** Mensagens de aviso por código (nunca texto vindo do URL). */
const okMsg = (d: Dict, c: unknown) => ({ sent: d.supportSent, reply: d.supportReplySent, closed: d.supportClosedOk, reopened: d.supportReopenedOk } as Record<string, string>)[String(c)];
const errMsg = (d: Dict, c: unknown) => ({ empty: d.supportEmpty, long: d.supportTooLong(SUPPORT_MAX_BODY), rate: d.supportRate, closed: d.supportClosedNote } as Record<string, string>)[String(c)];

const HELP_CSS = SUPPORT_CSS + ASSISTANT_CSS;
const wantsJson = (req: FastifyRequest) => String(req.headers.accept ?? '').includes('application/json');

/** Formulário «Falar com o suporte»; o assistente virtual reutiliza-o para abrir um pedido já preenchido (com campos escondidos). */
export function supportForm(action: string, d: Dict, v: { subject?: string; message?: string } = {}, hidden: Record<string, string> = {}) {
  return `<form method="post" action="${esc(action)}">${Object.entries(hidden).map(([k, x]) => `<input type="hidden" name="${esc(k)}" value="${esc(x)}">`).join('')}<label for="sp-s">${esc(d.supportSubject)}</label><input id="sp-s" name="subject" type="text" maxlength="140" value="${esc(v.subject ?? '')}">
<label for="sp-m">${esc(d.supportMessage)}</label><textarea id="sp-m" name="message" required maxlength="${SUPPORT_MAX_BODY}" rows="6">${esc(v.message ?? '')}</textarea>
<p class="hint">${esc(d.supportMaxHint(SUPPORT_MAX_BODY))}</p><p><button class="accent">${esc(d.supportSend)}</button></p></form>`;
}

/** Conversa: cada mensagem com autor e data; o corpo é escapado e mantém as quebras de linha (white-space:pre-wrap). */
const conversation = (msgs: any[], label: (m: any) => string, lang: string) =>
  msgs.map(m => `<div class="msg ${esc(m.author)}"><p class="who hint sans"><strong>${esc(label(m))}</strong> · ${esc(when(m.created_at, lang))}</p><p class="msgbody">${esc(m.body)}</p></div>`).join('');

/** Lista dos pedidos de quem os fez (utilizador ou convidado). */
const threadList = (rows: any[], base: string, d: Dict, lang: string) => rows.length
  ? `<ul class="threads sans">${rows.map(r => `<li><a href="${base}/${r.id}">${esc(r.subject)}</a> ${statusPill(r.status, d)}${r.unread_user ? ' ' + pill(d.supportNew, 'warn') : ''}<br><span class="hint">${esc(when(r.updated_at, lang))}</span></li>`).join('')}</ul>`
  : `<p class="hint">${esc(d.supportNone)}</p>`;

/**
 * Página de ajuda de quem pede (entrevistador/gestor ou convidado): assistente, formulário e pedidos. Vindo do assistente
 * («Não» ou «Falar com o suporte»), o formulário já vem preenchido com a pergunta e segue para o pedido com a resposta dele.
 */
const helpBody = (o: { d: Dict; lang: string; intro: string; assistant: string; base: string; rows: any[]; ok?: string; e?: string; form?: { subject?: string; message?: string }; top?: string; noForm?: string; escalate?: Escalation }) => {
  const unread = o.rows.filter(r => r.unread_user).length;
  const x = o.escalate;
  return `${o.top ?? ''}<h1>${esc(o.d.helpTitle)}</h1>${flash(o.ok)}${unread ? `<div class="flash"><a href="#pedidos">${esc(o.d.supportUnreadSr(unread))}</a></div>` : ''}
${o.assistant}
<section id="suporte" class="card" aria-labelledby="h-suporte"><h2 id="h-suporte" style="margin-top:0">${esc(o.d.supportTitle)}</h2>${flash(o.e, 'bad')}
${o.noForm ?? (x ? `<p>${esc(x.note)}</p>${supportForm(x.action, o.d, o.form ?? { subject: x.subject, message: x.message }, x.hidden)}` : `<p>${esc(o.intro)}</p>${supportForm(o.base, o.d, o.form)}`)}</section>
<section id="pedidos" aria-labelledby="h-pedidos"><h2 id="h-pedidos">${esc(o.d.supportMine)}</h2>${threadList(o.rows, o.base, o.d, o.lang)}</section>`;
};

/** Pedido visto por quem o fez: mensagens, resposta, fechar/reabrir. */
const threadBody = (th: any, msgs: any[], base: string, d: Dict, lang: string, o: { ok?: string; e?: string; message?: string }) => {
  const you = (m: any) => (m.author === 'admin' ? d.supportTeam : m.author === 'assistant' ? d.supportAssistant : d.supportYou);
  return `<p class="sans"><a href="${base}">← ${esc(d.supportBack)}</a></p>
<h1 style="font-size:1.7rem">${esc(th.subject)}</h1><p>${statusPill(th.status, d)}</p>${flash(o.ok)}${flash(o.e, 'bad')}
${conversation(msgs, you, lang)}
${th.status === 'closed'
    ? `<div class="card"><p style="margin-top:0">${esc(d.supportClosedNote)}</p><form method="post" action="${base}/${th.id}/reabrir"><button class="ghost">${esc(d.supportReopen)}</button></form></div>`
    : `<form method="post" action="${base}/${th.id}/responder" class="card"><label for="sp-r" style="margin-top:0">${esc(d.supportReply)}</label><textarea id="sp-r" name="message" required maxlength="${SUPPORT_MAX_BODY}" rows="5">${esc(o.message ?? '')}</textarea>
<p class="hint">${esc(d.supportMaxHint(SUPPORT_MAX_BODY))}</p><p><button class="accent">${esc(d.supportReplyBtn)}</button></p></form>
<form method="post" action="${base}/${th.id}/fechar"><button class="ghost">${esc(d.supportClose)}</button></form>`}`;
};

export async function supportRoutes(app: FastifyInstance) {
  const db = app.db;

  // ================= assistente virtual (comum a utilizadores e convidados) =================
  /** Pergunta ao assistente: valida, aplica o limite, responde e regista; depois mostra a resposta (sem JavaScript, por redirecionamento). */
  const ask = async (req: FastifyRequest, reply: FastifyReply, c: AsCtx, render: (st: AsState, code: number) => unknown) => {
    const d = t(c.lang), raw = String((req.body as any)?.q ?? '');
    const q = cleanQuestion(raw);
    const fail = async (err: string, code: number) => (wantsJson(req) ? reply.code(code).send({ error: err, html: (await assistantResult(db, c, { err })).html }) : render({ q: raw.slice(0, ASSISTANT_MAX_QUESTION * 2), err }, code));
    if (!q.ok) return fail(q.error === 'empty' ? d.asEmpty : d.asTooLong(ASSISTANT_MAX_QUESTION), 422);
    if (!assistantAllowed(c.asker, req.ip)) return fail(d.asRate, 429);
    const id = await answerQuestion(db, { question: q.text, pageLang: faqLang(c.lang), audience: c.audience, ai: c.ai === true });
    const s = assistantSig(id, c.asker), url = `${c.base}?r=${id}&s=${encodeURIComponent(s)}`;
    if (wantsJson(req)) return reply.headers({ 'Cache-Control': 'no-store' }).send({ html: (await assistantResult(db, c, { r: id, s })).html, url });
    return reply.redirect(`${url}#as-resposta`, 303);
  };

  /** «Isto ajudou?»: só quem perguntou (assinatura); «Não» leva ao pedido ao suporte já preenchido. */
  const feedback = async (req: FastifyRequest, reply: FastifyReply, c: AsCtx) => {
    const id = (req.params as any).id, b = (req.body ?? {}) as any;
    if (!assistantSigOk(id, c.asker, b.s)) return reply.code(404).send(wantsJson(req) ? { error: 'not found' } : 'Not found');
    const url = `${c.base}?r=${id}&s=${encodeURIComponent(b.s)}`;
    if (b.v !== 'sim' && b.v !== 'nao') return reply.redirect(`${url}#as-resposta`, 303);
    await db.query('UPDATE assistant_questions SET helped=$2 WHERE id=$1', [id, b.v === 'sim']);
    if (b.v === 'nao' && c.canEscalate) return wantsJson(req) ? reply.send({ redirect: `${url}&apoio=1#suporte` }) : reply.redirect(`${url}&apoio=1#suporte`, 303);
    if (wantsJson(req)) return reply.headers({ 'Cache-Control': 'no-store' }).send({ html: (await assistantResult(db, c, { r: id, s: b.s })).html });
    return reply.redirect(`${url}#as-resposta`, 303);
  };

  /** Resposta do assistente que vai para o pedido (o que a pessoa viu); null se já não existir ou a assinatura não for dela. */
  const escalation = async (req: FastifyRequest, c: AsCtx) => {
    const id = (req.params as any).id, s = (req.body as any)?.s;
    if (!assistantSigOk(id, c.asker, s)) return null;
    const a = await loadAnswer(db, id);
    return a ? { a, st: { r: id, s: String(s), apoio: true } as AsState } : null;
  };
  /** Marca a pergunta como enviada ao suporte, uma só vez (um segundo envio do mesmo formulário não abre outro pedido). */
  const claimEscalation = async (logId: string) => !!(await db.one('UPDATE assistant_questions SET escalated=true WHERE id=$1 AND NOT escalated RETURNING id', [logId]));

  // ================= entrevistadores e gestores de entidade =================
  const PT = t('pt-PT');
  const USER_INTRO = 'Escreva a sua dúvida ou o problema que encontrou. A equipa do portal responde nesta página, não por email; a ligação «Ajuda» no topo mostra quando há respostas por ler.';
  const userPage = (req: FastifyRequest, reply: FastifyReply, title: string, body: string, code = 200) =>
    reply.code(code).headers(HTML).send(page({ title, body: `<div class="narrow" style="padding-top:32px">${body}</div>`, nav: interviewerNav(req.user), noindex: true, styles: HELP_CSS }));
  const userAs = (req: FastifyRequest): AsCtx => ({ audience: 'interviewer' as Audience, lang: 'pt-PT', base: '/ajuda', asker: `user:${req.user!.id}`, canEscalate: req.user!.role !== 'admin' });
  /** Com a indicação de a resposta poder ser redigida pela IA (administrador e contas com subscrição ativa). */
  const userAsAi = async (req: FastifyRequest): Promise<AsCtx> => ({ ...userAs(req), ai: await assistantAiFor(db, req.user!) });
  const myThreads = (userId: string) => db.query('SELECT * FROM support_threads WHERE user_id=$1 ORDER BY updated_at DESC LIMIT 100', [userId]);
  const myThread = async (req: FastifyRequest) => {
    const id = (req.params as any).id;
    return isUuid(id) ? db.one('SELECT * FROM support_threads WHERE id=$1 AND user_id=$2', [id, req.user!.id]) : undefined;
  };

  const userHelp = async (req: FastifyRequest, reply: FastifyReply, o: { e?: string; form?: { subject?: string; message?: string }; as?: AsState } = {}, code = 200) => {
    const u = req.user!, q = req.query as any;
    const admin = u.role === 'admin';
    const as = await assistantSection(db, await userAsAi(req), o.as ?? asStateFrom(q));
    return userPage(req, reply, PT.helpTitle, helpBody({
      d: PT, lang: 'pt-PT', intro: USER_INTRO, assistant: as.html, base: '/ajuda', rows: admin ? [] : await myThreads(u.id),
      ok: okMsg(PT, q.ok), e: o.e ?? errMsg(PT, q.e), form: o.form, escalate: as.escalate,
      noForm: admin ? '<p>Os pedidos dos utilizadores e dos convidados chegam à caixa de entrada do administrador: <a href="/admin/suporte">Suporte</a>. A base do assistente edita-se em <a href="/admin/assistente">Assistente</a>.</p>' : undefined,
    }), code);
  };

  app.get('/ajuda', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return userHelp(req, reply);
  });

  app.post('/ajuda/assistente', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return ask(req, reply, await userAsAi(req), (st, code) => userHelp(req, reply, { as: st }, code));
  });

  app.post('/ajuda/assistente/:id/ajudou', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return feedback(req, reply, userAs(req));
  });

  // Pedido ao suporte a partir do assistente: a pergunta (editável) e, a seguir, a resposta que o assistente deu.
  app.post('/ajuda/assistente/:id/suporte', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const u = req.user!, b = (req.body ?? {}) as any;
    if (u.role === 'admin') return reply.redirect('/admin/suporte');
    const x = await escalation(req, userAs(req));
    if (!x) return userHelp(req, reply, { as: { err: PT.asExpired } }, 404);
    const form = { subject: String(b.subject ?? '').slice(0, 300), message: String(b.message ?? '').slice(0, SUPPORT_MAX_BODY * 2) };
    const body = cleanBody(b.message);
    if (x.a.log.escalated) return reply.redirect('/ajuda#pedidos'); // já enviado (por exemplo, clique duplo): não gasta o limite
    if (!body.ok) return userHelp(req, reply, { e: errMsg(PT, body.error), form, as: x.st }, 422);
    if (!supportAllowed(`user:${u.id}`, req.ip)) return userHelp(req, reply, { e: PT.supportRate, form, as: x.st }, 429);
    if (!(await claimEscalation(x.a.log.id))) return reply.redirect('/ajuda#pedidos'); // enviado entretanto por outro pedido
    const id = await openThread(db, { userId: u.id, entityId: u.entity_id, subject: cleanSubject(b.subject, body.text), body: body.text, origin: 'assistant', author: 'user', authorUserId: u.id,
      lang: x.a.log.lang === 'en' ? 'en' : 'pt-PT', assistantBody: assistantTranscript(x.a, faqLang(x.a.log.lang)) });
    await audit(db, u.email, 'support.thread_opened', null, { threadId: id, via: 'assistant' });
    return reply.redirect(`/ajuda/${id}?ok=sent`);
  });

  app.post('/ajuda', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const u = req.user!, b = (req.body ?? {}) as any;
    if (u.role === 'admin') return reply.redirect('/admin/suporte');
    const form = { subject: String(b.subject ?? '').slice(0, 300), message: String(b.message ?? '').slice(0, SUPPORT_MAX_BODY * 2) };
    const body = cleanBody(b.message);
    if (!body.ok) return userHelp(req, reply, { e: errMsg(PT, body.error), form }, 422);
    if (!supportAllowed(`user:${u.id}`, req.ip)) return userHelp(req, reply, { e: PT.supportRate, form }, 429);
    const id = await openThread(db, { userId: u.id, entityId: u.entity_id, subject: cleanSubject(b.subject, body.text), body: body.text, origin: 'portal', author: 'user', authorUserId: u.id, lang: 'pt-PT' });
    await audit(db, u.email, 'support.thread_opened', null, { threadId: id });
    return reply.redirect(`/ajuda/${id}?ok=sent`);
  });

  const userThread = async (req: FastifyRequest, reply: FastifyReply, th: any, o: { e?: string; message?: string } = {}, code = 200) => {
    const q = req.query as any;
    if (th.unread_user) { // lido agora: o contador da navegação desta página já desconta
      await db.query('UPDATE support_threads SET unread_user=false WHERE id=$1', [th.id]);
      req.user!.support_unread = Math.max(0, (req.user!.support_unread ?? 1) - 1);
    }
    return userPage(req, reply, th.subject, threadBody(th, await threadMessages(db, th.id), '/ajuda', PT, 'pt-PT', { ok: okMsg(PT, q.ok), e: o.e ?? errMsg(PT, q.e), message: o.message }), code);
  };

  app.get('/ajuda/:id', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const th = await myThread(req);
    if (!th) return userPage(req, reply, PT.helpTitle, `<h1>${esc(PT.supportNotFound)}</h1><p><a href="/ajuda">${esc(PT.supportBack)}</a></p>`, 404);
    return userThread(req, reply, th);
  });

  app.post('/ajuda/:id/responder', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const th = await myThread(req);
    if (!th) return reply.code(404).send('Não encontrado');
    if (th.status === 'closed') return reply.redirect(`/ajuda/${th.id}?e=closed`);
    const raw = (req.body as any)?.message, body = cleanBody(raw);
    if (!body.ok) return userThread(req, reply, th, { e: errMsg(PT, body.error), message: String(raw ?? '').slice(0, SUPPORT_MAX_BODY * 2) }, 422);
    if (!supportAllowed(`user:${req.user!.id}`, req.ip)) return userThread(req, reply, th, { e: PT.supportRate, message: body.text }, 429);
    await addMessage(db, th.id, 'user', body.text, req.user!.id);
    await audit(db, req.user!.email, 'support.message', null, { threadId: th.id });
    return reply.redirect(`/ajuda/${th.id}?ok=reply`);
  });

  for (const [action, close] of [['fechar', true], ['reabrir', false]] as const) {
    app.post(`/ajuda/:id/${action}`, async (req, reply) => {
      if (!requireUser(req, reply)) return;
      const th = await myThread(req);
      if (!th) return reply.code(404).send('Não encontrado');
      await setThreadStatus(db, th.id, close);
      await audit(db, req.user!.email, close ? 'support.closed' : 'support.reopened', null, { threadId: th.id });
      return reply.redirect(`/ajuda/${th.id}?ok=${close ? 'closed' : 'reopened'}`);
    });
  }

  // ================= convidados (na língua da entrevista) =================
  const guestCtx = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.guest) { reply.redirect('/'); return null; }
    const iv = await db.one('SELECT id, title, interaction_lang, collection_status FROM interviews WHERE id=$1', [req.guest.interviewId]);
    if (!iv) { reply.redirect('/'); return null; }
    const lang = normLang(iv.interaction_lang);
    return { iv, lang, d: t(lang) };
  };
  const guestPage = (req: FastifyRequest, reply: FastifyReply, lang: Lang, title: string, body: string, code = 200) =>
    reply.code(code).headers(HTML).send(page({ lang, title, body: `<div class="narrow" style="padding:28px 20px 0">${body}</div>`, noindex: true, nav: guestHelpNav(req.guest, lang), styles: HELP_CSS }));
  const guestAs = (c: { iv: any; lang: Lang }): AsCtx => ({ audience: 'guest', lang: c.lang, base: '/entrevista/ajuda', asker: `guest:${c.iv.id}`, canEscalate: true });
  const guestThreadOf = async (req: FastifyRequest, interviewId: string) => {
    const id = (req.params as any).id;
    return isUuid(id) ? db.one('SELECT * FROM support_threads WHERE id=$1 AND interview_id=$2', [id, interviewId]) : undefined;
  };

  const guestHelp = async (req: FastifyRequest, reply: FastifyReply, c: { iv: any; lang: Lang; d: Dict }, o: { e?: string; form?: { subject?: string; message?: string }; as?: AsState } = {}, code = 200) => {
    const q = req.query as any;
    const rows = await db.query('SELECT * FROM support_threads WHERE interview_id=$1 ORDER BY updated_at DESC LIMIT 100', [c.iv.id]);
    const as = await assistantSection(db, guestAs(c), o.as ?? asStateFrom(q));
    return guestPage(req, reply, c.lang, c.d.helpTitle, helpBody({
      d: c.d, lang: c.lang, intro: c.d.supportIntro, assistant: as.html, base: '/entrevista/ajuda', rows,
      ok: okMsg(c.d, q.ok), e: o.e ?? errMsg(c.d, q.e), form: o.form, escalate: as.escalate,
      // Depois de submeter, a entrevista continua no comprovativo (com a pré-visualização do episódio, quando houver).
      top: `<p class="sans"><a href="${c.iv.collection_status === 'submitted' ? '/entrevista/obrigado' : '/entrevista'}">← ${esc(c.d.supportBackInterview)}</a></p>`,
    }), code);
  };

  app.get('/entrevista/ajuda', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    return guestHelp(req, reply, c);
  });

  app.post('/entrevista/ajuda/assistente', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    return ask(req, reply, guestAs(c), (st, code) => guestHelp(req, reply, c, { as: st }, code));
  });

  app.post('/entrevista/ajuda/assistente/:id/ajudou', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    return feedback(req, reply, guestAs(c));
  });

  app.post('/entrevista/ajuda/assistente/:id/suporte', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    const b = (req.body ?? {}) as any;
    const x = await escalation(req, guestAs(c));
    if (!x) return guestHelp(req, reply, c, { as: { err: c.d.asExpired } }, 404);
    if (x.a.log.escalated) return reply.redirect('/entrevista/ajuda#pedidos'); // já enviado: não gasta o limite
    const form = { subject: String(b.subject ?? '').slice(0, 300), message: String(b.message ?? '').slice(0, SUPPORT_MAX_BODY * 2) };
    const body = cleanBody(b.message);
    if (!body.ok) return guestHelp(req, reply, c, { e: errMsg(c.d, body.error), form, as: x.st }, 422);
    if (!supportAllowed(`guest:${c.iv.id}`, req.ip)) return guestHelp(req, reply, c, { e: c.d.supportRate, form, as: x.st }, 429);
    if (!(await claimEscalation(x.a.log.id))) return reply.redirect('/entrevista/ajuda#pedidos');
    const id = await openThread(db, { interviewId: c.iv.id, entityId: (await entityOfInterview(db, c.iv.id)) ?? null, subject: cleanSubject(b.subject, body.text), body: body.text,
      origin: 'assistant', author: 'guest', lang: c.lang, assistantBody: assistantTranscript(x.a, faqLang(x.a.log.lang)) });
    await audit(db, 'guest', 'support.thread_opened', c.iv.id, { threadId: id, via: 'assistant' });
    return reply.redirect(`/entrevista/ajuda/${id}?ok=sent`);
  });

  app.post('/entrevista/ajuda', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    const b = (req.body ?? {}) as any;
    const form = { subject: String(b.subject ?? '').slice(0, 300), message: String(b.message ?? '').slice(0, SUPPORT_MAX_BODY * 2) };
    const body = cleanBody(b.message);
    if (!body.ok) return guestHelp(req, reply, c, { e: errMsg(c.d, body.error), form }, 422);
    if (!supportAllowed(`guest:${c.iv.id}`, req.ip)) return guestHelp(req, reply, c, { e: c.d.supportRate, form }, 429);
    const id = await openThread(db, { interviewId: c.iv.id, entityId: (await entityOfInterview(db, c.iv.id)) ?? null, subject: cleanSubject(b.subject, body.text), body: body.text, origin: 'guest', author: 'guest', lang: c.lang });
    await audit(db, 'guest', 'support.thread_opened', c.iv.id, { threadId: id });
    return reply.redirect(`/entrevista/ajuda/${id}?ok=sent`);
  });

  const guestThread = async (req: FastifyRequest, reply: FastifyReply, c: { iv: any; lang: Lang; d: Dict }, th: any, o: { e?: string; message?: string } = {}, code = 200) => {
    const q = req.query as any;
    if (th.unread_user) {
      await db.query('UPDATE support_threads SET unread_user=false WHERE id=$1', [th.id]);
      req.guest!.supportUnread = Math.max(0, (req.guest!.supportUnread ?? 1) - 1);
    }
    return guestPage(req, reply, c.lang, th.subject, threadBody(th, await threadMessages(db, th.id), '/entrevista/ajuda', c.d, c.lang, { ok: okMsg(c.d, q.ok), e: o.e ?? errMsg(c.d, q.e), message: o.message }), code);
  };

  app.get('/entrevista/ajuda/:id', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    const th = await guestThreadOf(req, c.iv.id);
    if (!th) return guestPage(req, reply, c.lang, c.d.helpTitle, `<h1>${esc(c.d.supportNotFound)}</h1><p><a href="/entrevista/ajuda">${esc(c.d.supportBack)}</a></p>`, 404);
    return guestThread(req, reply, c, th);
  });

  app.post('/entrevista/ajuda/:id/responder', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    const th = await guestThreadOf(req, c.iv.id);
    if (!th) return reply.code(404).send('Not found');
    if (th.status === 'closed') return reply.redirect(`/entrevista/ajuda/${th.id}?e=closed`);
    const raw = (req.body as any)?.message, body = cleanBody(raw);
    if (!body.ok) return guestThread(req, reply, c, th, { e: errMsg(c.d, body.error), message: String(raw ?? '').slice(0, SUPPORT_MAX_BODY * 2) }, 422);
    if (!supportAllowed(`guest:${c.iv.id}`, req.ip)) return guestThread(req, reply, c, th, { e: c.d.supportRate, message: body.text }, 429);
    await addMessage(db, th.id, 'guest', body.text);
    await audit(db, 'guest', 'support.message', c.iv.id, { threadId: th.id });
    return reply.redirect(`/entrevista/ajuda/${th.id}?ok=reply`);
  });

  for (const [action, close] of [['fechar', true], ['reabrir', false]] as const) {
    app.post(`/entrevista/ajuda/:id/${action}`, async (req, reply) => {
      const c = await guestCtx(req, reply); if (!c) return;
      const th = await guestThreadOf(req, c.iv.id);
      if (!th) return reply.code(404).send('Not found');
      await setThreadStatus(db, th.id, close);
      await audit(db, 'guest', close ? 'support.closed' : 'support.reopened', c.iv.id, { threadId: th.id });
      return reply.redirect(`/entrevista/ajuda/${th.id}?ok=${close ? 'closed' : 'reopened'}`);
    });
  }

  // ================= administrador: caixa de entrada =================
  const guard = (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) { reply.redirect('/entrar'); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send('Acesso reservado a administradores'); return false; }
    return true;
  };
  const adminPage = (req: FastifyRequest, reply: FastifyReply, title: string, body: string, code = 200) =>
    reply.code(code).headers(HTML).send(page({ title, body: `<div class="wrap" style="padding-top:32px">${body}</div>`, nav: adminNav(req.user), noindex: true, styles: SUPPORT_CSS }));
  const FILTERS: [string, string][] = [['open', 'Abertos'], ['unread', 'Por ler'], ['answered', 'Respondidos'], ['closed', 'Fechados'], ['all', 'Todos']];

  app.get('/admin/suporte', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const f = FILTERS.some(([k]) => k === q.estado) ? String(q.estado) : 'open';
    const n = await db.one(`SELECT count(*) FILTER (WHERE status='open')::int AS open, count(*) FILTER (WHERE unread_admin)::int AS unread,
      count(*) FILTER (WHERE status='answered')::int AS answered, count(*) FILTER (WHERE status='closed')::int AS closed, count(*)::int AS "all" FROM support_threads`);
    const rows = await db.query(`SELECT t.*, u.name AS user_name, u.email AS user_email, i.title AS interview_title, i.guest_name, en.name AS entity_name
      FROM support_threads t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN interviews i ON i.id=t.interview_id LEFT JOIN entities en ON en.id=t.entity_id
      WHERE CASE $1 WHEN 'all' THEN true WHEN 'unread' THEN t.unread_admin ELSE t.status=$1 END
      ORDER BY t.unread_admin DESC, t.updated_at DESC LIMIT 200`, [f]);
    const who = (r: any) => (r.user_id ? `${esc(r.user_name)}<br><span class="hint">${esc(r.user_email)}</span>` : `Convidado: ${esc(r.guest_name || '—')}<br><span class="hint">«${esc(r.interview_title)}»</span>`);
    return adminPage(req, reply, 'Suporte', `<h1>Suporte</h1>
<p class="hint sans">Pedidos feitos dentro do portal pelos utilizadores e pelos convidados. As respostas aparecem na página de ajuda de quem pediu; nenhum email é enviado.</p>
<nav class="filters" aria-label="Filtrar por estado">${FILTERS.map(([k, l]) => `<a href="/admin/suporte?estado=${k}" ${k === f ? 'aria-current="page"' : ''}>${esc(l)} (${Number(n?.[k] ?? 0)})</a>`).join('')}</nav>
${rows.length ? `<div class="card" style="overflow-x:auto"><table><thead><tr><th>Assunto</th><th>De</th><th>Entidade</th><th>Origem</th><th>Estado</th><th>Atualizado</th></tr></thead><tbody>
${rows.map((r: any) => `<tr><td>${r.unread_admin ? '<strong>' : ''}<a href="/admin/suporte/${r.id}">${esc(r.subject)}</a>${r.unread_admin ? `</strong> ${pill('por ler', 'warn')}` : ''}</td><td>${who(r)}</td><td>${esc(r.entity_name ?? '—')}</td><td>${esc(ORIGIN_LABEL[r.origin] ?? r.origin)}</td><td>${statusPill(r.status, PT)}</td><td>${esc(when(r.updated_at, 'pt-PT'))}</td></tr>`).join('')}
</tbody></table></div>` : '<div class="card"><p class="hint" style="margin:0">Sem pedidos neste filtro.</p></div>'}`);
  });

  const adminThread = async (req: FastifyRequest) => {
    const id = (req.params as any).id;
    return isUuid(id) ? db.one(`SELECT t.*, en.name AS entity_name FROM support_threads t LEFT JOIN entities en ON en.id=t.entity_id WHERE t.id=$1`, [id]) : undefined;
  };

  app.get('/admin/suporte/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const th = await adminThread(req);
    if (!th) return adminPage(req, reply, 'Suporte', '<h1>Pedido não encontrado</h1><p><a href="/admin/suporte">← Suporte</a></p>', 404);
    const q = req.query as any;
    if (th.unread_admin) {
      await db.query('UPDATE support_threads SET unread_admin=false WHERE id=$1', [th.id]);
      req.user!.support_inbox = Math.max(0, (req.user!.support_inbox ?? 1) - 1);
    }
    // Contexto atual de quem pediu: o utilizador (perfil e entidade) ou a entrevista do convidado.
    let ctx = '', who = 'Utilizador';
    if (th.user_id) {
      const u = await db.one('SELECT u.id, u.name, u.email, u.role, u.active, e.name AS entity_name FROM users u LEFT JOIN entities e ON e.id=u.entity_id WHERE u.id=$1', [th.user_id]);
      who = u?.name ?? who;
      ctx = u ? `<strong>Utilizador:</strong> <a href="/admin/utilizadores/${u.id}">${esc(u.name)}</a> · ${esc(u.email)} ${u.active ? '' : pill('conta desativada', 'bad')}<br>
<strong>Perfil:</strong> ${esc(ROLE_LABEL[u.role] ?? u.role)} · <strong>Entidade:</strong> ${esc(u.entity_name ?? '—')}` : '';
    } else {
      const iv = await db.one(`SELECT i.id, i.title, i.guest_name, i.guest_email, i.collection_status, i.production_status, i.publication_status, o.id AS owner_id, o.name AS owner_name, o.email AS owner_email
        FROM interviews i JOIN users o ON o.id=i.owner_id WHERE i.id=$1`, [th.interview_id]);
      who = iv?.guest_name || 'Convidado';
      ctx = iv ? `<strong>Convidado:</strong> ${esc(iv.guest_name || '—')}${iv.guest_email ? ` · ${esc(iv.guest_email)}` : ''}<br>
<strong>Entrevista:</strong> <a href="/entrevistas/${iv.id}">${esc(iv.title)}</a> · <strong>Estado:</strong> ${esc(STATUS_LABEL[iv.collection_status] ?? iv.collection_status)} · ${esc(STATUS_LABEL[iv.production_status] ?? iv.production_status)} · ${esc(STATUS_LABEL[iv.publication_status] ?? iv.publication_status)}<br>
<strong>Entrevistador:</strong> <a href="/admin/utilizadores/${iv.owner_id}">${esc(iv.owner_name)}</a> · ${esc(iv.owner_email)}` : '';
    }
    const label = (m: any) => (m.author === 'admin' ? `Suporte${m.author_name ? ` (${m.author_name})` : ''}` : m.author === 'assistant' ? 'Assistente virtual' : m.author === 'guest' ? `Convidado (${who})` : who);
    const closed = th.status === 'closed';
    return adminPage(req, reply, th.subject, `<p class="sans"><a href="/admin/suporte">← Suporte</a></p>
<h1 style="font-size:1.7rem">${esc(th.subject)}</h1>${flash(okMsg(PT, q.ok))}${flash(errMsg(PT, q.e), 'bad')}
<div class="card sans"><p style="margin:0">${statusPill(th.status, PT)} · <strong>Origem:</strong> ${esc(ORIGIN_LABEL[th.origin] ?? th.origin)} · <strong>Língua:</strong> ${esc(LANG_LABEL[th.lang] ?? th.lang)} · <strong>Entidade:</strong> ${esc(th.entity_name ?? '—')} · aberto em ${esc(when(th.created_at, 'pt-PT'))}</p>
<p style="margin:8px 0 0">${ctx}</p></div>
<div class="narrow" style="margin:0;padding:0">${conversation(await threadMessages(db, th.id), label, 'pt-PT')}</div>
<form method="post" action="/admin/suporte/${th.id}/responder" class="card"><label for="sp-r" style="margin-top:0">Responder${th.lang === 'en' ? ' (em inglês, a língua de quem pediu)' : ''}</label><textarea id="sp-r" name="message" required maxlength="${SUPPORT_MAX_BODY}" rows="6"></textarea>
<p class="hint">A resposta fica visível na página de ajuda de quem pediu, com o aviso de resposta por ler. Não é enviado email.${closed ? ' Responder reabre o pedido como «Respondido».' : ''}</p><p><button class="accent">Enviar resposta</button></p></form>
<form method="post" action="/admin/suporte/${th.id}/${closed ? 'reabrir' : 'fechar'}"><button class="ghost">${closed ? 'Reabrir pedido' : 'Fechar pedido'}</button></form>`);
  });

  app.post('/admin/suporte/:id/responder', async (req, reply) => {
    if (!guard(req, reply)) return;
    const th = await adminThread(req);
    if (!th) return reply.code(404).send('Não encontrado');
    const body = cleanBody((req.body as any)?.message);
    if (!body.ok) return reply.redirect(`/admin/suporte/${th.id}?e=${body.error}`);
    await addMessage(db, th.id, 'admin', body.text, req.user!.id);
    await audit(db, req.user!.email, 'support.admin_reply', th.interview_id ?? null, { threadId: th.id });
    return reply.redirect(`/admin/suporte/${th.id}?ok=reply`);
  });

  for (const [action, close] of [['fechar', true], ['reabrir', false]] as const) {
    app.post(`/admin/suporte/:id/${action}`, async (req, reply) => {
      if (!guard(req, reply)) return;
      const th = await adminThread(req);
      if (!th) return reply.code(404).send('Não encontrado');
      await setThreadStatus(db, th.id, close);
      await audit(db, req.user!.email, close ? 'support.admin_closed' : 'support.admin_reopened', th.interview_id ?? null, { threadId: th.id });
      return reply.redirect(`/admin/suporte/${th.id}?ok=${close ? 'closed' : 'reopened'}`);
    });
  }
}
