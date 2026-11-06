import type { FastifyInstance } from 'fastify';
import type { Db } from '../db.ts';
import { esc, fmtDate } from '../lib.ts';
import { page, pill } from '../views.ts';
import { requireUser } from '../app.ts';
import { helpNav } from '../support.ts';

const LEVEL: Record<string, '' | 'ok' | 'warn' | 'bad'> = { info: '', ok: 'ok', warn: 'warn', bad: 'bad' };
const LEVEL_LABEL: Record<string, string> = { info: 'informação', ok: 'concluído', warn: 'atenção', bad: 'problema' };

/** Lista de avisos (página /avisos e atividade de uma entrevista). */
export const noticeList = (rows: any[], withTitle = true) => rows.length ? `<ul class="sans" style="list-style:none;padding:0;margin:0">${rows.map((n: any) =>
  `<li style="padding:10px 0;border-bottom:1px solid var(--line)${n.read_at ? '' : ';font-weight:600'}">${pill(LEVEL_LABEL[n.level] ?? n.level, LEVEL[n.level] ?? '')} <a href="${esc(n.url || `/entrevistas/${n.interview_id}`)}">${esc(n.title)}</a>${withTitle && n.iv_title ? ` <span class="hint">· ${esc(n.iv_title)}</span>` : ''}
<br><span class="hint" style="font-weight:400">${fmtDate(n.created_at)}${n.body ? ` · ${esc(n.body)}` : ''}</span></li>`).join('')}</ul>` : '<p class="hint">Ainda não há avisos.</p>';

/** Atividade de uma entrevista (página da entrevista): os últimos avisos dela. */
export async function interviewActivity(db: Db, interviewId: string, userId: string) {
  const rows = await db.query(`SELECT * FROM notices WHERE interview_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 15`, [interviewId, userId]);
  if (!rows.length) return '';
  await db.query(`UPDATE notices SET read_at=now() WHERE interview_id=$1 AND user_id=$2 AND read_at IS NULL`, [interviewId, userId]);
  return `<div class="card" id="atividade"><h2 style="margin-top:0">Atividade do entrevistado e da produção</h2>${noticeList(rows, false)}<p class="hint"><a href="/avisos">Todos os avisos</a></p></div>`;
}

export async function noticeRoutes(app: FastifyInstance) {
  const db = app.db;
  app.get('/avisos', async (req, reply) => {
    if (!requireUser(req, reply)) return;
    const q = req.query as any;
    const only = typeof q.e === 'string' && /^[0-9a-f-]{36}$/i.test(q.e) ? q.e : null;
    const rows = await db.query(`SELECT n.*, i.title AS iv_title FROM notices n LEFT JOIN interviews i ON i.id=n.interview_id WHERE n.user_id=$1 AND ($2::uuid IS NULL OR n.interview_id=$2) ORDER BY n.created_at DESC LIMIT 200`, [req.user!.id, only]);
    // Abrir a página marca tudo como lido (a lista mostra a negrito o que ainda não tinha sido visto).
    await db.query(`UPDATE notices SET read_at=now() WHERE user_id=$1 AND read_at IS NULL AND ($2::uuid IS NULL OR interview_id=$2)`, [req.user!.id, only]);
    req.user!.notices_unread = only ? Math.max(0, (req.user!.notices_unread ?? 0) - rows.filter((r: any) => !r.read_at).length) : 0;
    const ivs = await db.query(`SELECT DISTINCT i.id, i.title FROM notices n JOIN interviews i ON i.id=n.interview_id WHERE n.user_id=$1 ORDER BY i.title`, [req.user!.id]);
    const body = `<div class="narrow" style="padding-top:32px"><h1>Avisos</h1>
<p class="hint">O que aconteceu nas suas entrevistas: quando o entrevistado abre o convite, aceita, responde (e se alguma resposta ficou sem voz), envia fotografias, muda as autorizações, submete, aprova ou pede alterações; e quando o episódio, o vídeo ou um convite para assistir têm novidades.</p>
${ivs.length > 1 ? `<form method="get" class="row"><label for="e" style="margin:0">Entrevista</label><select id="e" name="e" style="width:auto" onchange="this.form.submit()"><option value="">Todas</option>${ivs.map((i: any) => `<option value="${esc(i.id)}" ${i.id === only ? 'selected' : ''}>${esc(i.title)}</option>`).join('')}</select><noscript><button class="ghost">Filtrar</button></noscript></form>` : ''}
<div class="card">${noticeList(rows)}</div></div>`;
    return reply.type('text/html; charset=utf-8').send(page({ title: 'Avisos', body, noindex: true, nav: `<a href="/painel">Painel</a>${helpNav(req.user)}` }));
  });
}
