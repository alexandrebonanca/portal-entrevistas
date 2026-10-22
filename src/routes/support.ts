import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { esc, isEmail } from '../lib.ts';
import { page, flash, pill, STATUS_LABEL } from '../views.ts';
import { requireUser, audit } from '../app.ts';
import { t, normLang, type Lang } from '../i18n.ts';
import { entityOfInterview } from '../settings.ts';
import { nav as interviewerNav } from './interviewer.ts';
import { adminNav } from './admin.ts';
import {
  SUPPORT_CSS, SUPPORT_MAX_BODY, cleanBody, cleanSubject, supportAllowed, openThread, addMessage, setThreadStatus, threadMessages, isUuid,
  guestHelpNav, CONTACT_TOPICS, CONTACT_MIN_MS, CONTACT_MAX_MS, CONTACT_MAX_NAME, CONTACT_MAX_REF, TOPIC_EN, TOPIC_PT, topicOf, oneLine, contactStamp,
  contactStampAge, contactAllowed, openVisitorThread, visitorThread, visitorEmail, deleteVisitorThread, type ContactTopic,
} from '../support.ts';
import { cleanQuestion, assistantAllowed, answerQuestion, assistantSig, assistantSigOk, loadAnswer, assistantTranscript, assistantAiFor, faqLang, withAskerVars, userAskerVars, guestAskerVars, ASSISTANT_MAX_QUESTION, type Audience } from '../assistant.ts';
import { config } from '../config.ts';
import { assistantSection, assistantResult, asStateFrom, ASSISTANT_CSS, type AsCtx, type AsState, type Escalation } from './assistant.ts';

type Dict = ReturnType<typeof t>;
const HTML = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };
const STATUS_KIND: Record<string, '' | 'ok' | 'warn'> = { open: 'warn', answered: 'ok', closed: '' };
const ROLE_LABEL: Record<string, string> = { interviewer: 'Entrevistador', entity_admin: 'Gestor de entidade', admin: 'Administrador' };
const ORIGIN_LABEL: Record<string, string> = { portal: 'Portal (utilizador)', guest: 'Páginas do convidado', assistant: 'Assistente virtual', visitor: 'Formulário de contacto (visitante)' };
const LANG_LABEL: Record<string, string> = { 'pt-PT': 'Português', en: 'Inglês' };

