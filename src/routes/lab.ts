import type { FastifyInstance } from 'fastify';
import { esc, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit, sendAsset } from '../app.ts';
import { enqueue } from '../jobs.ts';
import { lipsyncModel, replicatePricePerSec } from '../lipsync.ts';
import { S } from '../settings.ts';
import { PROVIDERS, providerReady, verifySignedAsset } from '../talking.ts';

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
    const cmp = await db.query(`SELECT * FROM jobs WHERE kind='talking_compare' ORDER BY created_at DESC LIMIT 5`);
    const cmpLive = cmp.find((r: any) => ['queued', 'running'].includes(r.state));
    const usd = (n: number | null | undefined) => (n == null ? '—' : '$' + Number(n).toFixed(2));
    const body = `<div class="wrap" style="padding-top:32px"><h1>Laboratório — retratos falantes</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card"><h2 style="margin-top:0">Comparação de modelos</h2>
<p>Mesmo retrato fictício (pessoa que não existe) e a mesma frase em todos os modelos, para comparar realismo, tempo e custo lado a lado.</p>
<form method="post" action="/admin/laboratorio/comparar" onsubmit="return confirm('Correr a comparação (custa alguns dólares no total)?')">
<label for="ctx">Frase (inglês)</label><input id="ctx" name="text" type="text" maxlength="200" value="Hello, and welcome. Today we talk about the future of energy in Portugal.">
${PROVIDERS.map(p => `<label class="check"><input type="checkbox" name="p_${p.id}" value="1" ${providerReady(p) ? 'checked' : 'disabled'}> <span><strong>${esc(p.label)}</strong> — ${esc(p.partner)} · ${p.pricePerSec != null ? `~$${p.pricePerSec}/s` : 'preço por confirmar'} · ${esc(p.note)}${providerReady(p) ? '' : ` <span class="hint">(falta a chave ${esc(p.partner)} em Definições)</span>`}</span></label>`).join('')}
<p class="hint">Estimativa para ~6 s: OmniHuman ~$1, Fabric ~$0,85, HeyGen ~$0,60, Veo ~$0,80 (8 s), InfiniteTalk por confirmar. O Veo não usa o nosso áudio: gera a sua própria voz a partir da frase.</p>
<p><button class="accent" ${cmpLive ? 'disabled' : ''}>Comparar</button></p></form>
${cmpLive ? `<div class="flash" aria-live="polite">${esc(cmpLive.state === 'queued' ? 'Em fila' : cmpLive.progress_label || 'A correr')} — a página atualiza sozinha.<meta http-equiv="refresh" content="8"></div>` : ''}
${cmp.filter((r: any) => r.result?.results).map((r: any) => `<h3>${fmtDate(r.created_at)} ${pill(r.state, r.state === 'done' ? 'ok' : r.state === 'failed' ? 'bad' : '')}</h3>
<div class="grid3">${r.result.results.map((x: any) => `<div class="card" style="margin:0"><strong>${esc(x.label)}</strong><br>${x.videoAssetId ? `<video controls preload="metadata" src="/admin/laboratorio/media/${x.videoAssetId}" style="width:100%;border-radius:8px;background:#000;margin-top:6px"></video>` : `<p class="hint" style="color:var(--bad)">${esc(x.error ?? 'falhou')}</p>`}
<p class="hint sans">Tempo ${x.wallSec ?? '—'} s · custo estimado ${usd(x.estUsd)}${x.billedSec != null ? ` · faturado ${x.billedSec.toFixed(1)} s` : ''}${x.ownAudio === false ? ' · voz do próprio modelo' : ''}</p></div>`).join('')}</div>`).join('')}
${cmp.length && !cmp[0].result?.results && cmp[0].error ? `<p class="hint" style="color:var(--bad)">${esc(cmp[0].error)}</p>` : ''}
</div>
<h2>SadTalker (experiência anterior)</h2>
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

  // URL temporário e assinado para os fornecedores descarregarem a fotografia/áudio (expira em 1 h).
  app.get('/m/:id/:exp/:sig', async (req, reply) => {
    const { id, exp, sig } = req.params as any;
    if (!/^[0-9a-f-]{36}$/i.test(id) || !verifySignedAsset(id, exp, sig)) return reply.code(404).send();
    const a = await db.one(`SELECT * FROM assets WHERE id=$1 AND kind IN ('lab_portrait','lab_audio') AND deleted_at IS NULL`, [id]);
    if (!a) return reply.code(404).send();
    return sendAsset(req, reply, a, { cache: 'private, max-age=600' });
  });

  app.post('/admin/laboratorio/comparar', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (await db.one(`SELECT 1 FROM jobs WHERE kind='talking_compare' AND state IN ('queued','running')`)) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Já há uma comparação a correr.'));
    const b = req.body as any;
    const chosen = PROVIDERS.filter(p => b['p_' + p.id] && providerReady(p)).map(p => p.id);
    if (!chosen.length) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Escolha pelo menos um modelo com chave configurada.'));
    const text = String(b.text ?? '').trim().slice(0, 200) || 'Hello, and welcome.';
    await enqueue(db, { kind: 'talking_compare', input: { text, providers: chosen }, dedupe: `compare:${Date.now()}` });
    await audit(db, req.user!.email, 'lab.compare_started', null, { providers: chosen });
    return reply.redirect('/admin/laboratorio?ok=' + encodeURIComponent('Comparação iniciada.'));
  });

  app.get('/admin/laboratorio/media/:id', async (req, reply) => {
    if (!guard(req, reply)) return;
    const id = (req.params as any).id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send();
    const a = await db.one(`SELECT * FROM assets WHERE id=$1 AND interview_id IS NULL AND kind IN ('lab_video','lab_portrait','lab_audio') AND deleted_at IS NULL`, [id]);
    if (!a) return reply.code(404).send();
    return sendAsset(req, reply, a);
  });
}
