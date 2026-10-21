import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db.ts';
import { esc } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit } from '../app.ts';
import { t, type Lang } from '../i18n.ts';
import { adminNav } from './admin.ts';
import { SUPPORT_CSS, isUuid } from '../support.ts';
import {
  activeFaq, loadAnswer, assistantSig, assistantSigOk, fillVars, faqVars, faqLang, purgeAssistantLog, defaultAiEnabled,
  FAQ_LANGS, FAQ_AUDIENCES, FAQ_LIMITS, FAQ_VAR_HELP, ASSISTANT_MAX_QUESTION, ASSISTANT_LOG_DAYS, type Audience, type FaqEntry,
} from '../assistant.ts';

type Dict = ReturnType<typeof t>;

/** Estilos do assistente (as respostas usam .msgbody do suporte: quebras de linha preservadas). */
export const ASSISTANT_CSS = `.as-res{border-top:1px solid var(--line);margin-top:18px;padding-top:6px}.as-res:focus{outline:none}.as-h{font-size:1.15rem;margin:.8em 0 .3em}
.as-fb{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:16px 0 0;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}.as-fb button{padding:8px 20px;min-height:40px}
.as-faq details{border-bottom:1px solid var(--line);padding:10px 0}.as-faq details:last-child{border-bottom:0}.as-faq summary{cursor:pointer;font:600 .98rem/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}
.as-faq .msgbody{margin:8px 0 0}.as-all{margin-top:18px}.as-all>summary{cursor:pointer;color:var(--accent);font:600 .95rem system-ui,-apple-system,'Segoe UI',sans-serif}`;

/** Estado do assistente numa página de ajuda: pergunta e erro (formulário) ou resposta já dada (r = registo, s = assinatura). */
export interface AsState { q?: string; err?: string; r?: string; s?: string; apoio?: boolean }
export const asStateFrom = (q: any): AsState => ({ r: typeof q?.r === 'string' ? q.r : undefined, s: typeof q?.s === 'string' ? q.s : undefined, apoio: q?.apoio === '1' });

/** `ai`: a resposta pode ser redigida pela IA (contas com subscrição e administrador; nunca convidados). */
export interface AsCtx { audience: Audience; lang: Lang; base: string; asker: string; canEscalate: boolean; ai?: boolean }
/** Pedido ao suporte a partir do assistente: formulário já preenchido, com a referência da resposta. */
export interface Escalation { action: string; hidden: Record<string, string>; subject: string; message: string; note: string }

const quote = (s: string, lang: Lang) => (lang === 'en' ? `“${s}”` : `«${s}»`);
const cut = (s: string, n: number) => { const c = [...s.replace(/\s+/g, ' ').trim()]; return c.length > n ? c.slice(0, n - 1).join('').trimEnd() + '…' : c.join(''); };
const faqList = (entries: FaqEntry[]) =>
  `<div class="as-faq">${entries.map(e => `<details><summary>${esc(fillVars(e.question))}</summary><p class="msgbody">${esc(fillVars(e.answer))}</p></details>`).join('')}</div>`;
const resultUrl = (base: string, id: string, sig: string) => `${base}?r=${id}&s=${encodeURIComponent(sig)}`;

/**
 * Resultado de uma pergunta (o que fica dentro de #as-out): a resposta (redigida pelo modelo a partir das entradas, ou a
 * melhor entrada), as relacionadas, «Isto ajudou?» e a ligação para o suporte. Também devolve o pedido já preenchido
 * quando a pessoa disse que não ajudou ou escolheu «Falar com o suporte».
 */
