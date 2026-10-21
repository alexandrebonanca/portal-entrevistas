import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate, fmtDuration, sha256, rateLimit } from '../lib.ts';
import { page, flash, pill, STATUS_LABEL } from '../views.ts';
import { requireUser, ownedInterview, audit, sendAsset } from '../app.ts';
import { enqueue, videoQueue, laneOf, type EnqueueOpts } from '../jobs.ts';
import type { Db } from '../db.ts';
import { regenerationsUsed, REGEN_BLOCKED } from '../limits.ts';
import { estimateCost, latestTranscript, animationEstimate } from '../pipeline.ts';
import { aiAvailable, reviewScript, validateScript, episodeVoice } from '../ai/openai.ts';
import { playerHtml } from './episode.ts';
import { createInvitation } from '../invites.ts';
import { queueEmail, emailShell } from '../mail.ts';
import { veoEstimate, clipModelsNote, veoWithoutQuote, VEO_ONLY_PREVIEW, VIDEO_ONLY_PREVIEW, VEO_CHANGES, VEO_SCRIPT_REPLACED, VEO_NO_CREDENTIALS, VEO_NEEDS_QUOTE } from '../veo-episode.ts';
import { veoConfigured, veoTier, veoLabel } from '../talking.ts';
import { inEntity, entityOfInterview } from '../settings.ts';
import { guestMustApprove, videoMeta as loadVideoMeta } from '../approval.ts';
import { walletFor, findWallet, spend, spendBlock, cr, EXTRA_REGEN_CENTS, type Wallet } from '../wallet.ts';
import { paidConsentHtml, paidConsentOk, isConsumer } from './credits.ts';
import { quoteSection } from './quotes.ts';

/** Os retratos animados (Replicate) ficam reservados ao administrador. */
const ANIMATE_ADMIN_ONLY = 'Os retratos animados por IA (Replicate) estão reservados ao administrador. A animação com o Google Veo faz-se por orçamento, na secção «Animação por IA».';

