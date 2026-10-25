import type { FastifyInstance } from 'fastify';
import { esc, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit, sendAsset } from '../app.ts';
import { enqueue } from '../jobs.ts';
import { lipsyncModel, replicatePricePerSec } from '../lipsync.ts';
import { S } from '../settings.ts';
import { helpNav } from '../support.ts';
import { LAB_CONTINUITY_MAX_CHUNKS } from '../lab-continuity.ts';
import { chunkText } from '../veo-episode.ts';
import { PROVIDERS, providerReady, isVeoProvider, veoBackend, veoModel, verifySignedAsset, presenterDirection } from '../talking.ts';

/** Laboratório (só administradores): experiências com retratos fictícios. */
export async function labRoutes(app: FastifyInstance) {
  const db = app.db;
  const guard = (req: any, reply: any) => {
    if (!req.user) { reply.redirect('/entrar'); return false; }
    if (req.user.role !== 'admin') { reply.code(403).send('Acesso reservado a administradores'); return false; }
    return true;
  };
  const nav = (u: any) => `<a href="/painel">Painel</a><a href="/admin/utilizadores">Utilizadores</a><a href="/admin/definicoes">Definições</a><a href="/admin/laboratorio">Laboratório</a>${helpNav(u)}`;

  app.get('/admin/laboratorio', async (req, reply) => {
    if (!guard(req, reply)) return;
    const q = req.query as any;
    const runs = await db.query(`SELECT * FROM jobs WHERE kind='lipsync_experiment' ORDER BY created_at DESC LIMIT 10`);
    const live = runs.find((r: any) => ['queued', 'running'].includes(r.state));
    const cmp = await db.query(`SELECT * FROM jobs WHERE kind='talking_compare' ORDER BY created_at DESC LIMIT 5`);
    const cmpLive = cmp.find((r: any) => ['queued', 'running'].includes(r.state));
    const usd = (n: number | null | undefined) => (n == null ? '—' : '$' + Number(n).toFixed(2));
    const cont = await db.query(`SELECT * FROM jobs WHERE kind='veo_continuity' ORDER BY created_at DESC LIMIT 5`);
    const contLive = cont.find((r: any) => ['queued', 'running'].includes(r.state));
    const contHtml = `<div class="card"><h2 style="margin-top:0">Cortes entre clipes do Veo</h2>
<p>A mesma fala, dividida em pedaços como no vídeo premium, montada de três maneiras para comparar os cortes: <strong>A</strong> como hoje (cada clipe parte do retrato), <strong>B</strong> igual com plano apertado alternado nos cortes (sem custo extra) e <strong>C</strong> encadeado (cada clipe parte do fotograma onde o anterior foi cortado). Retrato fictício; até ${LAB_CONTINUITY_MAX_CHUNKS} pedaços.</p>
<form method="post" action="/admin/laboratorio/continuidade" onsubmit="return confirm('Correr a experiência (5 clipes do Veo, ~$4 no Fast)?')">
<label for="ctt">Fala (inglês, 2 a 3 frases)</label><textarea id="ctt" name="text" rows="3" maxlength="600">Today we are talking about the energy transition in Portugal and what it means for families. First, the electricity grid has to carry far more solar and wind power than it was built for. Second, we need storage, so that the energy of a sunny afternoon is still there at night.</textarea>
<label for="ctier">Nível</label><select id="ctier" name="tier" style="width:auto"><option value="fast">Veo 3.1 Fast</option><option value="lite">Veo 3.1 Lite</option></select>
<p><button class="accent" ${contLive ? 'disabled' : ''}>Comparar cortes</button></p></form>
${contLive ? `<div class="flash" aria-live="polite">${esc(contLive.state === 'queued' ? 'Em fila' : contLive.progress_label || 'A correr')} — a página atualiza sozinha.<meta http-equiv="refresh" content="10"></div>` : ''}
${cont.filter((r: any) => r.result?.variants).map((r: any) => `<h3>${fmtDate(r.created_at)} ${pill(r.state, 'ok')} <span class="hint">${esc(r.result.tier)} · ~${usd(r.result.usd)}</span></h3>
<div class="grid3">${r.result.variants.map((v: any) => `<div class="card" style="margin:0"><strong>${esc(v.label)}</strong><video controls preload="metadata" src="/admin/laboratorio/media/${v.videoAssetId}" style="width:100%;border-radius:8px;background:#000;margin-top:6px"></video></div>`).join('')}</div>`).join('')}
${cont[0] && !cont[0].result?.variants && cont[0].error ? `<p class="hint" style="color:var(--bad)">${esc(cont[0].error)}</p>` : ''}</div>`;
    const probes = await db.query(`SELECT * FROM jobs WHERE kind='veo_filter_probe' ORDER BY created_at DESC LIMIT 3`);
    const probeLive = probes.find((r: any) => ['queued', 'running'].includes(r.state));
    const ivs = await db.query(`SELECT i.id, i.title, i.guest_name FROM interviews i WHERE EXISTS (SELECT 1 FROM photos p WHERE p.interview_id=i.id)
      AND COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=i.id AND c.purpose='ai_video' ORDER BY c.created_at DESC LIMIT 1), false) ORDER BY i.created_at DESC LIMIT 20`);
    const probeHtml = `<div class="card"><h2 style="margin-top:0">Diagnóstico do filtro da Google (fotografia do entrevistado)</h2>
<p>Quando a Google recusa animar a fotografia de um entrevistado (código 15236754, «semelhança com uma pessoa conhecida»), experimenta a mesma frase curta (4 s) com variações: pedido atual, pedido simples, plano mais aberto, modelo normal, «allow_all», fotografia como referência e as outras fotografias dele. Os clipes bloqueados não são cobrados; os que passam custam ~0,40 $ (Fast) ou ~1,60 $ (modelo normal). Só entrevistas em que o entrevistado autorizou o vídeo por IA.</p>
<form method="post" action="/admin/laboratorio/filtro" onsubmit="return confirm('Correr o diagnóstico (até ~6 $ se todas as variações passarem)?')"><label for="fiv">Entrevista</label><select id="fiv" name="interviewId">${ivs.map((i: any) => `<option value="${i.id}">${esc(i.title)} — ${esc(i.guest_name ?? '')}</option>`).join('')}</select>
<p><button class="accent" ${probeLive || !ivs.length ? 'disabled' : ''}>Diagnosticar</button></p></form>
${probeLive ? `<div class="flash" aria-live="polite">${esc(probeLive.progress_label || 'Em fila')} — a página atualiza sozinha.<meta http-equiv="refresh" content="10"></div>` : ''}
${probes.filter((r: any) => r.result?.results).map((r: any) => `<h3>${fmtDate(r.created_at)} ${pill(r.state, r.state === 'done' ? 'ok' : r.state === 'failed' ? 'bad' : '')} <span class="hint">frase: «${esc(r.result.text ?? '')}»</span></h3>
<table class="sans"><tbody>${r.result.results.map((x: any) => `<tr><td>${esc(x.label)}</td><td>${x.ok ? pill('passou', 'ok') : x.filtered ? pill('bloqueado pelo filtro', 'bad') : pill('erro', 'warn')}</td><td>${x.ok ? `<video controls preload="none" src="/admin/laboratorio/media/${x.videoAssetId}" style="width:220px;border-radius:6px;background:#000"></video>` : `<span class="hint">${esc(x.error ?? '')}</span>`}</td></tr>`).join('')}</tbody></table>`).join('')}
${probes[0] && !probes[0].result?.results && probes[0].error ? `<p class="hint" style="color:var(--bad)">${esc(probes[0].error)}</p>` : ''}</div>`;
    const body = `<div class="wrap" style="padding-top:32px"><h1>Laboratório — retratos falantes</h1>${flash(q.ok)}${flash(q.e, 'bad')}
${probeHtml}
${contHtml}
<div class="card"><h2 style="margin-top:0">Comparação de modelos</h2>
<p>Mesmo retrato fictício (pessoa que não existe) e a mesma frase em todos os modelos, para comparar realismo, tempo e custo lado a lado.</p>
<form method="post" action="/admin/laboratorio/comparar" onsubmit="return confirm('Correr a comparação (custa alguns dólares no total)?')">
<label for="ctx">Frase (inglês)</label><input id="ctx" name="text" type="text" maxlength="400" value="Hello, and welcome. Today we talk about the future of energy in Portugal. We will look at three things: the grid, storage, and what it all means for consumers.">
<label for="dir">Direção de cena (regras de apresentação; usada pelo OmniHuman, InfiniteTalk e Veo)</label><textarea id="dir" name="direction" rows="6">${esc(presenterDirection('presenter'))}</textarea>
<p class="hint">O retrato fictício é gerado a meio corpo, com as mãos visíveis, para que os gestos sejam possíveis.</p>
${PROVIDERS.map(p => `<label class="check"><input type="checkbox" name="p_${p.id}" value="1" ${!providerReady(p) ? 'disabled' : p.preselected ? 'checked' : ''}> <span><strong>${esc(p.label)}</strong> — ${esc(isVeoProvider(p) ? `${p.partner} (${veoBackend() === 'vertex' ? 'Vertex AI' : 'Gemini API'}: ${veoModel(p.id === 'veo-lite' ? 'lite' : 'fast')})` : p.partner)} · ${p.pricePerSec != null ? `~$${p.pricePerSec.toFixed(2)}/s` : 'preço por confirmar'} · ${esc(p.note)}${providerReady(p) ? '' : ` <span class="hint">(${isVeoProvider(p) ? 'falta a conta de serviço do Vertex AI, ou a chave da Gemini API, em Definições → Google' : `falta a chave ${esc(p.partner)} em Definições`})</span>`}</span></label>`).join('')}
<p class="hint">Vêm marcados só o Veo 3.1 Fast e o Lite; os outros modelos continuam disponíveis, desmarcados. Estimativa: Veo Fast ~$0,80 e Veo Lite ~$0,40 por clipe de 8 s; para ~6 s, OmniHuman ~$1, Fabric ~$0,85, HeyGen ~$0,60, InfiniteTalk por confirmar. O Veo não usa o nosso áudio: gera a sua própria voz a partir da frase. Para comparar Fast e Lite, o retrato, a frase e o pedido são os mesmos.</p>
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
    return reply.type('text/html; charset=utf-8').send(page({ title: 'Laboratório', body, nav: nav(req.user), noindex: true }));
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
    if (!chosen.length) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Escolha pelo menos um modelo com credenciais configuradas.'));
    const text = String(b.text ?? '').trim().slice(0, 400) || 'Hello, and welcome.';
    const direction = String(b.direction ?? '').trim().slice(0, 3000) || presenterDirection('presenter');
    await enqueue(db, { kind: 'talking_compare', input: { text, providers: chosen, direction }, dedupe: `compare:${Date.now()}` });
    await audit(db, req.user!.email, 'lab.compare_started', null, { providers: chosen });
    return reply.redirect('/admin/laboratorio?ok=' + encodeURIComponent('Comparação iniciada.'));
  });

  app.post('/admin/laboratorio/filtro', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (await db.one(`SELECT 1 FROM jobs WHERE kind='veo_filter_probe' AND state IN ('queued','running')`)) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Já há um diagnóstico a correr.'));
    const id = String((req.body as any)?.interviewId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !(await db.one('SELECT 1 FROM interviews WHERE id=$1', [id]))) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Escolha uma entrevista.'));
    await enqueue(db, { kind: 'veo_filter_probe', input: { interviewId: id }, dedupe: `filtro:${Date.now()}` });
    await audit(db, req.user!.email, 'lab.filter_probe_started', id);
    return reply.redirect('/admin/laboratorio?ok=' + encodeURIComponent('Diagnóstico iniciado.'));
  });

  app.post('/admin/laboratorio/continuidade', async (req, reply) => {
    if (!guard(req, reply)) return;
    if (await db.one(`SELECT 1 FROM jobs WHERE kind='veo_continuity' AND state IN ('queued','running')`)) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Já há uma experiência de cortes a correr.'));
    const b = req.body as any;
    const text = String(b.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 600);
    if (chunkText(text).length < 2) return reply.redirect('/admin/laboratorio?e=' + encodeURIComponent('Escreva pelo menos duas frases (para haver cortes).'));
    await enqueue(db, { kind: 'veo_continuity', input: { text, tier: b.tier === 'lite' ? 'lite' : 'fast' }, dedupe: `continuity:${Date.now()}` });
    await audit(db, req.user!.email, 'lab.continuity_started', null);
    return reply.redirect('/admin/laboratorio?ok=' + encodeURIComponent('Experiência de cortes iniciada.'));
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