export async function assistantResult(db: Db, c: AsCtx, st: AsState): Promise<{ html: string; escalate?: Escalation }> {
  const d = t(c.lang);
  let html = st.err ? flash(st.err, 'bad') : '';
  if (!st.r) return { html };
  const a = assistantSigOk(st.r, c.asker, st.s) ? await loadAnswer(db, st.r) : null;
  if (!a) return { html: html + flash(d.asExpired, 'bad') };
  const { log, entries } = a, sig = assistantSig(log.id, c.asker), url = resultUrl(c.base, log.id, sig);
  let body = `<p class="hint sans">${esc(d.asYouAsked)}: ${esc(quote(log.question, c.lang))}</p>`;
  if (log.answer) body += `<h3 class="as-h">${esc(d.asAiLabel)}</h3><p class="msgbody">${esc(log.answer)}</p><p class="hint">${esc(d.asAiNote)}</p>${faqList(entries)}`;
  else if (entries.length) body += `<h3 class="as-h">${esc(fillVars(entries[0].question))}</h3><p class="msgbody">${esc(fillVars(entries[0].answer))}</p>${entries.length > 1 ? `<p class="hint sans" style="margin-bottom:0">${esc(d.asRelated)}</p>${faqList(entries.slice(1))}` : ''}`;
  else body += `<p><strong>${esc(d.asNone)}</strong></p><p class="hint">${esc(d.asNoneHint)}</p>`;
  const found = !!(log.answer || entries.length);
  if (found) {
    body += log.helped === true ? `<div class="flash ok" role="status">${esc(d.asThanks)}</div>`
      : log.helped === false ? `<div class="flash" role="status">${esc(d.asSorry)}</div>`
      : `<form method="post" action="${esc(c.base)}/assistente/${log.id}/ajudou" class="as-fb" data-as><input type="hidden" name="s" value="${esc(sig)}"><span>${esc(d.asHelped)}</span><button name="v" value="sim" class="ghost">${esc(d.asYes)}</button><button name="v" value="nao" class="ghost">${esc(d.asNo)}</button></form>`;
  }
  if (c.canEscalate) body += log.escalated ? `<p class="hint">${esc(d.supportSent)}</p>` : `<p class="sans"><a href="${esc(url)}&amp;apoio=1#suporte">${esc(d.asTalk)}</a></p>`;
  html += `<div id="as-resposta" class="as-res" tabindex="-1">${body}</div>`;
  const escalate = c.canEscalate && !log.escalated && (st.apoio || log.helped === false)
    ? { action: `${c.base}/assistente/${log.id}/suporte`, hidden: { s: sig }, subject: cut(log.question, 120), message: log.question, note: d.asEscalateNote } : undefined;
  return { html, escalate };
}

/** Secção do assistente na página de ajuda: pergunta, resultado e todas as perguntas frequentes do público. */
export async function assistantSection(db: Db, c: AsCtx, st: AsState): Promise<{ html: string; escalate?: Escalation }> {
  const d = t(c.lang);
  const faq = await activeFaq(db, faqLang(c.lang), c.audience);
  const res = await assistantResult(db, c, st);
  const html = `<section id="assistente" class="card" aria-labelledby="h-as"><h2 id="h-as" style="margin-top:0">${esc(d.asTitle)}</h2><p>${esc(d.asIntro)}</p>
<form method="post" action="${esc(c.base)}/assistente" data-as><label for="as-q">${esc(d.asLabel)}</label><textarea id="as-q" name="q" rows="2" required maxlength="${ASSISTANT_MAX_QUESTION}" aria-describedby="as-priv">${esc(st.q ?? '')}</textarea>
<p class="hint" id="as-priv">${esc(c.ai && defaultAiEnabled() ? d.asPrivacyAi(ASSISTANT_LOG_DAYS) : d.asPrivacy(ASSISTANT_LOG_DAYS))}</p><p><button class="accent">${esc(d.asAsk)}</button></p></form>
<div id="as-out">${res.html}</div>
${faq.length ? `<details class="as-all"><summary>${esc(d.asAllFaq(faq.length))}</summary><h3 class="vh">${esc(d.asFaq)}</h3>${faqList(faq)}</details>` : ''}
<script src="/static/assistant.js" defer></script></section>`;
  return { html, escalate: res.escalate };
}

// ================= administrador: base de conhecimento e perguntas a melhorar =================

