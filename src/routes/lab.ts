import type { FastifyInstance } from 'fastify';
import { esc, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit, sendAsset } from '../app.ts';
import { enqueue } from '../jobs.ts';
import { lipsyncModel, replicatePricePerSec } from '../lipsync.ts';
import { S } from '../settings.ts';

/** Laboratório (só administradores): experiências com retratos fictícios. */
export async function labRoutes(app: FastifyInstance) {
  const db = app.db;
  const guard = (req: any, reply: any) => {
    if (!req.user) { reply.redirect('/entrar'); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send('Acesso reservado a administradores'); return false; }
    return true;
  };
  const nav = `<a href="/painel">Painel</a><a href="/admin/utilizadores">Utilizadores</a><a href="/admin/definicoes">Definições</a><a href="/admin/laboratorio">Laboratório</a>`;

  app.get('/admin/laboratorio', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const runs = await db.query(`SELECT * FROM jobs WHERE kind='lipsync_experiment' ORDER BY created_at DESC LIMIT 10`);
    const live = runs.find((r: any) => ['queued', 'running'].includes(r.state));
    const body = `<div class="wrap" style="padding-top:32px"><h1>Laboratório — sincronização labial</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card"><p>Gera um <strong>retrato fictício</strong> (imagem criada por IA de uma pessoa que não existe), uma frase curta com voz sintética masculina e anima o retrato com sincronização labial através da Replicate (modelo <code>${esc(lipsyncModel())}</code>).</p>
<p class="hint">Custo aproximado por experiência: retrato ~$0,04 (OpenAI) + voz ~$0,01 + animação ~$0,05–0,20 (Replicate, cobrado ao segundo de GPU; estimativa a $${replicatePricePerSec()}/s). Não usa fotografias de pessoas reais: para isso seria preciso uma autorização específica de cada pessoa e um aviso visível no vídeo.</p>
${S('REPLICATE_API_TOKEN') ? '' : '<div class="flash bad">Falta o token da Replicate em Definições.</div>'}
<form method="post" action="/admin/laboratorio/lipsync" onsubmit="return confirm('Correr a experiência (custa alguns cêntimos)?')"><label for="tx">Frase (inglês)</label><input id="tx" name="text" type="text" maxlength="200" value="Hello, and welcome. Today we talk about the future of energy in Portugal.">
<p><button class="accent" ${live || !S('REPLICATE_API_TOKEN') ? 'disabled' : ''}>Correr experiência</button></p></form></div>
${live ? `<div class="card" aria-live="polite"><strong>${esc(live.state === 'queued' ? 'Em fila' : live.progress_label || 'A correr')}</strong><p class="hint">A página atualiza sozinha.</p><meta http-equiv="refresh" content="6"></div>` : ''}
${runs.map((r: any) => `<div class="card"><p class="sans">${fmtDate(r.created_at)} ${pill(r.state, r.state === 'done' ? 'ok' : r.state === 'failed' ? 'bad' : '')}</p>
${r.result?.videoAssetId ? `<video controls src="/admin/laboratorio/media/${r.result.videoAssetId}" style="max-width:420px;width:100%;border-radius:10px;background:#000"></video>
<p class="sans hint">Modelo ${esc(r.result.model)} · tempo de GPU ${r.result.predictSec != null ? r.result.predictSec.toFixed(1) + ' s' : '—'} · custo estimado da animação ${r.result.estCostUsd != null ? '$' + r.result.estCostUsd.toFixed(3) : '—'} · tempo total ${r.result.wallSec ?? '—'} s · duração do áudio ${r.result.audioSec ?? '—'} s</p>
<p class="hint">Extrapolação para 4 min de rosto em ecrã: ~$${r.result.estCostUsd != null && r.result.audioSec ? ((r.result.estCostUsd / r.result.audioSec) * 240).toFixed(2) : '—'} (proporcional; confirme no painel da Replicate).</p>` : ''}
${r.result?.portraitAssetId ? `<details><summary class="sans">Retrato fictício usado</summary><img alt="Retrato fictício gerado por IA" src="/admin/laboratorio/media/${r.result.portraitAssetId}" style="max-width:240px;border-radius:8px"></details>` : ''}
${r.error ? `<p class="hint" style="color:var(--bad)">${esc(r.error)}</p>` : ''}</div>`).join('')}</div>`;
    return reply.type('text/html; charset=utf-8').send(page({ title: 'Laboratório', body, nav, noindex: true }));
  });

  app.post('/admin/laboratorio/lipsync', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (await db.one(`SELECT 1 FROM jobs WHERE kind='lipsync_experiment' AND state IN ('queued','running')`)) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Já há uma experiência a correr.'));
    const text = String((req.body as any)?.text ?? '').trim().slice(0, 200) || 'Hello, and welcome.';
    await enqueue(db, { kind: 'lipsync_experiment', input: { text }, dedupe: `lipsync:${Date.now()}` });
    await audit(db, req.user!.email, 'lab.lipsync_started', null);
    return reply.redirect('/admin/laboratorio?ok=' + encodeURIComponent('Experiência iniciada.'));
  });

  app.get('/admin/laboratorio/media/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send();
    const a = await db.one(`SELECT * FROM assets WHERE id=$1 AND interview_id IS NULL AND kind IN ('lab_video','lab_portrait') AND deleted_at IS NULL`, [id]);
    if (!a) return reply.code(404).send();
    return sendAsset(req, reply, a);
  });
}