const when = (d: unknown, lang: string) => (d ? new Date(d as string).toLocaleString(lang === 'en' ? 'en-GB' : 'pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const statusPill = (s: string, d: Dict) => pill((d.supportStatus as Record<string, string>)[s] ?? s, STATUS_KIND[s] ?? '');
/** Mensagens de aviso por código (nunca texto vindo do URL). */
const okMsg = (d: Dict, c: unknown) => ({ sent: d.supportSent, reply: d.supportReplySent, closed: d.supportClosedOk, reopened: d.supportReopenedOk, deleted: d.supportDeletedOk } as Record<string, string>)[String(c)];
/** Ligação ao formulário de contacto dentro de um texto (convidado sem convite ativo). */
const contactLink = (label: string) => `<a href="/contact">${esc(label)}</a>`;
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
${o.noForm ?? (x ? `<p>${esc(x.note)}</p>${supportForm(`${x.action}#suporte`, o.d, o.form ?? { subject: x.subject, message: x.message }, x.hidden)}` : `<p>${esc(o.intro)}</p>${supportForm(`${o.base}#suporte`, o.d, o.form)}`)}</section>
<section id="pedidos" aria-labelledby="h-pedidos"><h2 id="h-pedidos">${esc(o.d.supportMine)}</h2>${threadList(o.rows, o.base, o.d, o.lang)}</section>`;
};

/**
 * Pedido visto por quem o fez: mensagens, resposta, fechar/reabrir (só leitura para o convidado cujo convite deixou de valer;
 * `readOnlyHtml` é o aviso já em HTML, com a ligação ao formulário de contacto).
 */
const threadBody = (th: any, msgs: any[], base: string, d: Dict, lang: string, o: { ok?: string; e?: string; message?: string; readOnlyHtml?: string }) => {
  const you = (m: any) => (m.author === 'admin' ? d.supportTeam : m.author === 'assistant' ? d.supportAssistant : d.supportYou);
  return `<p class="sans"><a href="${base}">← ${esc(d.supportBack)}</a></p>
<h1 style="font-size:1.7rem">${esc(th.subject)}</h1><p>${statusPill(th.status, d)}</p>${flash(o.ok)}${flash(o.e, 'bad')}
${conversation(msgs, you, lang)}
${o.readOnlyHtml ? `<div class="card"><p style="margin:0">${o.readOnlyHtml}</p></div>` : th.status === 'closed'
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

  /** O assistente responde com os valores de quem pergunta (limites do plano dele e a vendedora da conta Stripe dele). */
  const asUser = async <T>(req: FastifyRequest, fn: () => Promise<T>): Promise<T> => withAskerVars(await userAskerVars(db, req.user!), fn);
  const userHelp = async (req: FastifyRequest, reply: FastifyReply, o: { e?: string; form?: { subject?: string; message?: string }; as?: AsState } = {}, code = 200) => asUser(req, async () => {
    const u = req.user!, q = req.query as any;
    const admin = u.role === 'admin';
    const as = await assistantSection(db, await userAsAi(req), o.as ?? asStateFrom(q));
    return userPage(req, reply, PT.helpTitle, helpBody({
      d: PT, lang: 'pt-PT', intro: USER_INTRO, assistant: as.html, base: '/ajuda', rows: admin ? [] : await myThreads(u.id),
      ok: okMsg(PT, q.ok), e: o.e ?? errMsg(PT, q.e), form: o.form, escalate: as.escalate,
      noForm: admin ? '<p>Os pedidos dos utilizadores e dos convidados chegam à caixa de entrada do administrador: <a href="/admin/suporte">Suporte</a>. A base do assistente edita-se em <a href="/admin/assistente">Assistente</a>.</p>' : undefined,
    }), code);
  });

  app.get('/ajuda', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return userHelp(req, reply);
  });

  app.post('/ajuda/assistente', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const c = await userAsAi(req);
    return asUser(req, () => ask(req, reply, c, (st, code) => userHelp(req, reply, { as: st }, code)));
  });

  app.post('/ajuda/assistente/:id/ajudou', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    return asUser(req, () => feedback(req, reply, userAs(req)));
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
    const transcript = await asUser(req, async () => assistantTranscript(x.a, faqLang(x.a.log.lang)));
    const id = await openThread(db, { userId: u.id, entityId: u.entity_id, subject: cleanSubject(b.subject, body.text), body: body.text, origin: 'assistant', author: 'user', authorUserId: u.id,
      lang: x.a.log.lang === 'en' ? 'en' : 'pt-PT', assistantBody: transcript });
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
  type GuestC = { iv: any; lang: Lang; d: Dict; g: { supportUnread?: number }; readOnly: boolean };
  /**
   * Convidado com sessão ativa (req.guest) ou só de leitura (req.guestHelp: convite cancelado, recusado ou substituído,
   * até ao prazo da sessão): este vê os seus pedidos e as respostas, mas não escreve (`write` leva-o à página de ajuda).
   */
  const guestCtx = async (req: FastifyRequest, reply: FastifyReply, write = false): Promise<GuestC | null> => {
    const g = req.guest ?? req.guestHelp;
    if (!g) { reply.redirect('/'); return null; }
    const readOnly = !req.guest;
    if (readOnly && write) { reply.redirect('/entrevista/ajuda', 303); return null; }
    const iv = await db.one('SELECT id, title, interaction_lang, collection_status FROM interviews WHERE id=$1', [g.interviewId]);
    if (!iv) { reply.redirect('/'); return null; }
    const lang = normLang(iv.interaction_lang);
    return { iv, lang, d: t(lang), g, readOnly };
  };
  const guestPage = (req: FastifyRequest, reply: FastifyReply, lang: Lang, title: string, body: string, code = 200) =>
    reply.code(code).headers(HTML).send(page({ lang, title, body: `<div class="narrow" style="padding:28px 20px 0">${body}</div>`, noindex: true, nav: guestHelpNav(req.guest ?? req.guestHelp, lang), styles: HELP_CSS }));
  // Os convidados ficam sempre na pesquisa local: a pergunta nunca segue para a IA (não há aviso nem autorização para isso).
  const guestAs = (c: { iv: any; lang: Lang }): AsCtx => ({ audience: 'guest', lang: c.lang, base: '/entrevista/ajuda', asker: `guest:${c.iv.id}`, canEscalate: true, ai: false });
  const guestThreadOf = async (req: FastifyRequest, interviewId: string) => {
    const id = (req.params as any).id;
    return isUuid(id) ? db.one('SELECT * FROM support_threads WHERE id=$1 AND interview_id=$2', [id, interviewId]) : undefined;
  };

  /** O assistente do convidado responde com os limites fixados no convite da entrevista dele. */
  const asGuest = async <T>(c: { iv: any }, fn: () => Promise<T>): Promise<T> => withAskerVars(await guestAskerVars(db, c.iv.id), fn);
  const guestHelp = async (req: FastifyRequest, reply: FastifyReply, c: GuestC, o: { e?: string; form?: { subject?: string; message?: string }; as?: AsState } = {}, code = 200) => asGuest(c, async () => {
    const q = req.query as any;
    const rows = await db.query('SELECT * FROM support_threads WHERE interview_id=$1 ORDER BY updated_at DESC LIMIT 100', [c.iv.id]);
    if (c.readOnly) return guestPage(req, reply, c.lang, c.d.helpTitle, helpBody({
      d: c.d, lang: c.lang, intro: '', assistant: '', base: '/entrevista/ajuda', rows, noForm: `<p>${c.d.supportReadOnly(contactLink)}</p>`,
    }), code);
    const as = await assistantSection(db, guestAs(c), o.as ?? asStateFrom(q));
    return guestPage(req, reply, c.lang, c.d.helpTitle, helpBody({
      d: c.d, lang: c.lang, intro: c.d.supportIntro, assistant: as.html, base: '/entrevista/ajuda', rows,
      ok: okMsg(c.d, q.ok), e: o.e ?? errMsg(c.d, q.e), form: o.form, escalate: as.escalate,
      // Depois de submeter, a entrevista continua no comprovativo (com a pré-visualização do episódio, quando houver).
      top: `<p class="sans"><a href="${c.iv.collection_status === 'submitted' ? '/entrevista/obrigado' : '/entrevista'}">← ${esc(c.d.supportBackInterview)}</a></p>`,
    }), code);
  });

  app.get('/entrevista/ajuda', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    return guestHelp(req, reply, c);
  });

  app.post('/entrevista/ajuda/assistente', async (req, reply) => {
    const c = await guestCtx(req, reply, true); if (!c) return;
    return asGuest(c, () => ask(req, reply, guestAs(c), (st, code) => guestHelp(req, reply, c, { as: st }, code)));
  });

  app.post('/entrevista/ajuda/assistente/:id/ajudou', async (req, reply) => {
    const c = await guestCtx(req, reply, true); if (!c) return;
    return asGuest(c, () => feedback(req, reply, guestAs(c)));
  });

  app.post('/entrevista/ajuda/assistente/:id/suporte', async (req, reply) => {
    const c = await guestCtx(req, reply, true); if (!c) return;
    const b = (req.body ?? {}) as any;
    const x = await escalation(req, guestAs(c));
    if (!x) return guestHelp(req, reply, c, { as: { err: c.d.asExpired } }, 404);
    if (x.a.log.escalated) return reply.redirect('/entrevista/ajuda#pedidos'); // já enviado: não gasta o limite
    const form = { subject: String(b.subject ?? '').slice(0, 300), message: String(b.message ?? '').slice(0, SUPPORT_MAX_BODY * 2) };
    const body = cleanBody(b.message);
    if (!body.ok) return guestHelp(req, reply, c, { e: errMsg(c.d, body.error), form, as: x.st }, 422);
    if (!supportAllowed(`guest:${c.iv.id}`, req.ip)) return guestHelp(req, reply, c, { e: c.d.supportRate, form, as: x.st }, 429);
    if (!(await claimEscalation(x.a.log.id))) return reply.redirect('/entrevista/ajuda#pedidos');
    const transcript = await asGuest(c, async () => assistantTranscript(x.a, faqLang(x.a.log.lang)));
    const id = await openThread(db, { interviewId: c.iv.id, entityId: (await entityOfInterview(db, c.iv.id)) ?? null, subject: cleanSubject(b.subject, body.text), body: body.text,
      origin: 'assistant', author: 'guest', lang: c.lang, assistantBody: transcript });
    await audit(db, 'guest', 'support.thread_opened', c.iv.id, { threadId: id, via: 'assistant' });
    return reply.redirect(`/entrevista/ajuda/${id}?ok=sent`);
  });

  app.post('/entrevista/ajuda', async (req, reply) => {
    const c = await guestCtx(req, reply, true); if (!c) return;
    const b = (req.body ?? {}) as any;
    const form = { subject: String(b.subject ?? '').slice(0, 300), message: String(b.message ?? '').slice(0, SUPPORT_MAX_BODY * 2) };
    const body = cleanBody(b.message);
    if (!body.ok) return guestHelp(req, reply, c, { e: errMsg(c.d, body.error), form }, 422);
    if (!supportAllowed(`guest:${c.iv.id}`, req.ip)) return guestHelp(req, reply, c, { e: c.d.supportRate, form }, 429);
    const id = await openThread(db, { interviewId: c.iv.id, entityId: (await entityOfInterview(db, c.iv.id)) ?? null, subject: cleanSubject(b.subject, body.text), body: body.text, origin: 'guest', author: 'guest', lang: c.lang });
    await audit(db, 'guest', 'support.thread_opened', c.iv.id, { threadId: id });
    return reply.redirect(`/entrevista/ajuda/${id}?ok=sent`);
  });

  const guestThread = async (req: FastifyRequest, reply: FastifyReply, c: GuestC, th: any, o: { e?: string; message?: string } = {}, code = 200) => {
    const q = req.query as any;
    if (th.unread_user) {
      await db.query('UPDATE support_threads SET unread_user=false WHERE id=$1', [th.id]);
      c.g.supportUnread = Math.max(0, (c.g.supportUnread ?? 1) - 1);
    }
    return guestPage(req, reply, c.lang, th.subject, threadBody(th, await threadMessages(db, th.id), '/entrevista/ajuda', c.d, c.lang,
      { ok: okMsg(c.d, q.ok), e: o.e ?? errMsg(c.d, q.e), message: o.message, readOnlyHtml: c.readOnly ? c.d.supportReadOnly(contactLink) : undefined }), code);
  };

  app.get('/entrevista/ajuda/:id', async (req, reply) => {
    const c = await guestCtx(req, reply); if (!c) return;
    const th = await guestThreadOf(req, c.iv.id);
    if (!th) return guestPage(req, reply, c.lang, c.d.helpTitle, `<h1>${esc(c.d.supportNotFound)}</h1><p><a href="/entrevista/ajuda">${esc(c.d.supportBack)}</a></p>`, 404);
    return guestThread(req, reply, c, th);
  });

  app.post('/entrevista/ajuda/:id/responder', async (req, reply) => {
    const c = await guestCtx(req, reply, true); if (!c) return;
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
      const c = await guestCtx(req, reply, true); if (!c) return;
      const th = await guestThreadOf(req, c.iv.id);
      if (!th) return reply.code(404).send('Not found');
      await setThreadStatus(db, th.id, close);
      await audit(db, 'guest', close ? 'support.closed' : 'support.reopened', c.iv.id, { threadId: th.id });
      return reply.redirect(`/entrevista/ajuda/${th.id}?ok=${close ? 'closed' : 'reopened'}`);
    });
  }

  // ================= visitantes sem conta: formulário público de contacto e link privado =================
  // Página em inglês, como a landing. O pedido chega à caixa do administrador; o visitante segue a conversa num link
  // privado que recebe por email. A proteção contra pedidos entre origens é a de todos os POST (gancho CSRF de app.ts).
  const EN = t('en');
  const CONTACT_CSS = `${SUPPORT_CSS}.hp{position:absolute!important;left:-10000px;top:auto;width:1px;height:1px;overflow:hidden}`;
  const publicNav = '<a href="/">Home</a><a href="/podcasts">Gallery</a><a href="/entrar">Sign in</a>';
  const publicPage = (reply: FastifyReply, title: string, body: string, code = 200, noindex = false) =>
    reply.code(code).headers(HTML).send(page({ lang: 'en', title, desc: noindex ? undefined : `Write to the ${config.brand} team.`, noindex, nav: publicNav, styles: CONTACT_CSS, body: `<div class="narrow" style="padding-top:40px">${body}</div>` }));
  type ContactForm = { name?: string; email?: string; topic?: string; episode?: string; message?: string };

  /**
   * Formulário de contacto; `v` traz o que já foi escrito (depois de um erro), sem a caixa de aceitação. Depois de um erro
   * mantém-se o carimbo de quando foi aberto (quem corrige um campo não espera de novo o tempo mínimo).
   */
  const contactForm = (v: ContactForm, stamp = contactStamp()) => `<form method="post" action="/contact" class="card">
<input type="hidden" name="ts" value="${esc(stamp)}">
<div class="hp" aria-hidden="true"><label for="c-w">Website (leave empty)</label><input id="c-w" name="website" type="text" tabindex="-1" autocomplete="off"></div>
<label for="c-n" style="margin-top:0">Your name</label><input id="c-n" name="name" type="text" required maxlength="${CONTACT_MAX_NAME}" autocomplete="name" value="${esc(v.name ?? '')}">
<label for="c-e">Your email</label><input id="c-e" name="email" type="email" required maxlength="254" autocomplete="email" value="${esc(v.email ?? '')}" aria-describedby="c-e-h">
<p class="hint" id="c-e-h" style="margin:4px 0 0">Only to send you the private link to the conversation and to tell you when there is a reply.</p>
<label for="c-t">Topic</label><select id="c-t" name="topic">${CONTACT_TOPICS.map(k => `<option value="${k}" ${(v.topic || 'other') === k ? 'selected' : ''}>${esc(TOPIC_EN[k])}</option>`).join('')}</select>
<label for="c-ep">Episode (optional)</label><input id="c-ep" name="episode" type="text" maxlength="${CONTACT_MAX_REF}" value="${esc(v.episode ?? '')}" aria-describedby="c-ep-h">
<p class="hint" id="c-ep-h" style="margin:4px 0 0">The address or the title of the episode, if your message is about a published episode.</p>
<label for="c-m">Message</label><textarea id="c-m" name="message" required maxlength="${SUPPORT_MAX_BODY}" rows="7">${esc(v.message ?? '')}</textarea>
<p class="hint">${esc(EN.supportMaxHint(SUPPORT_MAX_BODY))}</p>
<label class="check"><input type="checkbox" name="accept" value="1" required> <span>I agree that ${esc(config.brand)} uses these details only to answer this request, as described in the <a href="/privacy">privacy notice</a>.</span></label>
<p><button class="accent">Send message</button></p></form>`;

  /** Quem já tem sessão tem um caminho mais direto (com o contexto da conta ou da entrevista): diz-se, sem esconder o formulário. */
  const signedInNote = (req: FastifyRequest) => req.user
    ? `<div class="flash">${req.user.role === 'admin' ? 'You are signed in as an administrator: requests arrive in <a href="/admin/suporte">Suporte</a>.' : 'You are signed in: for questions about your account or your interviews, <a href="/ajuda">Help</a> answers inside the portal, with your account details.'}</div>`
    : req.guest ? '<div class="flash">You are answering an interview: for questions about it, use <a href="/entrevista/ajuda">Help</a>, which reaches the team with the details of your interview.</div>' : '';

  const contactPage = (req: FastifyRequest, reply: FastifyReply, v: ContactForm, e?: string, code = 200, stamp?: string) => publicPage(reply, 'Contact', `<h1>Contact us</h1>
<p>Write to the ${esc(config.brand)} team about plans, an interview, a correction or the withdrawal of a published episode, or a privacy request. We reply on a private page and email you the link to it; we never copy your message into an email. <span class="hint" lang="pt-PT">Pode escrever em português.</span></p>
${signedInNote(req)}${flash(e, 'bad')}${contactForm(v, stamp)}`, code);

  app.get('/contact', async (req, reply) => {
    const q = req.query as any;
    if (q.ok === 'sent') return publicPage(reply, 'Message sent', `<h1>Message sent</h1>
<div class="flash ok" role="status">Thank you. Your message has reached the ${esc(config.brand)} team.</div>
<p>We have emailed you a private link where you can follow the conversation and reply. If it does not arrive within a few minutes, check your spam folder.</p>
<p><a href="/">Back to the home page</a></p>`, 200, true);
    // Tema e episódio vindos de uma ligação (por exemplo, da página de um episódio): o slug passa a endereço completo.
    const ep = oneLine(q.episode, CONTACT_MAX_REF);
    return contactPage(req, reply, { topic: topicOf(q.topic) || undefined, episode: /^[a-z0-9-]{1,100}$/.test(ep) ? `${config.baseUrl}/e/${ep}` : ep });
  });

  app.post('/contact', async (req, reply) => {
    const b = (req.body ?? {}) as any;
    const v: ContactForm = { name: oneLine(b.name, CONTACT_MAX_NAME * 2), email: String(b.email ?? '').trim().slice(0, 300), topic: topicOf(b.topic) || 'other', episode: oneLine(b.episode, CONTACT_MAX_REF), message: String(b.message ?? '').slice(0, SUPPORT_MAX_BODY * 2) };
    // Campo-armadilha preenchido: um robô. Responde como se tivesse corrido bem, sem gravar nem enviar nada.
    if (String(b.website ?? '').trim()) return reply.redirect('/contact?ok=sent', 303);
    const age = contactStampAge(b.ts);
    const valid = age !== null && age <= CONTACT_MAX_MS && age >= -60_000;
    const again = (msg: string, code = 422) => contactPage(req, reply, v, msg, code, valid ? String(b.ts) : undefined);
    if (!valid) return again('This form has expired. Please check your message and send it again.');
    if (age < CONTACT_MIN_MS) return again('That was very quick. Please check your message and send it again.');
    const name = oneLine(b.name, CONTACT_MAX_NAME), email = String(b.email ?? '').trim().toLowerCase(), body = cleanBody(b.message);
    if (!name) return again('Please write your name.');
    if (!isEmail(email)) return again('Please write a valid email address, so that we can send you the link to the conversation.');
    if (!body.ok) return again(body.error === 'empty' ? EN.supportEmpty : EN.supportTooLong(SUPPORT_MAX_BODY));
    if (b.accept !== '1') return again('Please tick the box to agree that we use these details to answer your request.');
    if (!contactAllowed(email, req.ip)) return again('Too many messages have been sent from this email address or this network recently. Please try again later.', 429);
    const topic = (topicOf(b.topic) || 'other') as ContactTopic;
    const { id } = await openVisitorThread(db, { name, email, topic, episodeRef: v.episode || null, body: body.text });
    // Na auditoria, só o pedido e o tema (nem o nome, nem o email, nem o texto).
    await audit(db, 'visitor', 'support.thread_opened', null, { threadId: id, via: 'contact', topic });
    return reply.redirect('/contact?ok=sent', 303);
  });

  // Link privado: quem o tem lê a conversa e responde. A página não mostra o nome nem o email do visitante.
  const visitorPage = async (req: FastifyRequest, reply: FastifyReply, th: any, token: string, o: { e?: string; message?: string } = {}, code = 200) => {
    const q = req.query as any;
    if (th.unread_user) await db.query('UPDATE support_threads SET unread_user=false WHERE id=$1', [th.id]);
    const label = (m: any) => (m.author === 'admin' ? EN.supportTeam : EN.supportYou);
    const base = `/contact/t/${token}`;
    return publicPage(reply, th.subject, `<p class="hint sans">Private conversation with the ${esc(config.brand)} team · ${esc(TOPIC_EN[th.topic as ContactTopic] ?? '')}</p>
<h1 style="font-size:1.7rem">${esc(th.subject)}</h1><p>${statusPill(th.status, EN)}</p>${flash(q.ok === 'reply' ? EN.supportReplySent : undefined)}${flash(o.e ?? (q.e === 'closed' ? 'This request is closed.' : undefined), 'bad')}
<p class="hint">This page is private: anyone with this link can read the conversation and reply. Do not share it.</p>
${conversation(await threadMessages(db, th.id), label, 'en')}
${th.status === 'closed'
    ? `<div class="card"><p style="margin:0">This request is closed. If you need more help, send a new message through the <a href="/contact">contact form</a>.</p></div>`
    : `<form method="post" action="${base}/responder" class="card"><label for="sp-r" style="margin-top:0">${esc(EN.supportReply)}</label><textarea id="sp-r" name="message" required maxlength="${SUPPORT_MAX_BODY}" rows="5">${esc(o.message ?? '')}</textarea>
<p class="hint">${esc(EN.supportMaxHint(SUPPORT_MAX_BODY))}</p><p><button class="accent">${esc(EN.supportReplyBtn)}</button></p></form>`}`, code, true);
  };
  const notFound = (reply: FastifyReply) => publicPage(reply, 'Link not valid', `<h1>This link is not valid</h1>
<p>The conversation may have been deleted, or the link was copied incompletely. You can send a new message through the <a href="/contact">contact form</a>.</p>`, 404, true);

  app.get('/contact/t/:token', async (req, reply) => {
    const token = (req.params as any).token, th = await visitorThread(db, token);
    if (!th) return notFound(reply);
    return visitorPage(req, reply, th, token);
  });

  app.post('/contact/t/:token/responder', async (req, reply) => {
    const token = (req.params as any).token, th = await visitorThread(db, token);
    if (!th) return notFound(reply);
    // Pedido fechado: só leitura (o administrador pode reabri-lo; o visitante escreve um pedido novo).
    if (th.status === 'closed') return reply.redirect(`/contact/t/${token}?e=closed`, 303);
    const raw = (req.body as any)?.message, body = cleanBody(raw);
    if (!body.ok) return visitorPage(req, reply, th, token, { e: body.error === 'empty' ? EN.supportEmpty : EN.supportTooLong(SUPPORT_MAX_BODY), message: String(raw ?? '').slice(0, SUPPORT_MAX_BODY * 2) }, 422);
    if (!supportAllowed(`visitor:${th.id}`, req.ip)) return visitorPage(req, reply, th, token, { e: EN.supportRate, message: body.text }, 429);
    await addMessage(db, th.id, 'visitor', body.text);
    await audit(db, 'visitor', 'support.message', null, { threadId: th.id });
    return reply.redirect(`/contact/t/${token}?ok=reply`, 303);
  });

  // ================= administrador: caixa de entrada =================
  const guard = (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) { reply.redirect('/entrar'); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send('Acesso reservado a administradores'); return false; }
    return true;
  };
  const adminPage = (req: FastifyRequest, reply: FastifyReply, title: string, body: string, code = 200) =>
    reply.code(code).headers(HTML).send(page({ title, body: `<div class="wrap" style="padding-top:32px">${body}</div>`, nav: adminNav(req.user), noindex: true, styles: SUPPORT_CSS }));
  const FILTERS: [string, string][] = [['open', 'Abertos'], ['unread', 'Por ler'], ['answered', 'Respondidos'], ['closed', 'Fechados'], ['visitor', 'Visitantes'], ['all', 'Todos']];

  app.get('/admin/suporte', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const f = FILTERS.some(([k]) => k === q.estado) ? String(q.estado) : 'open';
    const n = await db.one(`SELECT count(*) FILTER (WHERE status='open')::int AS open, count(*) FILTER (WHERE unread_admin)::int AS unread,
      count(*) FILTER (WHERE status='answered')::int AS answered, count(*) FILTER (WHERE status='closed')::int AS closed,
      count(*) FILTER (WHERE origin='visitor')::int AS visitor, count(*)::int AS "all" FROM support_threads`);
    const rows = await db.query(`SELECT t.*, u.name AS user_name, u.email AS user_email, i.title AS interview_title, i.guest_name, en.name AS entity_name
      FROM support_threads t LEFT JOIN users u ON u.id=t.user_id LEFT JOIN interviews i ON i.id=t.interview_id LEFT JOIN entities en ON en.id=t.entity_id
      WHERE CASE $1 WHEN 'all' THEN true WHEN 'unread' THEN t.unread_admin WHEN 'visitor' THEN t.origin='visitor' ELSE t.status=$1 END
      ORDER BY t.unread_admin DESC, t.updated_at DESC LIMIT 200`, [f]);
    // O que vem dos visitantes (nome, email, assunto) é sempre escapado: chega de um formulário público.
    const who = (r: any) => (r.user_id ? `${esc(r.user_name)}<br><span class="hint">${esc(r.user_email)}</span>`
      : r.origin === 'visitor' ? `Visitante: ${esc(r.visitor_name)}<br><span class="hint">${esc(r.visitor_email)}</span>`
        : `Convidado: ${esc(r.guest_name || '—')}<br><span class="hint">«${esc(r.interview_title)}»</span>`);
    const topic = (r: any) => (r.topic ? `<br><span class="hint">${esc(TOPIC_PT[r.topic as ContactTopic] ?? r.topic)}</span>` : '');
    return adminPage(req, reply, 'Suporte', `<h1>Suporte</h1>${flash(okMsg(PT, q.ok))}
<p class="hint sans">Pedidos feitos dentro do portal pelos utilizadores e pelos convidados, e pelos visitantes sem conta no formulário de contacto (<a href="/contact">/contact</a>). As respostas aparecem na página de ajuda de quem pediu, sem email; o visitante lê-as numa página privada e recebe só um email curto com o link (sem o texto da resposta).</p>
<nav class="filters" aria-label="Filtrar por estado">${FILTERS.map(([k, l]) => `<a href="/admin/suporte?estado=${k}" ${k === f ? 'aria-current="page"' : ''}>${esc(l)} (${Number(n?.[k] ?? 0)})</a>`).join('')}</nav>
${rows.length ? `<div class="card" style="overflow-x:auto"><table><thead><tr><th>Assunto</th><th>De</th><th>Entidade</th><th>Origem</th><th>Estado</th><th>Atualizado</th></tr></thead><tbody>
${rows.map((r: any) => `<tr><td>${r.unread_admin ? '<strong>' : ''}<a href="/admin/suporte/${r.id}">${esc(r.subject)}</a>${r.unread_admin ? `</strong> ${pill('por ler', 'warn')}` : ''}${topic(r)}</td><td>${who(r)}</td><td>${esc(r.entity_name ?? '—')}</td><td>${esc(ORIGIN_LABEL[r.origin] ?? r.origin)}</td><td>${statusPill(r.status, PT)}</td><td>${esc(when(r.updated_at, 'pt-PT'))}</td></tr>`).join('')}
</tbody></table></div>` : '<div class="card"><p class="hint" style="margin:0">Sem pedidos neste filtro.</p></div>'}`);
  });

  /** Episódio indicado por um visitante (o endereço /e/… ou só o slug), para o administrador o abrir; undefined se não houver. */
  const episodeOfRef = async (ref: unknown) => {
    const r = String(ref ?? '');
    const slug = /\/e\/([A-Za-z0-9-]{1,100})/.exec(r)?.[1] ?? (/^[a-z0-9-]{1,100}$/.test(r) ? r : '');
    if (!slug) return undefined;
    return db.one(`SELECT e.slug, e.title, e.status, e.interview_id, i.title AS interview_title,
        (e.status='published' AND e.visibility IN ('unlisted','public') AND e.withdrawn_at IS NULL) AS live
      FROM episodes e JOIN interviews i ON i.id=e.interview_id WHERE e.slug=$1`, [slug]);
  };
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
    // Contexto atual de quem pediu: o utilizador (perfil e entidade), a entrevista do convidado ou o visitante do formulário.
    let ctx = '', who = 'Utilizador', warn = '';
    const visitor = th.origin === 'visitor';
    if (visitor) {
      who = th.visitor_name;
      const ep = await episodeOfRef(th.episode_ref);
      ctx = `<strong>Visitante:</strong> ${esc(th.visitor_name)} &lt;${esc(th.visitor_email)}&gt;<br>
<strong>Tema:</strong> ${esc(TOPIC_PT[th.topic as ContactTopic] ?? th.topic ?? '—')}${th.episode_ref ? ` · <strong>Episódio indicado:</strong> «${esc(th.episode_ref)}»${ep ? ` → <a href="/entrevistas/${ep.interview_id}">${esc(ep.interview_title)}</a> (episódio «${esc(ep.title)}», ${esc(STATUS_LABEL[ep.status] ?? ep.status)}${ep.live ? `, <a href="/e/${esc(ep.slug)}">página pública</a>` : ''})` : ' (não corresponde a nenhum episódio)'}` : ''}`;
      warn = `<div class="flash">Pedido de um visitante sem conta, pelo formulário de contacto. O email não foi verificado (qualquer pessoa pode escrever o email de outra): num pedido sobre dados pessoais ou sobre um episódio, confirme a identidade antes de agir. As respostas ficam na página privada do visitante; cada resposta manda-lhe um email curto com o link, sem o texto.</div>`;
    } else if (th.user_id) {
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
      // Sem convite válido, o convidado só lê as respostas no navegador onde já o tinha aberto (até ao prazo) e não escreve.
      const inv = iv ? await db.one(`SELECT bool_or(revoked_at IS NULL AND declined_at IS NULL AND expires_at>now()) AS valid, bool_or(declined_at IS NOT NULL) AS declined FROM invitations WHERE interview_id=$1`, [iv.id]) : null;
      if (iv && (iv.collection_status === 'cancelled' || !inv?.valid)) {
        const why = iv.collection_status === 'cancelled' ? 'entrevista cancelada' : inv?.declined ? 'convite recusado' : 'link expirado ou revogado';
        warn = `<div class="flash bad">O convidado já não tem um convite válido (${why}): só consegue ler as respostas no navegador onde abriu o convite, até ao fim do prazo desse convite, e não pode escrever. Se a resposta for importante (por exemplo, um pedido sobre os seus dados), contacte-o também por email${iv.guest_email ? `: ${esc(iv.guest_email)}` : ''}.</div>`;
      }
    }
    const label = (m: any) => (m.author === 'admin' ? `Suporte${m.author_name ? ` (${m.author_name})` : ''}` : m.author === 'assistant' ? 'Assistente virtual' : m.author === 'guest' ? `Convidado (${who})` : m.author === 'visitor' ? `Visitante (${who})` : who);
    const closed = th.status === 'closed';
    return adminPage(req, reply, th.subject, `<p class="sans"><a href="/admin/suporte">← Suporte</a></p>
<h1 style="font-size:1.7rem">${esc(th.subject)}</h1>${flash(okMsg(PT, q.ok))}${flash(errMsg(PT, q.e), 'bad')}
<div class="card sans"><p style="margin:0">${statusPill(th.status, PT)} · <strong>Origem:</strong> ${esc(ORIGIN_LABEL[th.origin] ?? th.origin)} · <strong>Língua:</strong> ${visitor ? 'formulário em inglês' : esc(LANG_LABEL[th.lang] ?? th.lang)} · <strong>Entidade:</strong> ${esc(th.entity_name ?? '—')} · aberto em ${esc(when(th.created_at, 'pt-PT'))}</p>
<p style="margin:8px 0 0">${ctx}</p></div>${warn}
<div class="narrow" style="margin:0;padding:0">${conversation(await threadMessages(db, th.id), label, 'pt-PT')}</div>
<form method="post" action="/admin/suporte/${th.id}/responder" class="card"><label for="sp-r" style="margin-top:0">Responder${visitor ? ' (na língua em que o visitante escreveu)' : th.lang === 'en' ? ' (em inglês, a língua de quem pediu)' : ''}</label><textarea id="sp-r" name="message" required maxlength="${SUPPORT_MAX_BODY}" rows="6"></textarea>
<p class="hint">${visitor ? 'A resposta fica visível na página privada do visitante; é-lhe enviado um email curto («You have a reply») com o link, sem o texto da resposta.' : 'A resposta fica visível na página de ajuda de quem pediu, com o aviso de resposta por ler. Não é enviado email.'}${closed ? ' Responder reabre o pedido como «Respondido».' : ''} Não escreva palavras-passe nem chaves nas respostas: ficam guardadas no pedido, à vista de quem pediu e de todos os administradores.</p><p><button class="accent">Enviar resposta</button></p></form>
<div class="row"><form method="post" action="/admin/suporte/${th.id}/${closed ? 'reabrir' : 'fechar'}"><button class="ghost">${closed ? 'Reabrir pedido' : 'Fechar pedido'}</button></form>
${visitor ? `<form method="post" action="/admin/suporte/${th.id}/apagar" onsubmit="return confirm('Apagar este pedido, as mensagens e os emails enviados ao visitante? O link privado deixa de funcionar.')"><button class="danger">Apagar pedido</button></form>` : ''}</div>
${visitor ? '<p class="hint sans">Apagar remove o pedido, as mensagens e os emails do pedido (por exemplo, a pedido do visitante); o link privado deixa de funcionar. Os pedidos dos utilizadores e dos convidados apagam-se com a conta ou com a entrevista.</p>' : ''}`);
  });

  app.post('/admin/suporte/:id/responder', async (req, reply) => {
    if (!guard(req, reply)) return;
    const th = await adminThread(req);
    if (!th) return reply.code(404).send('Não encontrado');
    const body = cleanBody((req.body as any)?.message);
    if (!body.ok) return reply.redirect(`/admin/suporte/${th.id}?e=${body.error}`);
    const msgId = await addMessage(db, th.id, 'admin', body.text, req.user!.id);
    // Só o visitante (sem conta nem sessão) é avisado por email, com o link privado; utilizadores e convidados veem-no no portal.
    if (th.origin === 'visitor') await visitorEmail(db, th, 'reply', msgId);
    await audit(db, req.user!.email, 'support.admin_reply', th.interview_id ?? null, { threadId: th.id });
    return reply.redirect(`/admin/suporte/${th.id}?ok=reply`);
  });

  // Apagar um pedido de visitante (por exemplo, a pedido dele): mensagens e emails também; o link deixa de funcionar.
  app.post('/admin/suporte/:id/apagar', async (req, reply) => {
    if (!guard(req, reply)) return;
    const th = await adminThread(req);
    if (!th) return reply.code(404).send('Não encontrado');
    if (th.origin !== 'visitor' || !(await deleteVisitorThread(db, th.id))) return reply.code(400).send('Só os pedidos de visitantes se apagam aqui');
    await audit(db, req.user!.email, 'support.admin_deleted', null, { threadId: th.id, origin: 'visitor' });
    return reply.redirect('/admin/suporte?ok=deleted');
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