const LANG_LABEL: Record<string, string> = { pt: 'Português', en: 'Inglês' };
const AUD_LABEL: Record<string, string> = { interviewer: 'Entrevistadores', guest: 'Convidados', all: 'Todos' };
const OK: Record<string, string> = { created: 'Entrada criada.', saved: 'Entrada guardada.', on: 'Entrada ativada.', off: 'Entrada desativada: o assistente deixa de a usar.', reviewed: 'Pergunta marcada como tratada.' };
const fmt = (d: unknown) => (d ? new Date(d as string).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—');

export async function assistantAdminRoutes(app: FastifyInstance) {
  const db = app.db;
  const guard = (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.user) { reply.redirect('/entrar'); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send('Acesso reservado a administradores'); return false; }
    return true;
  };
  const view = (req: FastifyRequest, reply: FastifyReply, title: string, body: string, code = 200) =>
    reply.code(code).headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      .send(page({ title, body: `<div class="wrap" style="padding-top:32px">${body}</div>`, nav: adminNav(req.user), noindex: true, styles: SUPPORT_CSS + ASSISTANT_CSS }));
  const sel = (name: string, cur: string, opts: [string, string][], label: string) =>
    `<select id="f-${name}" name="${name}" aria-label="${esc(label)}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;

  app.get('/admin/assistente', async (req, reply) => {
    if (!guard(req, reply)) return;
    await purgeAssistantLog(db, true); // o registo nunca mostra perguntas com mais de 180 dias
    const q = req.query as any;
    const fl = FAQ_LANGS.includes(q.lingua) ? String(q.lingua) : '';
    const fa = FAQ_AUDIENCES.includes(q.publico) ? String(q.publico) : '';
    const all = q.perguntas === 'todas';
    const stats = await db.one(`SELECT count(*)::int AS n, count(*) FILTER (WHERE NOT answered)::int AS unanswered, count(*) FILTER (WHERE helped)::int AS yes,
      count(*) FILTER (WHERE helped = false)::int AS no, count(*) FILTER (WHERE escalated)::int AS esc, count(*) FILTER (WHERE mode='ai')::int AS ai
      FROM assistant_questions WHERE created_at > now() - interval '30 days'`);
    const qs = await db.query(`SELECT * FROM assistant_questions WHERE ${all ? 'true' : 'NOT reviewed AND (NOT answered OR helped = false)'} ORDER BY created_at DESC LIMIT 200`);
    const ids = [...new Set(qs.flatMap((r: any) => r.faq_ids as string[]))];
    const used = new Map<string, any>((ids.length ? await db.query('SELECT id, question FROM assistant_faq WHERE id = ANY($1::uuid[])', [ids]) : []).map((r: any) => [r.id, r]));
    const faq = await db.query(`SELECT * FROM assistant_faq WHERE ($1='' OR lang=$1) AND ($2='' OR audience=$2) ORDER BY active DESC, lang, audience, sort, question`, [fl, fa]);
    const outcome = (r: any) => [!r.answered ? pill('sem resposta', 'bad') : '', r.helped === false ? pill('não ajudou', 'warn') : r.helped ? pill('ajudou', 'ok') : '',
      r.escalated ? pill('enviada ao suporte') : '', r.mode === 'ai' ? pill('resposta redigida pela IA') : '', r.reviewed ? pill('tratada') : ''].filter(Boolean).join(' ');
    const filterLink = (k: string, v: string, label: string, cur: string) => {
      const p = new URLSearchParams();
      for (const [a, b] of Object.entries({ lingua: fl, publico: fa, perguntas: all ? 'todas' : '', [k]: v })) if (b) p.set(a, b);
      return `<a href="${esc(`/admin/assistente${p.size ? `?${p}` : ''}#base`)}" ${cur === v ? 'aria-current="page"' : ''}>${esc(label)}</a>`;
    };
    return view(req, reply, 'Assistente virtual', `<h1>Assistente virtual</h1>${flash(OK[String(q.ok)])}
<p class="hint sans">O assistente da página «Ajuda» responde só com as entradas ativas desta base (pesquisa local; com a chave da OpenAI, o modelo redige uma resposta curta a partir das três melhores entradas, sem inventar). As perguntas ficam registadas sem dados de quem perguntou (emails, números e links tapados) e são apagadas ao fim de ${ASSISTANT_LOG_DAYS} dias. Os pedidos ao suporte chegam a <a href="/admin/suporte">Suporte</a>.</p>
<div class="card sans"><strong>Últimos 30 dias:</strong> ${stats.n} perguntas · ${stats.unanswered} sem resposta · ${stats.yes} ajudou · ${stats.no} não ajudou · ${stats.esc} enviadas ao suporte · ${stats.ai} com resposta redigida pela IA</div>

<section aria-labelledby="h-melhorar"><h2 id="h-melhorar">${all ? `Todas as perguntas (últimos ${ASSISTANT_LOG_DAYS} dias)` : 'Perguntas a melhorar'}</h2>
<p class="hint sans">${all ? '<a href="/admin/assistente#h-melhorar">Ver só as perguntas sem resposta ou que não ajudaram</a>' : `Perguntas sem resposta na base ou marcadas «não ajudou», ainda por tratar. Crie ou melhore uma entrada e marque a pergunta como tratada. <a href="/admin/assistente?perguntas=todas#h-melhorar">Ver todas as perguntas</a>`}</p>
${qs.length ? `<div class="card" style="overflow-x:auto"><table><thead><tr><th>Pergunta</th><th>Língua · público</th><th>Resultado</th><th>Entradas usadas</th><th>Data</th><th></th></tr></thead><tbody>
${qs.map((r: any) => `<tr><td><span class="msgbody">${esc(r.question)}</span>${r.answer ? `<details><summary class="hint sans">Resposta redigida</summary><p class="msgbody hint">${esc(r.answer)}</p></details>` : ''}</td><td>${esc(LANG_LABEL[r.lang] ?? r.lang)} · ${esc(AUD_LABEL[r.audience] ?? r.audience)}</td><td>${outcome(r)}</td>
<td>${(r.faq_ids as string[]).map(id => used.get(id)).filter(Boolean).map((e: any) => `<a href="/admin/assistente/${e.id}">${esc(cut(fillVars(e.question), 60))}</a>`).join('<br>') || '—'}</td><td>${esc(fmt(r.created_at))}</td>
<td><a href="/admin/assistente/nova?de=${r.id}">Criar entrada</a>${r.reviewed ? '' : `<form method="post" action="/admin/assistente/perguntas/${r.id}/tratada"><button class="ghost" style="padding:6px 12px;min-height:0;margin-top:6px">Marcar como tratada</button></form>`}</td></tr>`).join('')}
</tbody></table></div>` : '<div class="card"><p class="hint" style="margin:0">Nada por tratar.</p></div>'}</section>

<section id="base" aria-labelledby="h-base"><div class="row"><h2 id="h-base" class="grow">Base de conhecimento</h2><a class="btn accent" href="/admin/assistente/nova">Nova entrada</a></div>
<nav class="filters" aria-label="Filtrar por língua">${filterLink('lingua', '', 'Todas as línguas', fl)}${FAQ_LANGS.map(l => filterLink('lingua', l, LANG_LABEL[l], fl)).join('')}</nav>
<nav class="filters" aria-label="Filtrar por público">${filterLink('publico', '', 'Todos os públicos', fa)}${FAQ_AUDIENCES.map(a => filterLink('publico', a, AUD_LABEL[a], fa)).join('')}</nav>
${faq.length ? `<div class="card" style="overflow-x:auto"><table><thead><tr><th>Ordem</th><th>Pergunta</th><th>Língua</th><th>Público</th><th>Estado</th><th></th></tr></thead><tbody>
${faq.map((e: any) => `<tr><td>${e.sort}</td><td><a href="/admin/assistente/${e.id}">${esc(fillVars(e.question))}</a>${e.seed_key ? '' : ' <span class="hint">(criada aqui)</span>'}</td><td>${esc(LANG_LABEL[e.lang])}</td><td>${esc(AUD_LABEL[e.audience])}</td><td>${e.active ? pill('ativa', 'ok') : pill('inativa', 'bad')}</td>
<td><form method="post" action="/admin/assistente/${e.id}/estado"><input type="hidden" name="active" value="${e.active ? '0' : '1'}"><button class="ghost" style="padding:6px 12px;min-height:0">${e.active ? 'Desativar' : 'Ativar'}</button></form></td></tr>`).join('')}
</tbody></table></div>` : '<div class="card"><p class="hint" style="margin:0">Sem entradas neste filtro.</p></div>'}</section>`);
  });

  /** Formulário de uma entrada (nova ou existente), com os marcadores disponíveis e a pré-visualização da resposta. */
  const form = (e: any, action: string, err?: string) => {
    const vars = faqVars();
    return `${flash(err, 'bad')}<form method="post" action="${esc(action)}" class="card">
<div class="row"><div class="grow"><label for="f-lang">Língua</label>${sel('lang', e.lang, FAQ_LANGS.map(l => [l, LANG_LABEL[l]]), 'Língua')}</div>
<div class="grow"><label for="f-audience">Público</label>${sel('audience', e.audience, FAQ_AUDIENCES.map(a => [a, AUD_LABEL[a]]), 'Público')}</div>
<div><label for="f-sort">Ordem</label><input id="f-sort" name="sort" type="number" min="0" max="100000" value="${esc(e.sort)}" style="width:120px;padding:11px 12px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink)"></div></div>
<label for="f-q">Pergunta</label><input id="f-q" name="question" type="text" required maxlength="${FAQ_LIMITS.question}" value="${esc(e.question)}">
<label for="f-k">Palavras-chave</label><input id="f-k" name="keywords" type="text" maxlength="${FAQ_LIMITS.keywords}" value="${esc(e.keywords)}">
<p class="hint">Separadas por vírgulas: as palavras que as pessoas usam ao perguntar (sinónimos, formas coloquiais). Contam mais do que o texto da pergunta e da resposta.</p>
<label for="f-a">Resposta</label><textarea id="f-a" name="answer" required maxlength="${FAQ_LIMITS.answer}" rows="8">${esc(e.answer)}</textarea>
<p class="hint">Só o que o portal faz hoje: o assistente não acrescenta nada. Marcadores substituídos pelos valores em vigor: ${Object.keys(vars).map(k => `<code>{${k}}</code> (${esc(FAQ_VAR_HELP[k] ?? '')}: ${esc(vars[k])})`).join(' · ')}.</p>
<label class="check"><input type="checkbox" name="active" value="1" ${e.active ? 'checked' : ''}> Ativa (o assistente usa-a)</label>
<p><button class="accent">Guardar entrada</button> <a class="btn ghost" href="/admin/assistente#base">Voltar</a></p></form>
${e.answer ? `<div class="card"><h2 style="margin-top:0;font-size:1.2rem">Pré-visualização</h2><p><strong>${esc(fillVars(e.question))}</strong></p><p class="msgbody">${esc(fillVars(e.answer))}</p></div>` : ''}`;
  };

  /** Valores do formulário, validados (erro em texto para o ecrã). */
  const read = (b: any): { ok: true; v: any } | { ok: false; e: string; v: any } => {
    const v = {
      lang: FAQ_LANGS.includes(b?.lang) ? b.lang : 'pt', audience: FAQ_AUDIENCES.includes(b?.audience) ? b.audience : 'interviewer',
      question: String(b?.question ?? '').replace(/\s+/g, ' ').trim(), answer: String(b?.answer ?? '').replace(/\r\n?/g, '\n').trim(),
      keywords: String(b?.keywords ?? '').replace(/\s+/g, ' ').trim(), sort: Math.max(0, Math.min(100000, parseInt(b?.sort) || 0)), active: !!b?.active,
    };
    if (!v.question || !v.answer) return { ok: false, e: 'Escreva a pergunta e a resposta.', v };
    if (v.question.length > FAQ_LIMITS.question) return { ok: false, e: `A pergunta tem mais de ${FAQ_LIMITS.question} caracteres.`, v };
    if (v.answer.length > FAQ_LIMITS.answer) return { ok: false, e: `A resposta tem mais de ${FAQ_LIMITS.answer} caracteres.`, v };
    if (v.keywords.length > FAQ_LIMITS.keywords) return { ok: false, e: `As palavras-chave têm mais de ${FAQ_LIMITS.keywords} caracteres.`, v };
    return { ok: true, v };
  };
  const entryOf = async (req: FastifyRequest) => { const id = (req.params as any).id; return isUuid(id) ? db.one('SELECT * FROM assistant_faq WHERE id=$1', [id]) : undefined; };
  const back = (h: string) => `<p class="sans"><a href="/admin/assistente${h}">← Assistente virtual</a></p>`;

  app.get('/admin/assistente/nova', async (req, reply) => {
    if (!guard(req, reply)) return;
    // «Criar entrada» a partir de uma pergunta registada: a pergunta, a língua e o público vêm do registo.
    const de = (req.query as any).de;
    const src = isUuid(de) ? await db.one('SELECT question, lang, audience FROM assistant_questions WHERE id=$1', [de]) : null;
    const max = (await db.one('SELECT COALESCE(max(sort),0)::int AS m FROM assistant_faq'))?.m ?? 0;
    const e = { lang: src?.lang ?? 'pt', audience: src?.audience ?? 'interviewer', question: src ? cut(src.question, FAQ_LIMITS.question) : '', answer: '', keywords: '', sort: max + 10, active: true };
    return view(req, reply, 'Nova entrada', `${back('#base')}<h1 style="font-size:1.8rem">Nova entrada</h1>${form(e, '/admin/assistente')}`);
  });

  app.post('/admin/assistente', async (req, reply) => {
    if (!guard(req, reply)) return;
    const r = read(req.body);
    if (!r.ok) return view(req, reply, 'Nova entrada', `${back('#base')}<h1 style="font-size:1.8rem">Nova entrada</h1>${form(r.v, '/admin/assistente', r.e)}`, 422);
    const v = r.v;
    const row = await db.one(`INSERT INTO assistant_faq(lang, audience, question, answer, keywords, sort, active) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [v.lang, v.audience, v.question, v.answer, v.keywords, v.sort, v.active]);
    await audit(db, req.user!.email, 'assistant.faq_created', null, { faqId: row.id });
    return reply.redirect('/admin/assistente?ok=created#base');
  });

  app.get('/admin/assistente/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const e = await entryOf(req);
    if (!e) return view(req, reply, 'Assistente virtual', `${back('#base')}<h1>Entrada não encontrada</h1>`, 404);
    return view(req, reply, 'Editar entrada', `${back('#base')}<h1 style="font-size:1.8rem">Editar entrada</h1>
<p class="hint sans">${e.seed_key ? `Entrada da semente inicial (${esc(e.seed_key)}); as suas alterações mantêm-se em futuras atualizações do portal.` : 'Entrada criada pelo administrador.'} Atualizada em ${esc(fmt(e.updated_at))}.</p>${form(e, `/admin/assistente/${e.id}`)}`);
  });

  app.post('/admin/assistente/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const e = await entryOf(req);
    if (!e) return reply.code(404).send('Não encontrada');
    const r = read(req.body);
    if (!r.ok) return view(req, reply, 'Editar entrada', `${back('#base')}<h1 style="font-size:1.8rem">Editar entrada</h1>${form({ ...r.v, id: e.id }, `/admin/assistente/${e.id}`, r.e)}`, 422);
    const v = r.v;
    await db.query(`UPDATE assistant_faq SET lang=$2, audience=$3, question=$4, answer=$5, keywords=$6, sort=$7, active=$8, updated_at=now() WHERE id=$1`, [e.id, v.lang, v.audience, v.question, v.answer, v.keywords, v.sort, v.active]);
    await audit(db, req.user!.email, 'assistant.faq_updated', null, { faqId: e.id });
    return reply.redirect('/admin/assistente?ok=saved#base');
  });

  app.post('/admin/assistente/:id/estado', async (req, reply) => {
    if (!guard(req, reply)) return;
    const e = await entryOf(req);
    if (!e) return reply.code(404).send('Não encontrada');
    const on = (req.body as any)?.active === '1';
    await db.query('UPDATE assistant_faq SET active=$2, updated_at=now() WHERE id=$1', [e.id, on]);
    await audit(db, req.user!.email, on ? 'assistant.faq_activated' : 'assistant.faq_deactivated', null, { faqId: e.id });
    return reply.redirect(`/admin/assistente?ok=${on ? 'on' : 'off'}#base`);
  });

  app.post('/admin/assistente/perguntas/:id/tratada', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!isUuid(id)) return reply.code(404).send('Não encontrada');
    await db.query('UPDATE assistant_questions SET reviewed=true WHERE id=$1', [id]);
    return reply.redirect('/admin/assistente?ok=reviewed#h-melhorar');
  });
}
