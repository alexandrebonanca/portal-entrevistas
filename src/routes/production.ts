import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate, fmtDuration, sha256, rateLimit } from '../lib.ts';
import { page, flash, pill, STATUS_LABEL } from '../views.ts';
import { requireUser, ownedInterview, audit, sendAsset } from '../app.ts';
import { enqueue } from '../jobs.ts';
import { estimateCost, latestTranscript } from '../pipeline.ts';
import { aiAvailable, reviewScript, validateScript, episodeVoice } from '../ai/openai.ts';
import { playerHtml } from './episode.ts';
import { createInvitation } from '../invites.ts';
import { queueEmail, emailShell } from '../mail.ts';

const JOB_LABEL: Record<string, string> = { render_video: 'A gerar o vídeo do podcast', process_submission: 'A transcrever e a preparar o guião', prepare_script: 'A preparar o guião', generate_episode: 'A gerar o episódio', transcribe_asset: 'A transcrever' };
const SUBS = [['en', 'English'], ['pt-PT', 'Português (PT)'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']];

export async function productionRoutes(app: FastifyInstance) {
  const db = app.db;
  const consent = async (id: string, p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [id, p]))?.granted;

  const guard = async (req: any, reply: any) => {
    if (!requireUser(req, reply)) return null;
    const iv = await ownedInterview(app, req, req.params.id);
    if (!iv) { reply.code(404).send('Não encontrada'); return null; }
    return iv;
  };
  const back = (reply: any, id: string, ok?: string, e?: string) =>
    reply.redirect(`/entrevistas/${id}/producao${ok ? '?ok=' + encodeURIComponent(ok) : e ? '?e=' + encodeURIComponent(e) : ''}`);

  app.get('/entrevistas/:id/producao', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const q = req.query as any;
    const submitted = iv.collection_status === 'submitted';
    const [procOk, coverOk, pubOk] = await Promise.all([consent(iv.id, 'processing'), consent(iv.id, 'cover_use'), consent(iv.id, 'publish')]);
    const jobs = await db.query(`SELECT * FROM jobs WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 8`, [iv.id]);
    const script = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status<>'superseded' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND status<>'superseded' ORDER BY created_at DESC LIMIT 1`, [iv.id]);
    const ledger = await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS usd FROM usage_ledger WHERE interview_id=$1`, [iv.id]);
    const est = submitted ? await estimateCost(db, iv.id, iv.subtitle_langs) : null;
    const running = jobs.some((j: any) => ['queued', 'running'].includes(j.state));
    let body = `<div class="wrap" style="padding-top:32px"><p><a href="/entrevistas/${iv.id}">← ${esc(iv.title)}</a></p><h1>Produção do podcast</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<p class="sans">${pill(STATUS_LABEL[iv.production_status] ?? iv.production_status)} ${pill(STATUS_LABEL[iv.publication_status] ?? iv.publication_status)} · Utilização registada (estimativa): <strong>$${ledger.usd.toFixed(2)}</strong></p>`;

    if (!submitted) body += `<div class="flash">A entrevista ainda não foi submetida pelo entrevistado.</div>`;

    // 1. Pedido de processamento
    if (submitted && iv.production_status === 'not_requested') {
      const qs = await db.query(`SELECT q.position, q.text, t.asset_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
      body += `<div class="card"><h2 style="margin-top:0">1. Rever originais e confirmar</h2>
<ol>${qs.map((x: any) => `<li>${esc(x.text) || '(áudio)'}<br>${x.asset_id ? `<audio controls preload="none" src="/media/${x.asset_id}"></audio>` : pill('sem resposta', 'warn')}</li>`).join('')}</ol>
<p class="sans">Autorização de processamento por IA: ${procOk ? pill('concedida', 'ok') : pill('não concedida', 'bad')} · capa com fotografia: ${coverOk ? pill('sim', 'ok') : pill('não', 'warn')} · publicação: ${pubOk ? pill('sim', 'ok') : pill('não', 'bad')}</p>
${!procOk ? '<div class="flash bad">O entrevistado não autorizou o processamento por IA. Não é possível processar; não existe forma de contornar esta decisão. Contacte o entrevistado.</div>' : ''}
${!aiAvailable() ? '<div class="flash bad">OPENAI_API_KEY não está configurada neste ambiente.</div>' : ''}
<p class="sans">Estimativa (não é custo final): ~$${est!.usd.toFixed(2)} para ${est!.minutes.toFixed(1)} min de respostas (transcrição $${est!.parts.transcription.toFixed(2)}, voz $${est!.parts.speech.toFixed(2)}, texto $${est!.parts.text.toFixed(2)}, capa $${est!.parts.cover.toFixed(2)}). Duração estimada do episódio: ~${est!.estimatedAudioMin.toFixed(1)} min.</p>
<form method="post" action="/entrevistas/${iv.id}/processar" onsubmit="return confirm('Iniciar o processamento (operações pagas)?')">
<p class="hint">O processamento gera transcrições e um guião para revisão. O áudio final e a publicação são passos posteriores.</p>
<button class="accent" ${procOk && aiAvailable() ? '' : 'disabled'}>Processar podcast</button></form></div>`;
    }

    // 2. Progresso
    const live = jobs.find((j: any) => ['queued', 'running'].includes(j.state));
    if (live) {
      body += `<div class="card" id="progress" data-url="/entrevistas/${iv.id}/progresso" aria-live="polite"><h2 style="margin-top:0">${esc(JOB_LABEL[live.kind] ?? live.kind)}</h2>
<div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="pfill"></div></div>
<p class="sans" style="margin:.6em 0 0"><strong class="ppct">0%</strong> · <span class="pstep">${esc(live.state === 'queued' ? 'Em fila' : live.progress_label || 'A iniciar')}</span></p>
<p class="hint sans" style="margin:.2em 0 0"><span class="pelapsed"></span> <span class="peta"></span></p>
<p class="hint">Pode fechar esta página: o processamento continua no servidor.</p></div>`;
    }
    if (!live && iv.production_status === 'failed') {
      body += `<div class="card"><h2 style="margin-top:0">Trabalhos</h2><table><tbody>${jobs.map((j: any) => `<tr><td>${esc(j.kind)}</td><td>${pill(j.state, j.state === 'done' ? 'ok' : j.state === 'failed' ? 'bad' : '')}</td><td>${j.progress_total ? `${j.progress_done}/${j.progress_total}` : ''}</td><td class="hint">${esc(j.error ?? '')}</td></tr>`).join('')}</tbody></table>

${iv.production_status === 'failed' ? `<form method="post" action="/entrevistas/${iv.id}/processar"><p class="hint">Falhou. Os erros permanentes exigem revisão; pode tentar novamente depois de corrigir a causa.</p><button class="ghost">Tentar de novo</button></form>` : ''}</div>`;
    }

    // 3. Revisão editorial
    if (script && ['editorial_review', 'generating', 'qc', 'ready', 'stale', 'failed'].includes(iv.production_status)) {
      const segs: any[] = script.segments, flags: any[] = script.review_flags, blocking: string[] = script.blocking_issues;
      const flagged = new Set(flags.map((f: any) => f.segmentId));
      const items = await db.query(`SELECT q.id, q.position, q.text, a.selected_take_id, t.asset_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
      const trs = [];
      for (const it of items) trs.push({ it, a: it.selected_take_id ? await latestTranscript(db, 'answer_take', it.selected_take_id) : null });
      const editable = script.status === 'draft';
      body += `<div class="card"><h2 style="margin-top:0">2. Transcrições (originais)</h2>${iv.production_status === 'stale' ? '<div class="flash bad">As respostas mudaram depois do guião: aprovações invalidadas. Regenere o guião.</div>' : ''}
${trs.map(({ it, a }) => `<div class="seg"><strong>${it.position}. ${esc(it.text)}</strong>${it.asset_id ? `<br><audio controls preload="none" src="/media/${it.asset_id}"></audio>` : ''}
${a ? `<form method="post" action="/entrevistas/${iv.id}/transcricoes/${it.selected_take_id}"><textarea name="text" aria-label="Transcrição">${esc(a.text)}</textarea><button class="ghost">Guardar nova revisão (r${a.revision + 1})</button> <span class="hint">r${a.revision} · ${esc(a.origin)}</span></form>` : '<span class="hint">sem transcrição</span>'}</div>`).join('')}
<form method="post" action="/entrevistas/${iv.id}/guiao/regenerar"><button class="ghost" ${aiAvailable() ? '' : 'disabled'}>Regenerar guião a partir das transcrições</button></form></div>

<div class="card"><h2 style="margin-top:0">3. Guião inglês — revisão ${script.revision} ${pill(script.status, script.status === 'approved' ? 'ok' : script.status === 'stale' ? 'bad' : '')}</h2>
<p class="hint">Título: ${esc(script.title_en)} · modelo ${esc(script.model)} · prompt ${esc(script.prompt_version)}</p>
${blocking.length ? `<div class="flash bad"><strong>Bloqueios editoriais:</strong><ul>${blocking.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/entrevistas/${iv.id}/guiao">
${segs.map((s, i) => `<div class="seg ${s.speakerRole} ${flagged.has(s.id) ? 'flag' : ''}"><span class="hint sans">${esc(s.id)} · ${esc(s.speakerRole)} · ${esc(s.transformationType)}${s.sourceQuestionId ? '' : ' · editorial'}</span>
${flags.filter((f: any) => f.segmentId === s.id).map((f: any) => `<div class="hint" style="color:var(--warn)">⚑ ${esc(f.reason)}</div>`).join('')}
<textarea name="seg_${i}" ${editable ? '' : 'readonly'} aria-label="Segmento ${esc(s.id)}">${esc(s.textEnglish)}</textarea></div>`).join('')}
${editable ? '<button class="ghost">Guardar como nova revisão (humana)</button>' : ''}</form>
${editable ? `<div class="row" style="margin-top:12px"><form method="post" action="/entrevistas/${iv.id}/guiao/verificar"><button class="ghost" ${aiAvailable() ? '' : 'disabled'}>Verificação de fidelidade (assistente)</button></form>
<form method="post" action="/entrevistas/${iv.id}/guiao/aprovar" onsubmit="return confirm('Aprovar este guião para síntese de voz?')"><label class="check"><input type="checkbox" name="reviewed" value="1" required> Revi o guião contra as transcrições</label><button class="accent" ${blocking.length ? 'disabled' : ''}>Aprovar guião para síntese</button></form></div>
<p class="hint">O assistente só assinala possíveis problemas; nunca aprova nem substitui a revisão humana.</p>` : ''}</div>`;

      if (script.status === 'approved' && !running && !['ready', 'qc'].includes(iv.production_status)) {
        const photos = coverOk ? await db.query('SELECT p.id, p.asset_id FROM photos p WHERE p.interview_id=$1', [iv.id]) : [];
        body += `<div class="card"><h2 style="margin-top:0">4. Gerar áudio, legendas e capa</h2>
<form method="post" action="/entrevistas/${iv.id}/gerar" onsubmit="return confirm('Gerar o episódio (operações pagas)?')">
<fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="sans">Línguas das legendas</legend>${SUBS.map(([v, l]) => `<label class="check"><input type="checkbox" name="subtitle_langs" value="${v}" ${iv.subtitle_langs.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</fieldset>
${photos.length ? `<fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="sans">Fotografias na capa (autorizadas; máx. 2)</legend><div class="thumbs">${photos.map((p: any) => `<label class="check"><input type="checkbox" name="cover_photo" value="${p.id}"><img alt="" src="/media/${p.asset_id}"></label>`).join('')}</div></fieldset>` : '<p class="hint">Sem fotografias autorizadas para a capa: será usada capa tipográfica sobre fundo ilustrado.</p>'}
<p class="hint">Vozes: entrevistador ${iv.question_voice === 'male' ? 'masculina' : 'feminina'} (“${esc(episodeVoice('host', iv.question_voice))}”), entrevistado ${iv.guest_voice === 'male' ? 'masculina' : 'feminina'} (“${esc(episodeVoice('guest', iv.guest_voice))}”) — altere em Editar. Vozes sintéticas de catálogo; sem clonagem. Será acrescentado o aviso audível: “${esc(config.aiDisclosure)}”</p>
<button class="accent">Gerar episódio</button></form></div>`;
      }
    }

    // 4. Episódio
    if (ep) {
      const issues: string[] = ep.technical?.qcIssues ?? [];
      const hostAp = await db.one(`SELECT * FROM approvals WHERE episode_id=$1 AND actor='interviewer' AND valid AND decision='approved'`, [ep.id]);
      const guestAp = await db.one(`SELECT * FROM approvals WHERE episode_id=$1 AND actor='guest' AND valid ORDER BY created_at DESC LIMIT 1`, [ep.id]);
      const needGuest = iv.review_policy === 'guest_preview';
      const guestOk = !needGuest || guestAp?.decision === 'approved';
      const canPublish = !!hostAp && guestOk && pubOk && !ep.stale && issues.length === 0 && ep.status !== 'published';
      body += `<div class="card"><h2 style="margin-top:0">5. Episódio ${pill(ep.status, ep.status === 'published' ? 'ok' : '')} ${ep.stale ? pill('desatualizado', 'bad') : ''}</h2>
${playerHtml(ep, { audio: `/media/${ep.audio_asset_id}`, cover: `/media/${ep.cover_asset_id}`, subs: (l, x) => `/entrevistas/${iv.id}/subs/${l}.${x}` }, { host: iv.host_name, guest: iv.guest_name })}
<p class="hint sans">Pico máx.: ${ep.technical?.maxVolumeDb ?? '—'} dB · clipping: ${ep.technical?.clipping ? 'SIM' : 'não'}${ep.technical?.mock ? ' · <strong>gerado em modo simulado (AI_MOCK)</strong>' : ''}</p>
${issues.length ? `<div class="flash bad"><strong>Controlo de qualidade:</strong><ul>${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>Corrija e regenere antes de publicar.</div>` : ''}
<h3>Aprovações</h3><table class="sans"><tbody>
<tr><td>Entrevistador</td><td>${hostAp ? pill('aprovou esta versão', 'ok') : pill('pendente')}</td><td>${!hostAp && !ep.stale ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/aprovar"><button class="ghost">Aprovar esta versão</button></form>` : ''}</td></tr>
${needGuest ? `<tr><td>Entrevistado</td><td>${guestAp ? pill(guestAp.decision === 'approved' ? 'aprovou' : 'pediu alterações', guestAp.decision === 'approved' ? 'ok' : 'bad') : pill('pendente')} ${guestAp?.note ? esc(guestAp.note) : ''}</td>
<td><form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/enviar-previa"><button class="ghost">Enviar pré-visualização</button></form></td></tr>` : ''}</tbody></table>
<h3>Vídeo do podcast</h3>
${ep.video_asset_id ? `<video controls preload="metadata" poster="/media/${ep.cover_asset_id}" src="/media/${ep.video_asset_id}" style="width:100%;max-width:720px;border-radius:10px;background:#000"></video>
<p class="sans"><a class="btn" href="/entrevistas/${iv.id}/episodio/${ep.id}/video.mp4" download>Descarregar vídeo (MP4)</a> <span class="hint">Legendas: ${esc(ep.video_lang ?? 'sem legendas')}</span></p>` : '<p class="hint">Ainda não foi gerado.</p>'}
${!ep.stale ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/video" class="row" onsubmit="return confirm('Gerar o vídeo?')"><label for="vl" style="margin:0">Legendas no vídeo</label><select id="vl" name="lang" style="width:auto">${Object.keys(ep.subtitles ?? {}).map(l => `<option value="${esc(l)}" ${l === (ep.video_lang ?? 'pt-PT') ? 'selected' : ''}>${esc(l)}</option>`).join('')}<option value="">Sem legendas</option></select><button class="ghost">${ep.video_asset_id ? 'Gerar de novo' : 'Gerar vídeo'}</button></form>
<p class="hint">Capa durante a introdução e o agradecimento final; composição de estúdio com as duas fotografias autorizadas na primeira pergunta; depois, grande plano de quem fala. As legendas ficam gravadas na imagem, numa só língua. Só entram fotografias autorizadas (a do convidado exige autorização de publicação).</p>` : ''}
${!pubOk ? '<div class="flash bad">O entrevistado não autorizou a publicação.</div>' : ''}
${ep.status !== 'published' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/publicar" onsubmit="return confirm('Publicar agora?')"><label for="vis">Modalidade</label><select id="vis" name="visibility"><option value="private">Privado (só pessoas autorizadas)</option><option value="unlisted" ${iv.planned_visibility === 'unlisted' ? 'selected' : ''}>Não listado (quem tem o link; não equivale a privado)</option><option value="public" ${iv.planned_visibility === 'public' ? 'selected' : ''}>Público (indexável)</option></select>
<fieldset style="border:1px solid var(--line);border-radius:8px;margin-top:12px"><legend class="sans">Galeria pública «Podcasts gerados»</legend>
<label class="check"><input type="checkbox" name="gallery" value="1"> Permito que este episódio fique na galeria pública do portal, para consulta, organizada por temas (só para episódios públicos).</label>
<label for="th">Tema</label><input id="th" name="theme" type="text" list="themes" maxlength="60" placeholder="Ex.: Energia, Telecomunicações, Hotelaria"><datalist id="themes">${(await db.query(`SELECT DISTINCT theme FROM episodes WHERE theme<>'' ORDER BY theme`)).map((t: any) => `<option value="${esc(t.theme)}">`).join('')}</datalist></fieldset>
<p><button class="accent" ${canPublish ? '' : 'disabled'}>Publicar</button></p>${canPublish ? '' : '<p class="hint">Publicar exige: aprovação válida do entrevistador' + (needGuest ? ' e do entrevistado' : '') + ', autorização de publicação, versão atual e sem alertas de qualidade.</p>'}</form>`
  : `<p class="sans">Publicado (${esc(ep.visibility)}) em ${fmtDate(ep.published_at)}${ep.visibility !== 'private' ? ` · <a href="/e/${ep.slug}">/e/${esc(ep.slug)}</a>` : ''}</p>
${ep.visibility === 'public' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/galeria" class="card"><strong class="sans">Galeria pública «Podcasts gerados»</strong>
<label class="check"><input type="checkbox" name="gallery" value="1" ${ep.gallery ? 'checked' : ''}> Mostrar na galeria pública, organizada por temas</label>
<label for="th2">Tema</label><input id="th2" name="theme" type="text" maxlength="60" value="${esc(ep.theme)}"><button class="ghost">Guardar</button></form>` : ''}
<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/retirar" onsubmit="return confirm('Retirar o episódio?')"><button class="danger">Retirar episódio</button></form>
<p class="hint">Cópias já descarregadas ou distribuídas externamente podem não ser recuperáveis.</p>`}</div>`;
    }
    body += '</div>';
    return reply.type('text/html; charset=utf-8').send(page({ title: 'Produção', body, noindex: true, script: live ? '/static/progress.js' : '/static/player.js', nav: `<a href="/painel">Painel</a>` }));
  });

  // Estado dos trabalhos em JSON, para a barra de progresso (só o dono/admin).
  app.get('/entrevistas/:id/progresso', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'session' });
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send({ error: 'not found' });
    const j = await db.one(`SELECT kind, state, progress_done, progress_total, progress_label, started_at, created_at, error, now() AS server_now FROM jobs
      WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1`, [iv.id]);
    reply.header('Cache-Control', 'no-store');
    if (!j) return { active: false };
    const total = Number(j.progress_total) || 0, done = Math.min(Number(j.progress_done) || 0, total);
    const elapsedSec = j.started_at ? Math.max(0, (new Date(j.server_now).getTime() - new Date(j.started_at).getTime()) / 1000) : 0;
    // Estimativa pelo ritmo observado; só a partir de 5% feito, para não dar números absurdos no arranque.
    const etaSec = j.state === 'running' && total && done / total >= 0.05 ? Math.round((elapsedSec / done) * (total - done)) : null;
    return { active: ['queued', 'running'].includes(j.state), kind: j.kind, title: JOB_LABEL[j.kind] ?? j.kind, state: j.state, percent: total ? Math.round((done / total) * 100) : 0,
      label: j.state === 'queued' ? 'Em fila' : j.progress_label, elapsedSec: Math.round(elapsedSec), etaSec, error: j.state === 'failed' ? j.error : null };
  });

  // ---- ações ----
  app.post('/entrevistas/:id/processar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    if (iv.collection_status !== 'submitted') return back(reply, iv.id, undefined, 'A entrevista não foi submetida.');
    if (!(await consent(iv.id, 'processing'))) return back(reply, iv.id, undefined, 'Sem autorização de processamento por IA.');
    if (!aiAvailable()) return back(reply, iv.id, undefined, 'Serviço de IA não configurado.');
    const sub = await db.one('SELECT id FROM submissions WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1', [iv.id]);
    const est = await estimateCost(db, iv.id, iv.subtitle_langs);
    // Deduplica por submissão; "tentar de novo" após falha usa nova chave com o nº de tentativas anteriores.
    const prior = Number((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='process_submission'`, [iv.id])).n);
    const id = await enqueue(db, { kind: 'process_submission', interviewId: iv.id, dedupe: `process:${sub.id}:${prior}`, costUsd: est.usd });
    if (id) { await db.query(`UPDATE interviews SET production_status='queued' WHERE id=$1`, [iv.id]); await audit(db, req.user!.email, 'production.requested', iv.id, { estimateUsd: est.usd }); }
    return back(reply, iv.id, 'Processamento iniciado.');
  });

  app.post('/entrevistas/:id/transcricoes/:takeId', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const takeId = (req.params as any).takeId;
    const own = await db.one(`SELECT 1 FROM answer_takes t JOIN answers a ON a.id=t.answer_id WHERE t.id=$1 AND a.interview_id=$2`, [takeId, iv.id]);
    const cur = own && await latestTranscript(db, 'answer_take', takeId);
    const text = String((req.body as any)?.text ?? '').trim().slice(0, 20000);
    if (cur && text && text !== cur.text) {
      await db.query(`INSERT INTO transcripts(interview_id, source_kind, source_id, revision, text, language, origin) VALUES ($1,'answer_take',$2,$3,$4,$5,'human')`, [iv.id, takeId, cur.revision + 1, text, cur.language]);
      // Alteração material: invalida aprovações e marca derivados como desatualizados (sem apagar versões).
      await db.query(`UPDATE scripts SET status='stale' WHERE interview_id=$1 AND status IN ('draft','approved')`, [iv.id]);
      await db.query(`UPDATE approvals SET valid=false WHERE interview_id=$1 AND valid`, [iv.id]);
      await db.query(`UPDATE episodes SET stale=true WHERE interview_id=$1`, [iv.id]);
      await audit(db, req.user!.email, 'transcript.revised', iv.id);
    }
    return back(reply, iv.id, 'Transcrição guardada. Regenere o guião para a refletir.');
  });

  app.post('/entrevistas/:id/guiao/regenerar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    if (!aiAvailable()) return back(reply, iv.id, undefined, 'Serviço de IA não configurado.');
    const n = Number((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='prepare_script'`, [iv.id])).n);
    await enqueue(db, { kind: 'prepare_script', interviewId: iv.id, dedupe: `prep:${iv.id}:${n}` });
    await db.query(`UPDATE interviews SET production_status='queued' WHERE id=$1`, [iv.id]);
    return back(reply, iv.id, 'Guião em regeneração.');
  });

  app.post('/entrevistas/:id/guiao', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const s = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    if (!s) return back(reply, iv.id, undefined, 'Sem guião editável.');
    const b = req.body as any;
    const segs = (s.segments as any[]).map((x, i) => ({ ...x, textEnglish: String(b[`seg_${i}`] ?? x.textEnglish).trim() }));
    if (segs.every((x, i) => x.textEnglish === s.segments[i].textEnglish)) return back(reply, iv.id, 'Sem alterações.');
    const v = validateScript({ titleEnglish: s.title_en, segments: segs, reviewFlags: s.review_flags, blockingIssues: [] });
    await db.query(`UPDATE scripts SET status='superseded' WHERE id=$1`, [s.id]);
    await db.query(`INSERT INTO scripts(interview_id, revision, title_en, segments, review_flags, blocking_issues, status, prompt_version, model, origin) VALUES ($1,$2,$3,$4,$5,$6,'draft',$7,$8,'human')`,
      [iv.id, s.revision + 1, s.title_en, JSON.stringify(v.segments), JSON.stringify(v.reviewFlags), JSON.stringify(v.blockingIssues), s.prompt_version, s.model]);
    await db.query(`UPDATE approvals SET valid=false WHERE interview_id=$1 AND valid`, [iv.id]);
    await audit(db, req.user!.email, 'script.revised', iv.id);
    return back(reply, iv.id, `Revisão ${s.revision + 1} guardada.`);
  });

  app.post('/entrevistas/:id/guiao/verificar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    if (!rateLimit(`review:${iv.id}`, 6, 3600_000)) return back(reply, iv.id, undefined, 'Limite de verificações atingido.');
    const s = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    if (!s) return back(reply, iv.id, undefined, 'Sem guião editável.');
    const items = await db.query(`SELECT q.id, q.text, a.selected_take_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    const tr = [];
    for (const it of items) tr.push({ questionId: it.id, question: it.text, answer: it.selected_take_id ? (await latestTranscript(db, 'answer_take', it.selected_take_id))?.text : null });
    try {
      const r = await reviewScript(tr, s.segments);
      const flags = [...s.review_flags, ...r.issues.map((i: any) => ({ segmentId: String(i.scriptSegmentId), reason: `[${i.severity}] ${i.explanation}` }))];
      await db.query('UPDATE scripts SET review_flags=$2 WHERE id=$1', [s.id, JSON.stringify(flags)]);
      return back(reply, iv.id, r.issues.length ? `${r.issues.length} possíveis problemas assinalados.` : 'Sem alertas — isto não substitui a revisão humana.');
    } catch (e: any) { return back(reply, iv.id, undefined, 'Falha na verificação: ' + String(e.message).slice(0, 120)); }
  });

  app.post('/entrevistas/:id/guiao/aprovar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const s = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    if (!s || s.blocking_issues.length || !(req.body as any)?.reviewed) return back(reply, iv.id, undefined, 'Não é possível aprovar (bloqueios ou revisão não confirmada).');
    if (!(await consent(iv.id, 'processing'))) return back(reply, iv.id, undefined, 'Autorização de processamento retirada.');
    await db.query(`UPDATE scripts SET status='approved', approved_at=now() WHERE id=$1`, [s.id]);
    await db.query(`INSERT INTO approvals(interview_id, kind, actor, script_id, decision) VALUES ($1,'script','interviewer',$2,'approved')`, [iv.id, s.id]);
    await audit(db, req.user!.email, 'script.approved', iv.id, { revision: s.revision });
    return back(reply, iv.id, 'Guião aprovado para síntese.');
  });

  app.post('/entrevistas/:id/gerar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const s = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='approved' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    if (!s) return back(reply, iv.id, undefined, 'Aprove primeiro o guião.');
    const b = req.body as any;
    const langs = ([] as string[]).concat(b.subtitle_langs ?? []).filter(l => SUBS.some(x => x[0] === l));
    const photos = ([] as string[]).concat(b.cover_photo ?? []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 2);
    const cfg = sha256(JSON.stringify([langs.sort(), photos.sort(), config.openai.voices, config.openai.models]));
    const est = await estimateCost(db, iv.id, langs.length ? langs : iv.subtitle_langs);
    const id = await enqueue(db, { kind: 'generate_episode', interviewId: iv.id, input: { scriptId: s.id, subtitleLangs: langs, coverPhotoIds: photos }, dedupe: `gen:${s.id}:${cfg}`, costUsd: est.parts.speech + est.parts.text + est.parts.cover });
    if (!id) return back(reply, iv.id, undefined, 'Já existe uma geração com esta configuração para este guião. Altere o guião ou a configuração.');
    await db.query(`UPDATE interviews SET production_status='queued' WHERE id=$1`, [iv.id]);
    await audit(db, req.user!.email, 'episode.generate', iv.id);
    return back(reply, iv.id, 'Geração iniciada.');
  });

  const epGuard = async (req: any, reply: any) => {
    const iv = await guard(req, reply); if (!iv) return null;
    const ep = await db.one('SELECT * FROM episodes WHERE id=$2 AND interview_id=$1', [iv.id, req.params.eid]);
    if (!ep) { reply.code(404).send(); return null; }
    return { iv, ep };
  };

  app.post('/entrevistas/:id/episodio/:eid/aprovar', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    if (c.ep.stale) return back(reply, c.iv.id, undefined, 'Versão desatualizada.');
    await db.query(`UPDATE approvals SET valid=false WHERE episode_id=$1 AND actor='interviewer'`, [c.ep.id]);
    await db.query(`INSERT INTO approvals(interview_id, kind, actor, episode_id, script_id, decision) VALUES ($1,'episode','interviewer',$2,$3,'approved')`, [c.iv.id, c.ep.id, c.ep.script_id]);
    return back(reply, c.iv.id, 'Versão aprovada.');
  });

  app.post('/entrevistas/:id/episodio/:eid/enviar-previa', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    if (!rateLimit(`prev:${c.iv.id}`, 3, 3600_000)) return back(reply, c.iv.id, undefined, 'Aguarde antes de reenviar.');
    // Novo link pessoal ao email original; o convidado vê a pré-visualização na sua área.
    const inv = await createInvitation(db, c.iv, { name: req.user!.name }, { preview: true });
    void inv;
    await audit(db, req.user!.email, 'episode.preview_sent', c.iv.id);
    return back(reply, c.iv.id, 'Pré-visualização enviada ao entrevistado.');
  });

  app.post('/entrevistas/:id/episodio/:eid/publicar', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    const { iv, ep } = c;
    const vis = ['private', 'unlisted', 'public'].includes((req.body as any)?.visibility) ? (req.body as any).visibility : 'private';
    const hostAp = await db.one(`SELECT 1 FROM approvals WHERE episode_id=$1 AND actor='interviewer' AND valid AND decision='approved'`, [ep.id]);
    const guestAp = await db.one(`SELECT decision FROM approvals WHERE episode_id=$1 AND actor='guest' AND valid ORDER BY created_at DESC LIMIT 1`, [ep.id]);
    const issues: string[] = ep.technical?.qcIssues ?? [];
    const ok = hostAp && (iv.review_policy !== 'guest_preview' || guestAp?.decision === 'approved') && (await consent(iv.id, 'publish')) && !ep.stale && !issues.length && ep.status === 'preview';
    if (!ok) { await audit(db, req.user!.email, 'episode.publish_blocked', iv.id); return back(reply, iv.id, undefined, 'Publicação bloqueada: faltam aprovações válidas, autorização ou a versão está desatualizada.'); }
    const b = req.body as any;
    const theme = String(b?.theme ?? '').trim().slice(0, 60);
    await db.query(`UPDATE episodes SET status='published', visibility=$2, published_at=now(), withdrawn_at=NULL, gallery=$3, theme=$4 WHERE id=$1`, [ep.id, vis, vis === 'public' && !!b?.gallery, theme]);
    await db.query(`UPDATE interviews SET publication_status='published' WHERE id=$1`, [iv.id]);
    await audit(db, req.user!.email, 'episode.published', iv.id, { visibility: vis, episodeId: ep.id });
    return back(reply, iv.id, vis === 'private' ? 'Guardado como privado.' : 'Publicado.');
  });

  app.post('/entrevistas/:id/episodio/:eid/video', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    if (c.ep.stale) return back(reply, c.iv.id, undefined, 'Versão desatualizada.');
    const lang = String((req.body as any)?.lang ?? '');
    const n = Number((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='render_video'`, [c.iv.id])).n);
    await enqueue(db, { kind: 'render_video', interviewId: c.iv.id, input: { episodeId: c.ep.id, lang: lang && c.ep.subtitles?.[lang] ? lang : null }, dedupe: `video:${c.ep.id}:${n}` });
    await audit(db, req.user!.email, 'episode.video_requested', c.iv.id, { lang });
    return back(reply, c.iv.id, 'Geração do vídeo iniciada.');
  });

  app.get('/entrevistas/:id/episodio/:eid/video.mp4', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    const a = c.ep.video_asset_id && await db.one('SELECT * FROM assets WHERE id=$1 AND deleted_at IS NULL', [c.ep.video_asset_id]);
    if (!a) return reply.code(404).send('Vídeo ainda não gerado');
    return sendAsset(req, reply, a, { download: `${c.ep.slug}.mp4` });
  });

  app.post('/entrevistas/:id/episodio/:eid/galeria', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    const b = req.body as any;
    const on = !!b.gallery && c.ep.status === 'published' && c.ep.visibility === 'public';
    await db.query('UPDATE episodes SET gallery=$2, theme=$3 WHERE id=$1', [c.ep.id, on, String(b.theme ?? '').trim().slice(0, 60)]);
    await audit(db, req.user!.email, on ? 'episode.gallery_on' : 'episode.gallery_off', c.iv.id);
    return back(reply, c.iv.id, on ? 'Episódio visível na galeria pública.' : 'Episódio fora da galeria.');
  });

  app.post('/entrevistas/:id/episodio/:eid/retirar', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    await db.query(`UPDATE episodes SET status='withdrawn', withdrawn_at=now(), gallery=false WHERE id=$1`, [c.ep.id]);
    await db.query(`UPDATE interviews SET publication_status='withdrawn' WHERE id=$1`, [c.iv.id]);
    await audit(db, req.user!.email, 'episode.withdrawn', c.iv.id);
    return back(reply, c.iv.id, 'Episódio retirado.');
  });
  void queueEmail; void emailShell; void fmtDuration;
}