/** Trabalho em pausa (volta à fila mais tarde, ex.: a aguardar quota da Google): mostra-se o motivo em vez de «Em fila». */
const paused = (j: any) => j.state === 'queued' && !!j.progress_label && new Date(j.run_after).getTime() > (j.server_now ? new Date(j.server_now).getTime() : Date.now());
const JOB_LABEL: Record<string, string> = { render_video: 'A gerar o vídeo do podcast', process_submission: 'A transcrever e a preparar o guião', prepare_script: 'A preparar o guião', generate_episode: 'A gerar o episódio', transcribe_asset: 'A transcrever' };
const SUBS = [['en', 'English'], ['pt-PT', 'Português (PT)'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']];


/** Porque é que ainda não se pode pedir a validação ao convidado (null = pode). */
const previewBlock = (iv: any, ep: any, vmeta: any): string | null =>
  !guestMustApprove(iv, vmeta) ? 'Com «só o entrevistador aprova», o entrevistado só valida um vídeo em que apareça animado por IA.'
  : ep.stale ? 'Versão desatualizada: regenere o guião e o episódio antes de pedir a validação.'
  : ep.status === 'published' ? 'O episódio já está publicado: a validação pede-se antes de publicar.'
  : ep.status !== 'preview' ? 'O episódio não está em pré-visualização (foi retirado): a validação pede-se antes de publicar.'
  : iv.collection_status === 'cancelled' || iv.collection_status === 'expired' ? `A entrevista está ${iv.collection_status === 'cancelled' ? 'cancelada' : 'expirada'}: não é possível pedir a validação.`
  : iv.collection_status !== 'submitted' ? 'O entrevistado ainda tem perguntas por responder: envie a pré-visualização depois de ele as submeter.'
  : null;

/**
 * Porque é que o episódio não se pode publicar agora (null = pode): o mesmo motivo na página e na recusa. Um episódio
 * retirado não volta a ser publicado; com um vídeo a ser gerado, espera-se por ele (só entra antes da publicação).
 */
export function publishBlock(o: { ep: any; pubOk: boolean; videoBusy: boolean; hostAp: boolean; needGuest: boolean; guestAp: any }): string | null {
  const { ep, guestAp } = o;
  if (ep.status === 'published') return 'O episódio já está publicado.';
  if (ep.status === 'withdrawn') return 'Este episódio foi retirado e não volta a ser publicado. Para publicar uma nova versão, regenere o guião ou recomece a produção.';
  if (ep.status !== 'preview') return 'Esta versão do episódio foi substituída por outra.';
  if (ep.stale) return 'Versão desatualizada: as respostas ou as transcrições mudaram depois do episódio; regenere o guião e o episódio.';
  if ((ep.technical?.qcIssues ?? []).length) return 'Há alertas do controlo de qualidade: corrija e regenere o episódio antes de publicar.';
  if (!o.pubOk) return 'O entrevistado não autorizou a publicação.';
  if (o.videoBusy) return 'Há um vídeo a ser gerado para este episódio: publique depois de ele terminar e de o rever.';
  if (!o.hostAp) return `Falta a sua aprovação desta versão${ep.video_asset_id ? ' (com o vídeo atual)' : ''}.`;
  if (o.needGuest) {
    if (!guestAp) return 'Falta a aprovação do entrevistado: envie-lhe a pré-visualização.';
    if (guestAp.decision !== 'approved') return 'O entrevistado pediu alterações a esta versão.';
    if (String(guestAp.video_asset_id ?? '') !== String(ep.video_asset_id ?? '')) return 'O entrevistado aprovou uma versão anterior do vídeo: envie-lhe de novo a pré-visualização.';
  }
  return null;
}

export async function productionRoutes(app: FastifyInstance) {
  const db = app.db;
  const consent = async (id: string, p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [id, p]))?.granted;
  /** Vídeo deste episódio na fila ou a ser gerado (pedido direto, orçamento ou reconstrução). */
  const videoBusy = async (ivId: string, epId: string) =>
    !!(await db.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind='render_video' AND state IN ('queued','running') AND input->>'episodeId'=$2 LIMIT 1`, [ivId, epId]));

  const guard = async (req: any, reply: any) => {
    if (!requireUser(req, reply)) return null;
    const iv = await ownedInterview(app, req, req.params.id);
    if (!iv) { reply.code(404).send('Não encontrada'); return null; }
    return iv;
  };
  const back = (reply: any, id: string, ok?: string, e?: string) =>
    reply.redirect(`/entrevistas/${id}/producao${ok ? '?ok=' + encodeURIComponent(ok) : e ? '?e=' + encodeURIComponent(e) : ''}`);

  // ---- regenerações do guião e do episódio: 3 incluídas por entrevista; as seguintes custam 1 crédito (o administrador não tem limite) ----
  const INCLUDED = config.limits.includedRegenerations;
  const REGEN_NOTE: Record<string, string> = { process_submission: 'Regeneração extra: processar de novo', prepare_script: 'Regeneração extra do guião', generate_episode: 'Regeneração extra do episódio' };
  class NoFunds extends Error {}
  /** Saldo do dono para pagar uma regeneração extra: carteira da entidade dele, bloqueios e se é consumidor. */
  const regenPayment = async (user: any) => {
    const w = await findWallet(db, user.id, user.entity_id);
    const available = w?.available_cents ?? 0, blk = spendBlock(w);
    return { available, block: blk?.pt ?? null, consumer: await isConsumer(db, user.id), canPay: !blk && available >= EXTRA_REGEN_CENTS, missing: Math.max(0, EXTRA_REGEN_CENTS - available) };
  };
  /** Já houve um guião nesta entrevista (processar de novo, depois de «Recomeçar», é uma regeneração). */
  const hadScript = async (q: Db, id: string) => !!(await q.one('SELECT 1 FROM scripts WHERE interview_id=$1 LIMIT 1', [id]));
  /** Já houve um episódio gerado (ou a gerar) nesta entrevista. */
  const hadEpisode = async (q: Db, id: string) => !!(await q.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind='generate_episode' AND state<>'failed' LIMIT 1`, [id]));
  /** Regenerações esgotadas para quem pede (o administrador nunca fica bloqueado). */
  const regenExhausted = async (req: any, id: string) => req.user.role !== 'admin' && (await regenerationsUsed(db, id)) >= INCLUDED;
  /**
   * Põe um trabalho de produção na fila com a entrevista bloqueada (dois cliques em simultâneo não passam o limite).
   * Se for uma regeneração pedida por quem não é administrador, conta para as incluídas; a partir da 4.ª só com o pedido
   * expresso de pagar 1 crédito, cobrado na mesma transação (e devolvido se o trabalho falhar).
   */
  const enqueueProduction = (req: any, id: string, kind: string, isRegen: (tx: Db, iv: any) => Promise<boolean>, opts: (tx: Db) => Promise<Omit<EnqueueOpts, 'kind' | 'interviewId'>>) =>
    db.tx(async (tx): Promise<{ id?: string; blocked?: string; busy?: boolean; paid?: boolean }> => {
      const iv = await tx.one('SELECT * FROM interviews WHERE id=$1 FOR UPDATE', [id]);
      // Um de cada vez: um segundo clique não cria (nem conta) outra regeneração.
      if (await tx.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind=$2 AND state IN ('queued','running') LIMIT 1`, [id, kind])) return { busy: true };
      const counted = req.user.role !== 'admin' && await isRegen(tx, iv);
      let w: Wallet | null = null;
      if (counted && (await regenerationsUsed(tx, id)) >= INCLUDED) {
        // Para além das incluídas: 1 crédito do dono, cobrado na mesma transação e só com o pedido expresso de pagar.
        const b = req.body ?? {};
        w = await walletFor(tx, req.user.id, req.user.entity_id);
        if (b.pagar !== '1') return { blocked: `${REGEN_BLOCKED()} Saldo: ${cr(w.available_cents)} créditos.` };
        if (!paidConsentOk(b, await isConsumer(tx, req.user.id))) return { blocked: 'Para começar já, confirme o pedido de início imediato do serviço e o reconhecimento sobre a livre resolução.' };
        const blk = spendBlock(w);
        if (blk) return { blocked: blk.pt };
        if (w.available_cents < EXTRA_REGEN_CENTS) return { blocked: `${REGEN_BLOCKED()} Saldo insuficiente (${cr(w.available_cents)} créditos): carregue créditos em Créditos.` };
      }
      const o = await opts(tx);
      const jobId = await enqueue(tx, { ...o, kind, interviewId: id, input: { ...(o.input ?? {}), ...(counted ? { regen: true } : {}), ...(w ? { paidCents: EXTRA_REGEN_CENTS } : {}) } });
      // Cobrança única por trabalho; se o trabalho falhar, o crédito volta (pipeline __onFail e trabalho periódico das carteiras).
      if (jobId && w && !(await spend(tx, w.id, EXTRA_REGEN_CENTS, { ref: `regen:${jobId}`, note: REGEN_NOTE[kind] ?? 'Regeneração extra', interviewId: id, jobId, actor: req.user.email }))) throw new NoFunds();
      return { id: jobId, paid: !!(jobId && w) };
    }).catch((e) => { if (e instanceof NoFunds) return { blocked: `${REGEN_BLOCKED()} Saldo insuficiente: carregue créditos em Créditos.` }; throw e; });
  const BUSY = 'Já há um trabalho de produção igual em curso; aguarde que termine.';

  app.get('/entrevistas/:id/producao', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const q = req.query as any;
    const submitted = iv.collection_status === 'submitted';
    const [procOk, coverOk, pubOk] = await Promise.all([consent(iv.id, 'processing'), consent(iv.id, 'cover_use'), consent(iv.id, 'publish')]);
    const jobs = await db.query(`SELECT * FROM jobs WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 8`, [iv.id]);
    const script = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status<>'superseded' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND status<>'superseded' AND NOT (status='withdrawn' AND stale) ORDER BY created_at DESC LIMIT 1`, [iv.id]);
    const ledger = await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS usd FROM usage_ledger WHERE interview_id=$1 AND kind<>'veo_usd_failed'`, [iv.id]); // operações falhadas na Google à parte
    const est = submitted ? await estimateCost(db, iv.id, iv.subtitle_langs) : null;
    const running = jobs.some((j: any) => ['queued', 'running'].includes(j.state));
    // Contador das regenerações (guião e episódio) e o que fica travado quando as incluídas se esgotam.
    const regen = await regenerationsUsed(db, iv.id);
    const exhausted = req.user!.role !== 'admin' && regen >= INCLUDED;
    const [scriptBefore, episodeBefore] = exhausted ? [await hadScript(db, iv.id), await hadEpisode(db, iv.id)] : [false, false];
    // Regenerações esgotadas: a seguinte paga-se com 1 crédito (botão com o valor e, para consumidores, as duas caixas).
    const pay = exhausted ? await regenPayment(req.user) : null;
    const regenHint = pay ? `<p class="hint">${esc(REGEN_BLOCKED())} Saldo: ${cr(pay.available)} créditos.${pay.block ? ` ${esc(pay.block)}` : !pay.canPay ? ` <a href="/conta/creditos/carregar?falta=${pay.missing}&amp;voltar=${encodeURIComponent(`/entrevistas/${iv.id}/producao`)}">Carregar créditos</a>` : ''}</p>` : '';
    const payFields = pay?.canPay ? `<input type="hidden" name="pagar" value="1">${paidConsentHtml(pay.consumer)}` : '';
    const PAY = ` — pagar ${cr(EXTRA_REGEN_CENTS)} crédito`;
    const canRegen = !exhausted || !!pay?.canPay;
    let body = `<div class="wrap" style="padding-top:32px"><p><a href="/entrevistas/${iv.id}">← ${esc(iv.title)}</a></p><h1>Produção do podcast</h1>${flash(q.ok)}${flash(q.e, 'bad')}
<p class="sans">${pill(STATUS_LABEL[iv.production_status] ?? iv.production_status)} ${pill(STATUS_LABEL[iv.publication_status] ?? iv.publication_status)} · Utilização registada (estimativa): <strong>$${ledger.usd.toFixed(2)}</strong>
· Regenerações do guião e do episódio: <strong id="regen">${regen} de ${INCLUDED}</strong> incluídas${req.user!.role === 'admin' ? ' (o administrador não tem limite e as dele não contam)' : ''}</p>`;

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
${scriptBefore ? payFields : ''}<button class="accent" ${procOk && aiAvailable() && (!scriptBefore || canRegen) ? '' : 'disabled'}>Processar podcast${scriptBefore ? PAY : ''}</button></form>${scriptBefore ? regenHint : ''}</div>`;
    }

    // 2. Progresso
    const live = jobs.find((j: any) => ['queued', 'running'].includes(j.state));
    if (live) {
      body += `<div class="card" id="progress" data-url="/entrevistas/${iv.id}/progresso" aria-live="polite"><h2 style="margin-top:0">${esc(JOB_LABEL[live.kind] ?? live.kind)}</h2>
<div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="pfill"></div></div>
<p class="sans" style="margin:.6em 0 0"><strong class="ppct">0%</strong> · <span class="pstep">${esc(live.state === 'queued' ? (paused(live) ? live.progress_label : 'Em fila') : live.progress_label || 'A iniciar')}</span></p>
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
<form method="post" action="/entrevistas/${iv.id}/guiao/regenerar">${exhausted ? payFields : ''}<button class="ghost" ${aiAvailable() && canRegen ? '' : 'disabled'}>Regenerar guião a partir das transcrições${exhausted ? PAY : ''}</button></form>${exhausted ? regenHint : ''}</div>

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
${episodeBefore ? payFields : ''}<button class="accent" ${episodeBefore && !canRegen ? 'disabled' : ''}>Gerar episódio${episodeBefore ? PAY : ''}</button>${episodeBefore ? regenHint : ''}</form></div>`;
      }
    }

    // 4. Episódio
    if (ep) {
      const issues: string[] = ep.technical?.qcIssues ?? [];
      const animOk = await consent(iv.id, 'animate_portrait') && await consent(iv.id, 'publish_photo');
      const veoOk = await consent(iv.id, 'ai_video') && await consent(iv.id, 'publish_photo');
      const ent = await entityOfInterview(db, iv.id);
      // Pronto com conta de serviço do Vertex AI OU chave da Gemini API; nível (Fast/Lite) e preço da entidade, se os tiver.
      const veoKey = config.openai.mock || inEntity(ent, () => veoConfigured());
      const tier = inEntity(ent, () => veoTier());
      const openaiKey = inEntity(ent, () => aiAvailable());
      const lastVideoJob = await db.one(`SELECT state, error FROM jobs WHERE interview_id=$1 AND kind='render_video' AND input->>'episodeId'=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, ep.id]);
      const veoSpent = Number((await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS usd FROM usage_ledger WHERE interview_id=$1 AND kind='veo_usd'`, [iv.id]))?.usd ?? 0);
      const veoFailed = Number((await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS usd FROM usage_ledger WHERE interview_id=$1 AND kind='veo_usd_failed'`, [iv.id]))?.usd ?? 0);
      const epScript = await db.one('SELECT segments, status FROM scripts WHERE id=$1', [ep.script_id]);
      const epSegs = epScript?.segments ?? [];
      const guestHasPhoto = !!(await db.one('SELECT 1 FROM photos WHERE interview_id=$1 LIMIT 1', [iv.id]));
      const videoMeta = ep.video_asset_id ? (await db.one('SELECT meta FROM assets WHERE id=$1', [ep.video_asset_id]))?.meta : null;
      // As aprovações valem só para o vídeo que foi visto (approvals.video_asset_id igual ao vídeo atual).
      const hostAp = await db.one(`SELECT * FROM approvals WHERE episode_id=$1 AND actor='interviewer' AND valid AND decision='approved' AND video_asset_id IS NOT DISTINCT FROM $2::uuid`, [ep.id, ep.video_asset_id]);
      const guestAp = await db.one(`SELECT * FROM approvals WHERE episode_id=$1 AND actor='guest' AND valid ORDER BY created_at DESC LIMIT 1`, [ep.id]);
      const guestSameVideo = !!guestAp && String(guestAp.video_asset_id ?? '') === String(ep.video_asset_id ?? '');
      const needGuest = guestMustApprove(iv, videoMeta);
      // O motivo concreto (retirado, vídeo a ser gerado, aprovação em falta…) aparece junto do botão e na recusa.
      const pubBlock = publishBlock({ ep, pubOk, videoBusy: await videoBusy(iv.id, ep.id), hostAp: !!hostAp, needGuest, guestAp });
      const canPublish = !pubBlock;
      const isAdmin = req.user!.role === 'admin';
      // Veo sem orçamento: o administrador (custo interno) e o gestor da entidade com credenciais Google próprias (paga ela).
      const freeVeo = veoWithoutQuote(req.user, ent);
      // Animação por orçamento (titular que não é administrador; o administrador só prepara o rascunho do cliente).
      const quoteHtml = !ep.stale ? await quoteSection(db, iv, ep) : '';
      body += `<div class="card"><h2 style="margin-top:0">5. Episódio ${pill(ep.status, ep.status === 'published' ? 'ok' : '')} ${ep.stale ? pill('desatualizado', 'bad') : ''}</h2>
${playerHtml(ep, { audio: `/media/${ep.audio_asset_id}`, cover: `/media/${ep.cover_asset_id}`, subs: (l, x) => `/entrevistas/${iv.id}/subs/${l}.${x}` }, { host: iv.host_name, guest: iv.guest_name })}
<p class="hint sans">Pico máx.: ${ep.technical?.maxVolumeDb ?? '—'} dB · clipping: ${ep.technical?.clipping ? 'SIM' : 'não'}${ep.technical?.mock ? ' · <strong>gerado em modo simulado (AI_MOCK)</strong>' : ''}</p>
${issues.length ? `<div class="flash bad"><strong>Controlo de qualidade:</strong><ul>${issues.map(i => `<li>${esc(i)}</li>`).join('')}</ul>Corrija e regenere antes de publicar.</div>` : ''}
<h3>Aprovações</h3><table class="sans"><tbody>
<tr><td>Entrevistador</td><td>${hostAp ? pill('aprovou esta versão', 'ok') : pill('pendente')}</td><td>${!hostAp && !ep.stale ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/aprovar"><input type="hidden" name="video" value="${esc(ep.video_asset_id ?? '')}"><button class="ghost">Aprovar esta versão${ep.video_asset_id ? ' (com o vídeo)' : ''}</button></form>` : ''}</td></tr>
${needGuest ? `<tr><td>Entrevistado</td><td>${guestAp ? (guestAp.decision === 'approved' ? (guestSameVideo ? pill('aprovou', 'ok') : pill('aprovou uma versão anterior do vídeo: pendente', 'warn')) : pill('pediu alterações', 'bad')) : pill('pendente')} ${guestAp?.note ? esc(guestAp.note) : ''}</td>
<td>${previewBlock(iv, ep, videoMeta) ? `<span class="hint">${esc(previewBlock(iv, ep, videoMeta)!)}</span>` : `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/enviar-previa"><button class="ghost">Enviar pré-visualização</button></form>`}</td></tr>` : ''}</tbody></table>
<h3>Vídeo do podcast</h3>
${ep.video_asset_id ? `<video controls preload="metadata" poster="/media/${ep.cover_asset_id}" src="/media/${ep.video_asset_id}" style="width:100%;max-width:720px;border-radius:10px;background:#000"></video>
<p class="sans"><a class="btn" href="/entrevistas/${iv.id}/episodio/${ep.id}/video.mp4" download>Descarregar vídeo (MP4)</a> <span class="hint">Legendas: ${esc(ep.video_lang ?? 'sem legendas')}${videoMeta?.animatedSegments ? ` · ${videoMeta.animatedSegments} falas animadas${videoMeta.failedAnimations ? `, ${videoMeta.failedAnimations} com imagem fixa por falha` : ''} · custo da animação ~$${Number(videoMeta.lipsyncUsd ?? 0).toFixed(2)}` : ''}${videoMeta?.engine === 'veo' ? ` · ${clipModelsNote(videoMeta) ? 'pedido ao ' : ''}${esc(videoMeta.tier ? veoLabel(videoMeta.tier === 'lite' ? 'lite' : 'fast') : 'Google Veo')}${videoMeta.model ? ` (${esc(videoMeta.model)})` : ''}: ${videoMeta.veoClips} clipes (${videoMeta.generatedClips} gerados nesta vez${videoMeta.failedUsd !== undefined ? `, ~$${Number(videoMeta.spentUsd ?? 0).toFixed(2)} pagos nesta geração${videoMeta.failedUsd ? `, ~$${Number(videoMeta.failedUsd).toFixed(2)} em operações que falharam na Google` : ''}` : ''})${clipModelsNote(videoMeta) ? ` · ${esc(clipModelsNote(videoMeta))}` : ''} · clipes deste vídeo ~$${Number(videoMeta.veoUsd ?? 0).toFixed(2)}${videoMeta.fallbackSegments?.length ? ` · ${videoMeta.fallbackSegments.length} falas com imagem fixa` : ''}${videoMeta.paidBy === 'entity' ? ' · pago pela entidade, no projeto Google dela (sem créditos)' : ''}` : ''}${veoSpent ? ` · total pago ao Google Veo nesta entrevista ~$${veoSpent.toFixed(2)}` : ''}${veoFailed ? ` · operações falhadas na Google ~$${veoFailed.toFixed(2)} (normalmente não cobradas; confirme no painel da Google)` : ''}</span></p>
${videoMeta?.googleBusy ? '<div class="flash">O Google Veo estava com procura elevada: algumas falas ficaram com a fotografia fixa. Gere de novo mais tarde; os clipes já obtidos são reaproveitados e só se pagam os que faltam.</div>' : ''}
${videoMeta?.engine === 'veo' ? `<details ${videoMeta.fidelityIssues || videoMeta.fallbackSegments?.length ? 'open' : ''}><summary class="sans">Fidelidade ao guião: ${videoMeta.fidelityIssues ? `${videoMeta.fidelityIssues} pedaço(s) sem clipe aprovado (não disseram o texto aprovado ou não foi possível verificar); essas falas ficaram com a fotografia fixa e a voz do episódio` : 'todos os clipes dizem o texto aprovado'}</summary>
<table class="sans"><thead><tr><th>Fala</th><th>Guião</th><th>Ouvido no vídeo</th><th>Resultado</th></tr></thead><tbody>${(videoMeta.fidelity ?? []).map((f: any) => `<tr><td>${esc(f.segmentId)}</td><td>${esc(f.expected)}</td><td>${esc(f.heard || '—')}</td><td>${f.ok ? pill(f.edits ? 'coincide (grafia de nome)' : 'coincide', 'ok') : f.problem === 'busy' ? pill('Google indisponível (procura elevada): fotografia fixa', 'warn') : f.problem === 'busycap' ? pill('em pausa após 4 falhas da Google em 36 h (gere de novo mais tarde): fotografia fixa', 'warn') : f.problem === 'filtered' ? pill('bloqueado pelos filtros da Google: fotografia fixa', 'warn') : f.problem === 'capped' ? pill(`limite de tentativas esgotado${f.cause ? ` (${f.cause})` : ''}: fotografia fixa`, 'warn') : f.problem === 'capped_budget' ? pill('teto do orçamento atingido: fotografia fixa, não cobrada', 'warn') : f.problem === 'breaker' ? pill('disjuntor (demasiadas repetições falhadas): fotografia fixa, não cobrada', 'warn') : f.problem === 'no_clips' ? pill('clipes já pagos indisponíveis: fotografia fixa', 'warn') : f.problem === 'unchecked' ? pill('não verificado: fotografia fixa', 'warn') : f.problem === 'error' ? pill('falhou na Google: fotografia fixa', 'warn') : !f.checked ? pill('não verificado: fotografia fixa', 'warn') : pill(`${f.edits ?? '?'} diferença(s): fotografia fixa`, 'bad')}${f.ok && !f.used ? ' <span class="hint">(outra parte da fala falhou: fala em fotografia fixa)</span>' : ''}${f.attempts > 1 ? ` <span class="hint">${f.attempts} tentativas</span>` : ''}${f.reused ? ' <span class="hint">(reaproveitado: fala já paga)</span>' : ''}</td></tr>`).join('')}</tbody></table></details>` : ''}` : '<p class="hint">Ainda não foi gerado.</p>'}
${!live && lastVideoJob?.state === 'failed' ? `<div class="flash bad">A última geração do vídeo não terminou: ${esc(String(lastVideoJob.error ?? '').slice(0, 400))}</div>` : ''}
${!ep.stale ? `${ep.status !== 'preview' ? `<p class="hint"><strong>${esc(VIDEO_ONLY_PREVIEW)}</strong></p>` : `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/video" class="row" onsubmit="return confirm('Gerar o vídeo?')">
${(() => { const est = animationEstimate(ep, iv, animOk, !!(iv.host_photo_rights && iv.host_photo_asset_id), guestHasPhoto);
  const hostVeo = !!(iv.host_ai_video && iv.host_photo_rights && iv.host_photo_asset_id), guestVeo = veoOk && guestHasPhoto && iv.review_policy === 'guest_preview';
  const ve = veoEstimate(ep.technical?.timing ?? [], epSegs, hostVeo, guestVeo, tier);
  const veoBlock = epScript?.status !== 'approved' ? VEO_SCRIPT_REPLACED : guestAp?.decision === 'changes' ? VEO_CHANGES : !veoKey ? VEO_NO_CREDENTIALS : !openaiKey ? 'Falta a chave da OpenAI (transcrição para verificar os clipes) em Definições.' : '';
  return `<fieldset style="flex-basis:100%;border:1px solid var(--line);border-radius:8px"><legend class="sans">Imagem e voz do vídeo</legend>
<label class="check"><input type="radio" name="engine" value="still" checked> Fotografias fixas com a voz do episódio</label>
${!freeVeo ? `<p class="hint" style="margin:0 0 8px 30px">A animação por IA (Google Veo) faz-se por orçamento, na secção «Animação por IA» abaixo: aceita antes de gerar e paga só as falas animadas e verificadas.</p></fieldset>` : `${!isAdmin ? '' : `<label class="check"><input type="radio" name="engine" value="lipsync" ${est.sec ? '' : 'disabled'}> Retratos com sincronização labial (Replicate), aviso visível «AI-animated portrait»</label>
<p class="hint" style="margin:0 0 8px 30px">Entrevistador: ${iv.host_animate && iv.host_photo_rights && iv.host_photo_asset_id ? 'autorizado' : 'sem autorização ou sem fotografia (em Editar)'} · Convidado: ${animOk && guestHasPhoto ? 'autorizado' : 'sem autorização específica (o convidado pode dá-la em «Autorizações das fotografias», a partir do link do convite ou da pré-visualização)'}.
${est.sec ? `Fala a animar: ${Math.round(est.sec)} s · custo estimado ~$${est.usd.toFixed(2)} (Replicate) · demora ~${est.minutes} min.` : ''} Se alguma animação falhar, essa fala fica com a imagem fixa.</p>`}
<label class="check"><input type="radio" name="engine" value="veo" ${ve.clips && !veoBlock ? '' : 'disabled'}> ${esc(veoLabel(tier))}: vídeo e voz gerados pelo modelo a partir da fotografia e do texto aprovado, aviso visível «AI-generated video · AI voice»</label>
<p class="hint" style="margin:0 0 8px 30px">${veoBlock ? `<strong>${esc(veoBlock)}</strong> ` : ''}Entrevistador: ${hostVeo ? 'autorizado' : !iv.host_photo_asset_id ? 'sem fotografia (em Editar)' : 'sem autorização para o Veo (em Editar)'} · Convidado: ${guestVeo ? 'autorizado' : iv.review_policy !== 'guest_preview' ? 'não entra no Veo com a política «só o entrevistador aprova» (não veria o vídeo antes de publicar)' : !guestHasPhoto ? 'sem fotografia' : 'sem autorização para o Veo (o convidado pode dá-la em «Autorizações das fotografias», a partir do link do convite ou da pré-visualização)'}.
${ve.clips ? `${ve.clips} clipes, ${ve.sec} s faturados a ~$${ve.usdPerSec.toFixed(2)}/s · custo estimado ~$${ve.usd.toFixed(2)}, até ~$${ve.usdMax.toFixed(2)} se todos precisarem de nova tentativa · demora ~${ve.minutes} min.` : ''}
A voz é a do modelo (não a do episódio) e pode variar entre clipes. Cada clipe é transcrito e comparado palavra a palavra com o guião; se não coincidir, é gerado de novo uma vez, e se continuar a não coincidir essa fala fica com a fotografia fixa e a voz do episódio (nunca entra um clipe que diga outra coisa). O mesmo para quem não autorizou. Só antes de publicar; o vídeo novo exige nova aprovação${iv.review_policy === 'guest_preview' ? ' (o convidado vê-o na pré-visualização)' : ''}. ${isAdmin ? 'Pedido pelo administrador: custo interno, sem orçamento.' : 'Pedido pelo gestor da entidade, com as credenciais Google dela: sem orçamento nem créditos (a Google cobra no projeto Google da entidade).'}</p></fieldset>`}`; })()}<label for="vl" style="margin:0">Legendas no vídeo</label><select id="vl" name="lang" style="width:auto">${Object.keys(ep.subtitles ?? {}).map(l => `<option value="${esc(l)}" ${l === (ep.video_lang ?? 'pt-PT') ? 'selected' : ''}>${esc(l)}</option>`).join('')}<option value="">Sem legendas</option></select><button class="ghost">${ep.video_asset_id ? 'Gerar de novo' : 'Gerar vídeo'}</button>${ep.video_asset_id || hostAp || guestAp ? '<span class="hint" style="flex-basis:100%">Um vídeo novo exige nova aprovação de quem já aprovou.</span>' : ''}</form>`}
${quoteHtml}
${ep.video_asset_id && ep.status !== 'published' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/video/retirar" onsubmit="return confirm('Tirar o vídeo deste episódio? O ficheiro fica guardado em privado.')"><button class="ghost">Tirar o vídeo do episódio (volta à versão sem vídeo)</button></form>` : ''}
<p class="hint">Capa durante o aviso inicial e o agradecimento final; composição de estúdio com as duas fotografias autorizadas durante a apresentação; a partir da primeira pergunta, só quem fala, em grande plano. As legendas ficam gravadas na imagem, numa só língua. Só entram fotografias autorizadas (a do convidado exige autorização de publicação).</p>` : ''}
${!pubOk ? '<div class="flash bad">O entrevistado não autorizou a publicação.</div>' : ''}
${ep.status === 'withdrawn' ? `<p class="sans">Retirado em ${fmtDate(ep.withdrawn_at)}.</p><p class="hint">${esc(pubBlock ?? '')}</p>`
  : ep.status !== 'published' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/publicar" onsubmit="return confirm('Publicar agora?')"><label for="vis">Modalidade</label><select id="vis" name="visibility"><option value="private">Privado (só pessoas autorizadas)</option><option value="unlisted" ${iv.planned_visibility === 'unlisted' ? 'selected' : ''}>Não listado (quem tem o link; não equivale a privado)</option><option value="public" ${iv.planned_visibility === 'public' ? 'selected' : ''}>Público (indexável)</option></select>
<fieldset style="border:1px solid var(--line);border-radius:8px;margin-top:12px"><legend class="sans">Galeria pública «Podcasts gerados»</legend>
<label class="check"><input type="checkbox" name="gallery" value="1"> Permito que este episódio fique na galeria pública do portal, para consulta, organizada por temas (só para episódios públicos).</label>
<label for="th">Tema</label><input id="th" name="theme" type="text" list="themes" maxlength="60" placeholder="Ex.: Energia, Telecomunicações, Hotelaria"><datalist id="themes">${(await db.query(`SELECT DISTINCT theme FROM episodes WHERE theme<>'' ORDER BY theme`)).map((t: any) => `<option value="${esc(t.theme)}">`).join('')}</datalist></fieldset>
<p><button class="accent" ${canPublish ? '' : 'disabled'}>Publicar</button></p>${canPublish ? '' : `<p class="hint">Ainda não é possível publicar: ${esc(pubBlock ?? '')} (Publicar exige a aprovação válida do entrevistador${needGuest ? ' e do entrevistado' : ''}, a autorização de publicação, a versão atual e nenhum alerta de qualidade.)</p>`}</form>`
  : `<p class="sans">Publicado (${esc(ep.visibility)}) em ${fmtDate(ep.published_at)}${ep.visibility !== 'private' ? ` · <a href="/e/${ep.slug}">/e/${esc(ep.slug)}</a>` : ''}</p>
${ep.visibility === 'public' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/galeria" class="card"><strong class="sans">Galeria pública «Podcasts gerados»</strong>
<label class="check"><input type="checkbox" name="gallery" value="1" ${ep.gallery ? 'checked' : ''}> Mostrar na galeria pública, organizada por temas</label>
<label for="th2">Tema</label><input id="th2" name="theme" type="text" maxlength="60" value="${esc(ep.theme)}"><button class="ghost">Guardar</button></form>` : ''}
<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/retirar" onsubmit="return confirm('Retirar o episódio?')"><button class="danger">Retirar episódio</button></form>
<p class="hint">Cópias já descarregadas ou distribuídas externamente podem não ser recuperáveis.</p>`}</div>`;
    }
    if (!live && (script || ep || ['failed', 'stale', 'editorial_review', 'ready', 'qc'].includes(iv.production_status))) {
      body += `<div class="card"><h2 style="margin-top:0">Recomeçar a produção</h2>
<p class="hint">Arquiva o guião e o episódio atuais (não são eliminados) e volta ao passo «Processar podcast». As gravações e as transcrições originais mantêm-se. Se o episódio estiver publicado, é retirado e sai da galeria.</p>
<form method="post" action="/entrevistas/${iv.id}/producao/recomecar" onsubmit="return confirm('Arquivar o guião e o episódio atuais e recomeçar a produção?')"><button class="danger" ${scriptBefore && !canRegen ? 'disabled' : ''}>Recomeçar produção</button></form>${scriptBefore ? `${regenHint}${canRegen ? `<p class="hint">Depois de recomeçar, processar de novo custa ${cr(EXTRA_REGEN_CENTS)} crédito.</p>` : ''}` : ''}</div>`;
    }
    body += '</div>';
    return reply.type('text/html; charset=utf-8').send(page({ title: 'Produção', body, noindex: true, script: live ? '/static/progress.js' : '/static/player.js', nav: `<a href="/painel">Painel</a>` }));
  });

  // Estado dos trabalhos em JSON, para a barra de progresso (só o dono/admin).
  app.get('/entrevistas/:id/progresso', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'session' });
    const iv = await ownedInterview(app, req, (req.params as any).id);
    if (!iv) return reply.code(404).send({ error: 'not found' });
    const j = await db.one(`SELECT id, kind, state, progress_done, progress_total, progress_label, started_at, created_at, run_after, error, now() AS server_now FROM jobs
      WHERE interview_id=$1 ORDER BY (state IN ('queued','running')) DESC, created_at DESC LIMIT 1`, [iv.id]); // o que está a correr ou em fila primeiro (um trabalho por entrevista de cada vez)
    reply.header('Cache-Control', 'no-store');
    if (!j) return { active: false };
    const total = Number(j.progress_total) || 0, done = Math.min(Number(j.progress_done) || 0, total);
    const elapsedSec = j.started_at ? Math.max(0, (new Date(j.server_now).getTime() - new Date(j.started_at).getTime()) / 1000) : 0;
    // Estimativa pelo ritmo observado; só a partir de 5% feito, para não dar números absurdos no arranque.
    const etaSec = j.state === 'running' && total && done / total >= 0.05 ? Math.round((elapsedSec / done) * (total - done)) : null;
    // Vídeo à espera na via dos vídeos: quantos estão à frente e quanto falta para a via ficar livre.
    const fila = j.state === 'queued' && laneOf(j.kind) === 'video' && !paused(j) ? await videoQueue(db, j.id) : null;
    const queued = fila ? (fila.ahead ? `Em fila: ${fila.ahead} vídeo(s) à frente (~${fila.minutes} min)` : 'Em fila: é o próximo vídeo') : 'Em fila';
    return { active: ['queued', 'running'].includes(j.state), kind: j.kind, title: JOB_LABEL[j.kind] ?? j.kind, state: j.state, percent: total ? Math.round((done / total) * 100) : 0,
      label: j.state === 'queued' ? (paused(j) ? j.progress_label : queued) : j.progress_label, elapsedSec: Math.round(elapsedSec), etaSec, error: j.state === 'failed' ? j.error : null };
  });

  // ---- ações ----
  app.post('/entrevistas/:id/producao/recomecar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    if (await db.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND state IN ('queued','running')`, [iv.id])) return back(reply, iv.id, undefined, 'Há um processamento em curso; aguarde que termine.');
    // Processar de novo seria uma regeneração: com as incluídas esgotadas e sem crédito para a pagar, a produção atual não se arquiva.
    const paidNext = await hadScript(db, iv.id) && await regenExhausted(req, iv.id);
    if (paidNext && !(await regenPayment(req.user)).canPay) return back(reply, iv.id, undefined, `${REGEN_BLOCKED()} Sem crédito para processar de novo, não é possível recomeçar a produção.`);
    await db.tx(async tx => {
      await tx.query(`UPDATE scripts SET status='superseded' WHERE interview_id=$1 AND status<>'superseded'`, [iv.id]);
      await tx.query(`UPDATE episodes SET status=CASE WHEN status='published' THEN 'withdrawn' ELSE 'superseded' END, withdrawn_at=CASE WHEN status='published' THEN now() ELSE withdrawn_at END, gallery=false, stale=true WHERE interview_id=$1 AND status NOT IN ('superseded','withdrawn')`, [iv.id]);
      await tx.query(`UPDATE episodes SET stale=true, gallery=false WHERE interview_id=$1 AND status='withdrawn'`, [iv.id]);
      await tx.query(`UPDATE approvals SET valid=false WHERE interview_id=$1 AND valid`, [iv.id]);
      await tx.query(`UPDATE interviews SET production_status='not_requested', publication_status='private' WHERE id=$1`, [iv.id]);
    });
    await audit(db, req.user!.email, 'production.reset', iv.id);
    return back(reply, iv.id, paidNext ? `Produção recomeçada: processar de novo custa ${cr(EXTRA_REGEN_CENTS)} crédito.` : 'Produção recomeçada: pode voltar a processar o podcast.');
  });

  app.post('/entrevistas/:id/processar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    if (iv.collection_status !== 'submitted') return back(reply, iv.id, undefined, 'A entrevista não foi submetida.');
    if (!(await consent(iv.id, 'processing'))) return back(reply, iv.id, undefined, 'Sem autorização de processamento por IA.');
    if (!aiAvailable()) return back(reply, iv.id, undefined, 'Serviço de IA não configurado.');
    const sub = await db.one('SELECT id FROM submissions WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1', [iv.id]);
    const est = await estimateCost(db, iv.id, iv.subtitle_langs);
    // Processar de novo depois de «Recomeçar» refaz o guião: é uma regeneração (tentar de novo depois de uma falha não conta).
    const r = await enqueueProduction(req, iv.id, 'process_submission', async (tx, cur) => cur.production_status !== 'failed' && await hadScript(tx, cur.id), async tx => {
      // Deduplica por submissão; "tentar de novo" após falha usa nova chave com o nº de tentativas anteriores.
      const prior = Number((await tx.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='process_submission'`, [iv.id])).n);
      return { dedupe: `process:${sub.id}:${prior}`, costUsd: est.usd };
    });
    if (r.blocked) return back(reply, iv.id, undefined, r.blocked);
    const id = r.id;
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
    const r = await enqueueProduction(req, iv.id, 'prepare_script', (tx, cur) => hadScript(tx, cur.id), async tx => {
      const n = Number((await tx.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='prepare_script'`, [iv.id])).n);
      return { dedupe: `prep:${iv.id}:${n}` };
    });
    if (r.blocked) return back(reply, iv.id, undefined, r.blocked);
    if (r.busy) return back(reply, iv.id, undefined, BUSY);
    await db.query(`UPDATE interviews SET production_status='queued' WHERE id=$1`, [iv.id]);
    return back(reply, iv.id, r.paid ? `Guião em regeneração (${cr(EXTRA_REGEN_CENTS)} crédito).` : 'Guião em regeneração.');
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
    await db.query(`UPDATE approvals SET valid=false WHERE interview_id=$1 AND valid AND decision='approved'`, [iv.id]); // um pedido de alterações mantém-se
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
    // Só com «o entrevistado aprova» o pedido de alterações do convidado trava uma nova geração do mesmo guião (como no main com host_only).
    if (iv.review_policy === 'guest_preview' && await db.one(`SELECT 1 FROM approvals a JOIN episodes e ON e.id=a.episode_id WHERE e.script_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes' LIMIT 1`, [s.id]))
      return back(reply, iv.id, undefined, 'O convidado pediu alterações a um episódio deste guião: reveja o guião e aprove uma nova revisão antes de gerar.');
    const b = req.body as any;
    const langs = ([] as string[]).concat(b.subtitle_langs ?? []).filter(l => SUBS.some(x => x[0] === l));
    const photos = ([] as string[]).concat(b.cover_photo ?? []).filter(x => /^[0-9a-f-]{36}$/i.test(x)).slice(0, 2);
    const cfg = sha256(JSON.stringify([langs.sort(), photos.sort(), config.openai.voices, config.openai.models]));
    const est = await estimateCost(db, iv.id, langs.length ? langs : iv.subtitle_langs);
    // O primeiro episódio da entrevista está incluído; gerar outro (outra revisão ou configuração) é uma regeneração.
    const r = await enqueueProduction(req, iv.id, 'generate_episode', (tx, cur) => hadEpisode(tx, cur.id), async () =>
      ({ input: { scriptId: s.id, subtitleLangs: langs, coverPhotoIds: photos }, dedupe: `gen:${s.id}:${cfg}`, costUsd: est.parts.speech + est.parts.text + est.parts.cover }));
    if (r.blocked) return back(reply, iv.id, undefined, r.blocked);
    if (r.busy) return back(reply, iv.id, undefined, BUSY);
    const id = r.id;
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
    // A aprovação é do vídeo que estava na página: se entretanto mudou, pede-se para rever.
    if (String((req.body as any)?.video ?? '') !== String(c.ep.video_asset_id ?? '')) return back(reply, c.iv.id, undefined, 'O vídeo mudou desde que abriu a página: reveja-o antes de aprovar.');
    await db.query(`UPDATE approvals SET valid=false WHERE episode_id=$1 AND actor='interviewer'`, [c.ep.id]);
    await db.query(`INSERT INTO approvals(interview_id, kind, actor, episode_id, script_id, decision, video_asset_id) VALUES ($1,'episode','interviewer',$2,$3,'approved',$4)`, [c.iv.id, c.ep.id, c.ep.script_id, c.ep.video_asset_id ?? null]);
    return back(reply, c.iv.id, 'Versão aprovada.');
  });

  app.post('/entrevistas/:id/episodio/:eid/enviar-previa', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    const blocked = previewBlock(c.iv, c.ep, await loadVideoMeta(db, c.ep.video_asset_id));
    if (blocked) return back(reply, c.iv.id, undefined, blocked);
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
    // Aprovações válidas e do vídeo atual (quem aprovou viu este vídeo).
    const hostAp = await db.one(`SELECT 1 FROM approvals WHERE episode_id=$1 AND actor='interviewer' AND valid AND decision='approved' AND video_asset_id IS NOT DISTINCT FROM $2::uuid`, [ep.id, ep.video_asset_id]);
    const guestAp = await db.one(`SELECT decision, video_asset_id FROM approvals WHERE episode_id=$1 AND actor='guest' AND valid ORDER BY created_at DESC LIMIT 1`, [ep.id]);
    const vmeta = ep.video_asset_id ? (await db.one('SELECT meta FROM assets WHERE id=$1', [ep.video_asset_id]))?.meta : null;
    const needGuest = guestMustApprove(iv, vmeta);
    // O motivo é o mesmo da página (ex.: episódio retirado, e não «faltam aprovações»).
    const blocked = publishBlock({ ep, pubOk: await consent(iv.id, 'publish'), videoBusy: await videoBusy(iv.id, ep.id), hostAp: !!hostAp, needGuest, guestAp });
    if (blocked) { await audit(db, req.user!.email, 'episode.publish_blocked', iv.id, { reason: blocked }); return back(reply, iv.id, undefined, `Publicação bloqueada: ${blocked}`); }
    const b = req.body as any;
    const theme = String(b?.theme ?? '').trim().slice(0, 60);
    // Só publica a versão que foi verificada acima (o vídeo não mudou entretanto).
    const done = await db.one(`UPDATE episodes SET status='published', visibility=$2, published_at=now(), withdrawn_at=NULL, gallery=$3, theme=$4
      WHERE id=$1 AND status='preview' AND NOT stale AND video_asset_id IS NOT DISTINCT FROM $5::uuid
        AND (NOT $6::boolean OR NOT EXISTS (SELECT 1 FROM approvals a WHERE a.episode_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes')) RETURNING id`, [ep.id, vis, vis === 'public' && !!b?.gallery, theme, ep.video_asset_id, needGuest]); // o pedido do convidado só conta quando a aprovação dele é exigida
    if (!done) return back(reply, iv.id, undefined, 'O episódio mudou entretanto (vídeo novo ou outra versão): reveja e aprove de novo.');
    await db.query(`UPDATE interviews SET publication_status='published' WHERE id=$1`, [iv.id]);
    await audit(db, req.user!.email, 'episode.published', iv.id, { visibility: vis, episodeId: ep.id });
    return back(reply, iv.id, vis === 'private' ? 'Guardado como privado.' : 'Publicado.');
  });

  app.post('/entrevistas/:id/episodio/:eid/video', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    if (c.ep.stale) return back(reply, c.iv.id, undefined, 'Versão desatualizada.');
    const b = req.body as any;
    const lang = String(b?.lang ?? '');
    const engine = b?.engine === 'veo' ? 'veo' : b?.engine === 'lipsync' || b?.animate ? 'lipsync' : 'still';
    // Vídeo IA pago ao fornecedor: o Veo sem orçamento só para o administrador e para o gestor de uma entidade com
    // credenciais Google próprias (os outros por orçamento aceite, nas rotas do orçamento); os retratos animados só para o
    // administrador. O pipeline volta a verificar (segunda barreira).
    const ent = await entityOfInterview(db, c.iv.id);
    if (engine === 'veo' && !veoWithoutQuote(req.user, ent)) return back(reply, c.iv.id, undefined, VEO_NEEDS_QUOTE);
    if (engine === 'lipsync' && req.user!.role !== 'admin') return back(reply, c.iv.id, undefined, ANIMATE_ADMIN_ONLY);
    // Só num episódio por publicar: num publicado, o vídeo novo iria logo para o ar sem nova aprovação.
    if (c.ep.status !== 'preview') return back(reply, c.iv.id, undefined, engine === 'veo' ? VEO_ONLY_PREVIEW : VIDEO_ONLY_PREVIEW);
    // Clique repetido: não se paga duas vezes a mesma geração.
    if (await db.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind='render_video' AND (state='queued' OR (state='running' AND locked_at > now() - interval '15 minutes'))`, [c.iv.id])) return back(reply, c.iv.id, undefined, 'Já há um vídeo a ser gerado; aguarde que termine.');
    if (engine === 'veo') {
      if ((await db.one('SELECT status FROM scripts WHERE id=$1', [c.ep.script_id]))?.status !== 'approved') return back(reply, c.iv.id, undefined, VEO_SCRIPT_REPLACED);
      if (await db.one(`SELECT 1 FROM approvals a JOIN episodes e ON e.id=a.episode_id WHERE e.script_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes' LIMIT 1`, [c.ep.script_id])) return back(reply, c.iv.id, undefined, VEO_CHANGES);
      if (!config.openai.mock && !inEntity(ent, () => veoConfigured())) return back(reply, c.iv.id, undefined, VEO_NO_CREDENTIALS);
      if (!config.openai.mock && !inEntity(ent, () => aiAvailable())) return back(reply, c.iv.id, undefined, 'Falta a chave da OpenAI (transcrição para verificar os clipes) em Definições.');
    }
    const n = Number((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='render_video'`, [c.iv.id])).n);
    await enqueue(db, { kind: 'render_video', interviewId: c.iv.id, input: { episodeId: c.ep.id, lang: lang && c.ep.subtitles?.[lang] ? lang : null, animate: engine === 'lipsync', requestedBy: req.user!.id, ...(engine === 'veo' ? { engine: 'veo', veoRetries: 1 } : {}) }, dedupe: `video:${c.ep.id}:${n}` });
    await audit(db, req.user!.email, 'episode.video_requested', c.iv.id, { lang, engine });
    return back(reply, c.iv.id, 'Geração do vídeo iniciada.');
  });

  app.post('/entrevistas/:id/episodio/:eid/video/retirar', async (req, reply) => {
    const c = await epGuard(req, reply); if (!c) return;
    if (c.ep.status === 'published') return back(reply, c.iv.id, undefined, 'Episódio publicado: retire o episódio primeiro.');
    await db.query(`UPDATE episodes SET video_asset_id=NULL WHERE id=$1 AND status<>'published'`, [c.ep.id]);
    await audit(db, req.user!.email, 'episode.video_removed', c.iv.id);
    return back(reply, c.iv.id, 'Vídeo tirado do episódio (o ficheiro fica guardado em privado).');
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
