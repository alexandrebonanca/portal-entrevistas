import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate, fmtDuration, sha256, rateLimit } from '../lib.ts';
import { page, flash, pill, STATUS_LABEL } from '../views.ts';
import { requireUser, ownedInterview, audit, sendAsset } from '../app.ts';
import { enqueue, videoQueue, laneOf, type EnqueueOpts } from '../jobs.ts';
import type { Db } from '../db.ts';
import { regenerationsUsed, REGEN_BLOCKED, scriptSizeError, scriptTotalMax, SCRIPT_SEGMENT_MAX, milhares, transcriptMax, SUBTITLE_LANGS, subtitleLangs } from '../limits.ts';
import { estimateCost, latestTranscript, animationEstimate, recordTextUsage } from '../pipeline.ts';
import { aiAvailable, aiNotAnswered, reviewScript, validateScript, episodeVoice, newMeter } from '../ai/openai.ts';
import { playerHtml } from './episode.ts';
import { createInvitation } from '../invites.ts';
import { queueEmail, emailShell } from '../mail.ts';
import { veoEstimate, clipModelsNote, veoWithoutQuote, VEO_ONLY_PREVIEW, VIDEO_ONLY_PREVIEW, VEO_CHANGES, VEO_SCRIPT_REPLACED, VEO_NO_CREDENTIALS, VEO_NEEDS_QUOTE } from '../veo-episode.ts';
import { veoConfigured, veoTier, veoLabel } from '../talking.ts';
import { inEntity, entityOfInterview } from '../settings.ts';
import { guestMustApprove, videoMeta as loadVideoMeta, coverWithdrawn } from '../approval.ts';
import { walletFor, findWallet, spend, spendBlock, cr, EXTRA_REGEN_CENTS, type Wallet } from '../wallet.ts';
import { paidConsentHtml, paidConsentOk, isConsumer } from './credits.ts';
import { vatForProfile } from '../billing.ts';
import { seller } from '../legal.ts';
import { withVat, eurPt } from '../vat.ts';
import { quoteSection } from './quotes.ts';
import { introProductionHint } from './intro.ts';
import { helpNav, isUuid } from '../support.ts';
import { takeAiUse, giveBackAiUse, aiUsed, FREE_SCRIPT_REVIEWS, FREE_REVIEWS_USED, FREE_PRODUCTION_JOBS, FREE_JOBS_USED, FREE_JOBS_USED_HTML, FREE_JOBS_LOW, FREE_JOBS_LOW_HTML, FREE_JOBS_LOW_NO_SCRIPT_HTML, FREE_JOBS_FOR_SCRIPT, freeJobsBlock, freeJobsDoneHtml, freeProductionJobs, FREE_VIDEO_RENDERS, FREE_VIDEOS_USED, FREE_VIDEOS_USED_HTML, freeVideoRenders } from '../free-interview.ts';

/** Os retratos animados (Replicate) ficam reservados ao administrador. */
const ANIMATE_ADMIN_ONLY = 'Os retratos animados por IA (Replicate) estão reservados ao administrador. A animação com o Google Veo faz-se por orçamento, na secção «Animação por IA».';

/** Trabalho em pausa (volta à fila mais tarde, ex.: a aguardar quota da Google): mostra-se o motivo em vez de «Em fila». */
const paused = (j: any) => j.state === 'queued' && !!j.progress_label && new Date(j.run_after).getTime() > (j.server_now ? new Date(j.server_now).getTime() : Date.now());
const JOB_LABEL: Record<string, string> = { render_video: 'A gerar o vídeo do podcast', render_intro: 'A gerar a introdução animada do entrevistador', process_submission: 'A transcrever e a preparar o guião', prepare_script: 'A preparar o guião', generate_episode: 'A gerar o episódio', transcribe_asset: 'A transcrever' };
const SUBS = SUBTITLE_LANGS;


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
export function publishBlock(o: { ep: any; pubOk: boolean; coverWithdrawn: boolean; videoBusy: boolean; hostAp: boolean; needGuest: boolean; guestAp: any }): string | null {
  const { ep, guestAp } = o;
  if (ep.status === 'published') return 'O episódio já está publicado.';
  if (ep.status === 'withdrawn') return 'Este episódio foi retirado e não volta a ser publicado. Para publicar uma nova versão, regenere o guião ou recomece a produção.';
  if (ep.status !== 'preview') return 'Esta versão do episódio foi substituída por outra.';
  if (ep.stale) return 'Versão desatualizada: as respostas ou as transcrições mudaram depois do episódio; regenere o guião e o episódio.';
  if ((ep.technical?.qcIssues ?? []).length) return 'Há alertas do controlo de qualidade: corrija e regenere o episódio antes de publicar.';
  if (!o.pubOk) return 'O entrevistado não autorizou a publicação.';
  // A capa tem fotografias do convidado e ele retirou depois a autorização da capa (approval.ts, coverWithdrawnSql).
  if (o.coverWithdrawn) return 'O entrevistado retirou a autorização da capa: regenere o episódio.';
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
  const regenPayment = async (user: any) => inEntity(user.entity_id, async () => {
    const w = await findWallet(db, user.id, user.entity_id);
    const available = w?.available_cents ?? 0, blk = spendBlock(w);
    // Consumidor: o valor com IVA primeiro, como na entrevista extra e no orçamento.
    const profile = await db.one('SELECT * FROM billing_profiles WHERE user_id=$1', [user.id]);
    const consumer = profile?.kind === 'consumer';
    const d = consumer ? vatForProfile(profile, seller()) : null;
    const label = d?.ok && d.regime !== 'not_registered' ? `pagar ${eurPt(withVat(EXTRA_REGEN_CENTS, d.rate))} (${cr(EXTRA_REGEN_CENTS)} crédito)` : `pagar ${cr(EXTRA_REGEN_CENTS)} crédito`;
    return { available, block: blk?.pt ?? null, consumer, label, canPay: !blk && available >= EXTRA_REGEN_CENTS, missing: Math.max(0, EXTRA_REGEN_CENTS - available) };
  });
  /** Já houve um guião nesta entrevista (processar de novo, depois de «Recomeçar», é uma regeneração). */
  const hadScript = async (q: Db, id: string) => !!(await q.one('SELECT 1 FROM scripts WHERE interview_id=$1 LIMIT 1', [id]));
  /** Já houve um episódio gerado (ou a gerar) nesta entrevista. */
  const hadEpisode = async (q: Db, id: string) => !!(await q.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind='generate_episode' AND state<>'failed' LIMIT 1`, [id]));
  /**
   * Geração do episódio que falhou e que «Tentar de novo» repete (null = não há): o último trabalho de produção é um
   * generate_episode falhado e o guião dele continua aprovado. Repeti-la não conta como regeneração quando ainda não houve
   * episódio (hadEpisode ignora os falhados), como o primeiro «Gerar episódio»; processar de novo refaria o guião e contaria.
   */
  const failedGeneration = async (q: Db, id: string) => {
    const j = await q.one(`SELECT kind, state, input FROM jobs WHERE interview_id=$1 AND kind IN ('process_submission','prepare_script','generate_episode') ORDER BY created_at DESC LIMIT 1`, [id]);
    if (j?.kind !== 'generate_episode' || j.state !== 'failed' || typeof j.input?.scriptId !== 'string') return null;
    return (await q.one(`SELECT 1 FROM scripts WHERE id=$1 AND interview_id=$2 AND status='approved'`, [j.input.scriptId, id])) ? j.input as { scriptId: string; subtitleLangs?: string[]; coverPhotoIds?: string[] } : null;
  };
  /** Regenerações esgotadas para quem pede (o administrador nunca fica bloqueado). */
  const regenExhausted = async (req: any, id: string) => req.user.role !== 'admin' && (await regenerationsUsed(db, id)) >= INCLUDED;
  /** 1.ª entrevista grátis: trabalhos de produção já contados (FREE_PRODUCTION_JOBS) para quem pede (null: não se aplica, também ao administrador). */
  const freeJobsFor = async (req: any, iv: any) => (iv.free_at && req.user.role !== 'admin' ? freeProductionJobs(db, iv.id) : null);
  /** O convidado já submeteu a entrevista (agora, ou antes de uma pergunta adicional que a reabriu). */
  const submittedOnce = async (iv: any) => iv.collection_status === 'submitted' || !!(await db.one('SELECT 1 FROM submissions WHERE interview_id=$1 LIMIT 1', [iv.id]));
  /**
   * Porque é que o guião não se pode regenerar nem verificar (null = pode): como o /processar, só depois da submissão do
   * convidado e com a autorização de processamento dele. Antes, o /guiao/regenerar e o /guiao/verificar aceitavam um
   * rascunho nunca enviado: o primeiro guião não contava (ainda não havia nenhum), havia mais 3 regenerações incluídas por
   * rascunho, sem limite de rascunhos, e o guião criado era verificado — também numa conta sem pagamento (sonda do juiz: 4
   * guiões do gpt-4.1 e uma verificação num rascunho de uma conta do registo público, com o email por confirmar).
   */
  const scriptAiBlock = async (iv: any): Promise<string | null> =>
    !(await submittedOnce(iv)) ? 'A entrevista não foi submetida.' : !(await consent(iv.id, 'processing')) ? 'Sem autorização de processamento por IA.' : null;
  /**
   * Fotografias da capa pedidas (`ids`) que são desta entrevista, pela ordem pedida, no máximo 2. Antes, o /gerar aceitava
   * qualquer cadeia /^[0-9a-f-]{36}$/ ('-' × 36 também), que só falhava dentro do trabalho, depois das etapas pagas.
   */
  const ownPhotos = async (ivId: string, ids: unknown[]): Promise<string[]> => {
    const asked = [...new Set(ids.filter(isUuid).map(x => (x as string).toLowerCase()))].slice(0, 2);
    if (!asked.length) return [];
    const own = new Set((await db.query('SELECT id FROM photos WHERE interview_id=$1 AND id = ANY($2::uuid[])', [ivId, asked])).map((p: any) => String(p.id)));
    return asked.filter(x => own.has(x));
  };
  /**
   * Põe um trabalho de produção na fila com a entrevista bloqueada (dois cliques em simultâneo não passam o limite).
   * Se for uma regeneração pedida por quem não é administrador, conta para as incluídas; a partir da 4.ª só com o pedido
   * expresso de pagar 1 crédito, cobrado na mesma transação (e devolvido se o trabalho falhar). Na 1.ª entrevista grátis,
   * conta também para o total de trabalhos de produção (FREE_PRODUCTION_JOBS), que não volta quando o trabalho falha; um
   * guião novo (processar, regenerar o guião) precisa de FREE_JOBS_FOR_SCRIPT por usar (o dele e o do episódio).
   */
  const enqueueProduction = (req: any, id: string, kind: string, isRegen: (tx: Db, iv: any) => Promise<boolean>, opts: (tx: Db) => Promise<Omit<EnqueueOpts, 'kind' | 'interviewId'>>) =>
    db.tx(async (tx): Promise<{ id?: string; blocked?: string; busy?: boolean; paid?: boolean }> => {
      const iv = await tx.one('SELECT * FROM interviews WHERE id=$1 FOR UPDATE', [id]);
      // Um de cada vez: um segundo clique não cria (nem conta) outra regeneração.
      if (await tx.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind=$2 AND state IN ('queued','running') LIMIT 1`, [id, kind])) return { busy: true };
      const admin = req.user.role === 'admin';
      // 1.ª entrevista grátis: acima do total, nada entra na fila (pago ou não), contado com a entrevista bloqueada e antes de
      // qualquer pagamento — antes, a recusa das regenerações vinha primeiro e mandava carregar créditos para um trabalho que
      // seria recusado na mesma.
      const freeBlock = iv.free_at && !admin ? freeJobsBlock(await freeProductionJobs(tx, id), kind === 'generate_episode' ? 1 : FREE_JOBS_FOR_SCRIPT) : null;
      if (freeBlock) return { blocked: freeBlock };
      const counted = !admin && await isRegen(tx, iv);
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
      // `admin`: o trabalho do administrador não conta para o total da entrevista grátis (freeProductionJobs).
      const jobId = await enqueue(tx, { ...o, kind, interviewId: id, input: { ...(o.input ?? {}), ...(counted ? { regen: true } : {}), ...(w ? { paidCents: EXTRA_REGEN_CENTS } : {}), ...(admin && iv.free_at ? { admin: true } : {}) } });
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
    // Operações falhadas na Google à parte; a introdução animada (oferecida) é custo interno do portal, não desta entrevista.
    const ledger = await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS usd FROM usage_ledger WHERE interview_id=$1 AND kind NOT IN ('veo_usd_failed','veo_usd_intro','veo_usd_intro_failed')`, [iv.id]);
    const est = submitted ? await estimateCost(db, iv.id, iv.subtitle_langs) : null;
    const running = jobs.some((j: any) => ['queued', 'running'].includes(j.state));
    // Contador das regenerações (guião e episódio) e o que fica travado quando as incluídas se esgotam.
    const regen = await regenerationsUsed(db, iv.id);
    const exhausted = req.user!.role !== 'admin' && regen >= INCLUDED;
    const [scriptBefore, episodeBefore] = exhausted ? [await hadScript(db, iv.id), await hadEpisode(db, iv.id)] : [false, false];
    // 1.ª entrevista grátis: total de trabalhos de produção; esgotado, nenhum botão de produção põe nada na fila, e com menos
    // de FREE_JOBS_FOR_SCRIPT por usar nada faz um guião novo (processar, regenerar, recomeçar, rever uma transcrição).
    const freeJobs = await freeJobsFor(req, iv);
    const jobsLeft = freeJobs != null ? Math.max(0, FREE_PRODUCTION_JOBS - freeJobs) : null;
    const jobsOut = jobsLeft === 0;
    const jobsLow = jobsLeft != null && jobsLeft < FREE_JOBS_FOR_SCRIPT;
    // E o total das gerações do vídeo com fotografias: esgotado, a secção do vídeo não mostra «Gerar vídeo» e explica a saída.
    const freeVideos = iv.free_at && req.user!.role !== 'admin' ? await freeVideoRenders(db, iv.id) : null;
    const videosOut = freeVideos != null && freeVideos >= FREE_VIDEO_RENDERS;
    // Regenerações esgotadas: a seguinte paga-se com 1 crédito (botão com o valor e, para consumidores, as duas caixas). Com
    // o total da entrevista grátis esgotado, nem pagas: sem o botão de pagar nem «Carregar créditos» (antes, a página mandava
    // carregar créditos para uma regeneração que o enqueueProduction recusava sempre).
    const pay = exhausted && !jobsOut ? await regenPayment(req.user) : null;
    const regenHint = pay ? `<p class="hint">${esc(REGEN_BLOCKED())} Saldo: ${cr(pay.available)} créditos.${pay.block ? ` ${esc(pay.block)}` : !pay.canPay ? ` <a href="/conta/creditos/carregar?falta=${pay.missing}&amp;voltar=${encodeURIComponent(`/entrevistas/${iv.id}/producao`)}">Carregar créditos</a>` : ''}</p>` : '';
    const payFields = pay?.canPay ? `<input type="hidden" name="pagar" value="1">${paidConsentHtml(pay.consumer)}` : '';
    const PAY = jobsOut ? '' : ` — ${pay?.label ?? `pagar ${cr(EXTRA_REGEN_CENTS)} crédito`}`;
    const canRegen = (!exhausted || !!pay?.canPay) && !jobsOut;
    const canScript = canRegen && !jobsLow;
    // Processar de novo pago (o botão de pagar e o aviso só quando um guião novo ainda é possível).
    const scriptPay = scriptBefore && !jobsLow;
    // O aviso do total (com as ligações à Ajuda e à Conta) substitui a mesma recusa vinda no endereço. Vermelho só quando o que
    // resta não chega para concluir: a 8 de 8, sem um episódio que se aprove e publique como sempre (atual, sem alertas da
    // qualidade nem a capa retirada, já publicado ou a ser gerado pelo último trabalho; com ele, o aviso é neutro e diz que não
    // há mais regenerações); a 7 de 8, sem um guião aprovado ou por aprovar (nem um a ser feito) para gerar o episódio.
    const live = jobs.find((j: any) => ['queued', 'running'].includes(j.state));
    let freeHtml = '', freeBad = false;
    if (jobsOut) {
      const epState = live?.kind === 'generate_episode' ? 'running' as const : !ep || ep.stale ? null : ep.status === 'published' ? 'published' as const
        : ep.status === 'preview' && !(ep.technical?.qcIssues ?? []).length && !(await coverWithdrawn(db, ep.id)) ? 'preview' as const : null;
      freeHtml = epState ? freeJobsDoneHtml(epState) : FREE_JOBS_USED_HTML; freeBad = !epState;
    } else if (jobsLow) {
      const scriptOk = (!!script && ['draft', 'approved'].includes(script.status)) || ['process_submission', 'prepare_script'].includes(live?.kind);
      freeHtml = scriptOk ? FREE_JOBS_LOW_HTML : FREE_JOBS_LOW_NO_SCRIPT_HTML; freeBad = !scriptOk;
    }
    const eMsg = typeof q.e === 'string' && ((freeHtml && (q.e.startsWith(FREE_JOBS_USED) || q.e.startsWith(FREE_JOBS_LOW))) || (videosOut && q.e.startsWith(FREE_VIDEOS_USED))) ? undefined : q.e;
    let body = `<div class="wrap" style="padding-top:32px"><p><a href="/entrevistas/${iv.id}">← ${esc(iv.title)}</a></p><h1>Produção do podcast</h1>${flash(q.ok)}${flash(eMsg, 'bad')}
<p class="sans">${pill(STATUS_LABEL[iv.production_status] ?? iv.production_status)} ${pill(STATUS_LABEL[iv.publication_status] ?? iv.publication_status)} · Utilização registada (estimativa): <strong>$${ledger.usd.toFixed(2)}</strong>
· Regenerações do guião e do episódio: <strong id="regen">${regen} de ${INCLUDED}</strong> incluídas${req.user!.role === 'admin' ? ' (o administrador não tem limite e as dele não contam)' : ''}${freeJobs != null ? `
· 1.ª entrevista grátis: <strong id="trabalhos">${Math.min(freeJobs, FREE_PRODUCTION_JOBS)} de ${FREE_PRODUCTION_JOBS}</strong> trabalhos de produção usados (contam também os que falharam; restam ${jobsLeft})` : ''}${freeVideos != null ? `
· Vídeo com fotografias: <strong id="videos">${Math.min(freeVideos, FREE_VIDEO_RENDERS)} de ${FREE_VIDEO_RENDERS}</strong> gerações usadas (contam também as que falharam)` : ''}</p>${freeHtml ? `<div class="flash${freeBad ? ' bad' : ''}" id="trabalhos-aviso">${freeHtml}</div>` : ''}`;

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
${scriptPay ? payFields : ''}<button class="accent" ${procOk && aiAvailable() && (!scriptBefore || canRegen) && !jobsLow ? '' : 'disabled'}>Processar podcast${scriptPay ? PAY : ''}</button></form>${scriptPay ? regenHint : ''}</div>`;
    }

    // 2. Progresso
    if (live) {
      body += `<div class="card" id="progress" data-url="/entrevistas/${iv.id}/progresso" aria-live="polite"><h2 style="margin-top:0">${esc(JOB_LABEL[live.kind] ?? live.kind)}</h2>
<div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><div class="pfill"></div></div>
<p class="sans" style="margin:.6em 0 0"><strong class="ppct">0%</strong> · <span class="pstep">${esc(live.state === 'queued' ? (paused(live) ? live.progress_label : 'Em fila') : live.progress_label || 'A iniciar')}</span></p>
<p class="hint sans" style="margin:.2em 0 0"><span class="pelapsed"></span> <span class="peta"></span></p>
<p class="hint">Pode fechar esta página: o processamento continua no servidor.</p></div>`;
    }
    if (!live && iv.production_status === 'failed') {
      // «Tentar de novo»: se falhou a geração do episódio e o guião dela continua aprovado, repete-a (como «Gerar episódio»:
      // só conta se já houve episódio); senão, processa de novo, o que refaz o guião e conta como regeneração se já houve um.
      const retryGen = await failedGeneration(db, iv.id);
      const retryRegen = retryGen ? await hadEpisode(db, iv.id) : await hadScript(db, iv.id);
      // Na 1.ª entrevista grátis, a tentativa já não é possível quando faltam os trabalhos de produção: repetir a geração
      // precisa de 1, processar de novo (um guião novo) de FREE_JOBS_FOR_SCRIPT.
      const retryOut = retryGen ? jobsOut : jobsLow;
      // Sem o botão de pagar quando a ação já não é possível na entrevista grátis (um guião novo precisa de 2 trabalhos).
      const retryPay = exhausted && retryRegen && !retryOut;
      // Na 1.ª entrevista grátis cada tentativa gasta um dos trabalhos de produção, também quando a falha é do fornecedor: em
      // vez de «depois de corrigir a causa», o conselho é esperar, e a saída é a Ajuda (a equipa pode terminar a produção).
      // Sem tentativa possível, o texto diz isso (antes, mandava esperar e tentar de novo ao lado do botão desligado, com
      // «conta como uma regeneração»).
      const failHint = retryOut
        ? `Falhou. Nesta 1.ª entrevista grátis já não é possível tentar de novo: ${jobsOut ? `os ${FREE_PRODUCTION_JOBS} trabalhos de produção estão todos usados` : `resta 1 dos ${FREE_PRODUCTION_JOBS} trabalhos de produção, e processar de novo, que refaz o guião, precisa de ${FREE_JOBS_FOR_SCRIPT} (o dele e o do episódio)`}. Peça ajuda à equipa do portal em <a href="/ajuda">Ajuda</a>: a equipa pode terminar a produção desta entrevista.`
        : jobsLeft != null
        ? `Falhou. Na 1.ª entrevista grátis, cada «Tentar de novo» conta para os ${FREE_PRODUCTION_JOBS} trabalhos de produção (restam ${jobsLeft}): espere algum tempo antes de tentar de novo (uma falha do serviço de IA costuma ser passageira; um erro permanente, como uma autorização retirada, não passa com outra tentativa) e, se voltar a falhar, peça ajuda à equipa do portal em <a href="/ajuda">Ajuda</a>.`
        : 'Falhou. Os erros permanentes exigem revisão; pode tentar novamente depois de corrigir a causa.';
      const retryNote = retryOut ? '' : retryGen ? ` «Tentar de novo» volta a gerar o episódio do guião aprovado, com as mesmas legendas e fotografias${retryRegen ? ': conta como uma regeneração (já houve um episódio).' : ' (não conta como regeneração).'}`
        : retryRegen ? ' «Tentar de novo» processa a entrevista outra vez e refaz o guião: conta como uma regeneração.' : '';
      body += `<div class="card"><h2 style="margin-top:0">Trabalhos</h2><table><tbody>${jobs.map((j: any) => `<tr><td>${esc(j.kind)}</td><td>${pill(j.state, j.state === 'done' ? 'ok' : j.state === 'failed' ? 'bad' : '')}</td><td>${j.progress_total ? `${j.progress_done}/${j.progress_total}` : ''}</td><td class="hint">${esc(j.error ?? '')}</td></tr>`).join('')}</tbody></table>

<form method="post" action="/entrevistas/${iv.id}/${retryGen ? 'gerar/repetir' : 'processar'}"><p class="hint">${failHint}${esc(retryNote)}</p>${retryPay ? payFields : ''}<button class="ghost" ${(retryPay && !canRegen) || retryOut ? 'disabled' : ''}>Tentar de novo${retryPay ? PAY : ''}</button></form>${retryPay ? regenHint : ''}</div>`;
    }

    // 3. Revisão editorial
    if (script && ['editorial_review', 'generating', 'qc', 'ready', 'stale', 'failed'].includes(iv.production_status)) {
      const segs: any[] = script.segments, flags: any[] = script.review_flags, blocking: string[] = script.blocking_issues;
      const flagged = new Set(flags.map((f: any) => f.segmentId));
      const items = await db.query(`SELECT q.id, q.position, q.text, a.selected_take_id, t.asset_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id LEFT JOIN answer_takes t ON t.id=a.selected_take_id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
      const trs = [];
      // Na 1.ª entrevista grátis, cada transcrição editada vai até um máximo pela duração da gravação (transcriptMax).
      for (const it of items) trs.push({ it, a: it.selected_take_id ? await latestTranscript(db, 'answer_take', it.selected_take_id) : null, max: it.selected_take_id ? await transcriptMax(db, iv, it.selected_take_id, req.user!.role === 'admin') : null });
      const editable = script.status === 'draft';
      // 1.ª entrevista grátis: verificações de fidelidade por IA com total por entrevista (o administrador não conta).
      const reviewsLeft = editable && iv.free_at && req.user!.role !== 'admin' ? FREE_SCRIPT_REVIEWS - await aiUsed(db, iv.id, 'script_review') : null;
      // Tamanho do guião editável: cada segmento abaixo do limite da síntese de voz e o total (na entrevista grátis, pelas respostas).
      const sizeLim = editable ? await scriptTotalMax(db, iv, req.user!.role === 'admin') : null;
      const sizeNote = `Cada segmento pode ter até ${milhares(SCRIPT_SEGMENT_MAX)} caracteres${sizeLim ? ` e o guião até ${milhares(sizeLim.max)}${sizeLim.free ? ' na 1.ª entrevista grátis' : ''} (tem ${milhares(segs.reduce((a, s) => a + String(s.textEnglish ?? '').length, 0))})` : ''}.`;
      body += `<div class="card"><h2 style="margin-top:0">2. Transcrições (originais)</h2>${iv.production_status === 'stale' ? '<div class="flash bad">As respostas mudaram depois do guião: aprovações invalidadas. Regenere o guião.</div>' : ''}
${trs.map(({ it, a, max }) => `<div class="seg"><strong>${it.position}. ${esc(it.text)}</strong>${it.asset_id ? `<br><audio controls preload="none" src="/media/${it.asset_id}"></audio>` : ''}
${a ? `<form method="post" action="/entrevistas/${iv.id}/transcricoes/${it.selected_take_id}"><textarea name="text"${max ? ` maxlength="${max.max}"` : ''} aria-label="Transcrição">${esc(a.text)}</textarea><button class="ghost" ${jobsLow ? 'disabled' : ''}>Guardar nova revisão (r${a.revision + 1})</button> <span class="hint">r${a.revision} · ${esc(a.origin)}</span></form>` : '<span class="hint">sem transcrição</span>'}</div>`).join('')}
${jobsLow ? `<p class="hint">Na 1.ª entrevista grátis, com menos de ${FREE_JOBS_FOR_SCRIPT} trabalhos de produção por usar, as transcrições e o guião já não se refazem: uma nova revisão de uma transcrição desatualiza o guião e o episódio, e refazê-los precisa de ${FREE_JOBS_FOR_SCRIPT}.</p>` : ''}<form method="post" action="/entrevistas/${iv.id}/guiao/regenerar">${exhausted && !jobsLow ? payFields : ''}<button class="ghost" ${aiAvailable() && canScript ? '' : 'disabled'}>Regenerar guião a partir das transcrições${exhausted && !jobsLow ? PAY : ''}</button></form>${exhausted && !jobsLow ? regenHint : ''}</div>

<div class="card"><h2 style="margin-top:0">3. Guião inglês — revisão ${script.revision} ${pill(script.status, script.status === 'approved' ? 'ok' : script.status === 'stale' ? 'bad' : '')}</h2>
<p class="hint">Título: ${esc(script.title_en)} · modelo ${esc(script.model)} · prompt ${esc(script.prompt_version)}</p>
${blocking.length ? `<div class="flash bad"><strong>Bloqueios editoriais:</strong><ul>${blocking.map(b => `<li>${esc(b)}</li>`).join('')}</ul></div>` : ''}
<form method="post" action="/entrevistas/${iv.id}/guiao">
${segs.map((s, i) => `<div class="seg ${s.speakerRole} ${flagged.has(s.id) ? 'flag' : ''}"><span class="hint sans">${esc(s.id)} · ${esc(s.speakerRole)} · ${esc(s.transformationType)}${s.sourceQuestionId ? '' : ' · editorial'}</span>
${flags.filter((f: any) => f.segmentId === s.id).map((f: any) => `<div class="hint" style="color:var(--warn)">⚑ ${esc(f.reason)}</div>`).join('')}
<textarea name="seg_${i}" ${editable ? `maxlength="${SCRIPT_SEGMENT_MAX}"` : 'readonly'} aria-label="Segmento ${esc(s.id)}">${esc(s.textEnglish)}</textarea></div>`).join('')}
${editable ? `<p class="hint">${esc(sizeNote)}</p><button class="ghost">Guardar como nova revisão (humana)</button>` : ''}</form>
${editable ? `<div class="row" style="margin-top:12px"><form method="post" action="/entrevistas/${iv.id}/guiao/verificar"><button class="ghost" ${aiAvailable() && (reviewsLeft == null || reviewsLeft > 0) ? '' : 'disabled'}>Verificação de fidelidade (assistente)</button></form>
<form method="post" action="/entrevistas/${iv.id}/guiao/aprovar" onsubmit="return confirm('Aprovar este guião para síntese de voz?')"><label class="check"><input type="checkbox" name="reviewed" value="1" required> Revi o guião contra as transcrições</label><button class="accent" ${blocking.length ? 'disabled' : ''}>Aprovar guião para síntese</button></form></div>
<p class="hint">O assistente só assinala possíveis problemas; nunca aprova nem substitui a revisão humana.${reviewsLeft == null ? '' : reviewsLeft > 0 ? ` 1.ª entrevista grátis: <span id="verificacoes">${FREE_SCRIPT_REVIEWS - reviewsLeft} de ${FREE_SCRIPT_REVIEWS}</span> verificações usadas.` : ` ${esc(FREE_REVIEWS_USED)}`}</p>` : ''}</div>`;

      if (script.status === 'approved' && !running && !['ready', 'qc'].includes(iv.production_status)) {
        const photos = coverOk ? await db.query('SELECT p.id, p.asset_id FROM photos p WHERE p.interview_id=$1', [iv.id]) : [];
        body += `<div class="card"><h2 style="margin-top:0">4. Gerar áudio, legendas e capa</h2>
<form method="post" action="/entrevistas/${iv.id}/gerar" onsubmit="return confirm('Gerar o episódio (operações pagas)?')">
<fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="sans">Línguas das legendas</legend>${SUBS.map(([v, l]) => `<label class="check"><input type="checkbox" name="subtitle_langs" value="${v}" ${iv.subtitle_langs.includes(v) ? 'checked' : ''}> ${l}</label>`).join('')}</fieldset>
${photos.length ? `<fieldset style="border:1px solid var(--line);border-radius:8px"><legend class="sans">Fotografias na capa (autorizadas; máx. 2)</legend><div class="thumbs">${photos.map((p: any) => `<label class="check"><input type="checkbox" name="cover_photo" value="${p.id}"><img alt="" src="/media/${p.asset_id}"></label>`).join('')}</div></fieldset>` : '<p class="hint">Sem fotografias autorizadas para a capa: será usada capa tipográfica sobre fundo ilustrado.</p>'}
<p class="hint">Vozes: entrevistador ${iv.question_voice === 'male' ? 'masculina' : 'feminina'} (“${esc(episodeVoice('host', iv.question_voice))}”), entrevistado ${iv.guest_voice === 'male' ? 'masculina' : 'feminina'} (“${esc(episodeVoice('guest', iv.guest_voice))}”) — altere em Editar. Vozes sintéticas de catálogo; sem clonagem. Será acrescentado o aviso audível: “${esc(config.aiDisclosure)}”</p>
${!procOk ? '<div class="flash bad">O entrevistado retirou a autorização de processamento por IA: não é possível gerar o episódio.</div>' : ''}
${episodeBefore ? payFields : ''}<button class="accent" ${(episodeBefore && !canRegen) || !procOk || jobsOut ? 'disabled' : ''}>Gerar episódio${episodeBefore ? PAY : ''}</button>${episodeBefore ? regenHint : ''}</form></div>`;
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
      const coverW = await coverWithdrawn(db, ep.id);
      const pubBlock = publishBlock({ ep, pubOk, coverWithdrawn: coverW, videoBusy: await videoBusy(iv.id, ep.id), hostAp: !!hostAp, needGuest, guestAp });
      const canPublish = !pubBlock;
      const isAdmin = req.user!.role === 'admin';
      // Veo sem orçamento: o administrador (custo interno) e o gestor da entidade com credenciais Google próprias (paga ela).
      const freeVeo = veoWithoutQuote(req.user, ent);
      // Animação por orçamento (titular que não é administrador; o administrador só prepara o rascunho do cliente).
      const quoteHtml = !ep.stale ? await quoteSection(db, iv, ep) : '';
      // Introdução animada do entrevistador (oferecida, fora do orçamento): só nos vídeos com o Google Veo.
      const introHint = !ep.stale && ep.status === 'preview' ? await introProductionHint(db, iv) : '';
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
<p class="sans"><a class="btn" href="/entrevistas/${iv.id}/episodio/${ep.id}/video.mp4" download>Descarregar vídeo (MP4)</a> <span class="hint">Legendas: ${esc(ep.video_lang ?? 'sem legendas')}${videoMeta?.animatedSegments ? ` · ${videoMeta.animatedSegments} falas animadas${videoMeta.failedAnimations ? `, ${videoMeta.failedAnimations} com imagem fixa por falha` : ''} · custo da animação ~$${Number(videoMeta.lipsyncUsd ?? 0).toFixed(2)}` : ''}${videoMeta?.engine === 'veo' ? ` · ${clipModelsNote(videoMeta) ? 'pedido ao ' : ''}${esc(videoMeta.tier ? veoLabel(videoMeta.tier === 'lite' ? 'lite' : 'fast') : 'Google Veo')}${videoMeta.model ? ` (${esc(videoMeta.model)})` : ''}: ${videoMeta.veoClips} clipes (${videoMeta.generatedClips} gerados nesta vez${videoMeta.failedUsd !== undefined ? `, ~$${Number(videoMeta.spentUsd ?? 0).toFixed(2)} pagos nesta geração${videoMeta.failedUsd ? `, ~$${Number(videoMeta.failedUsd).toFixed(2)} em operações que falharam na Google` : ''}` : ''})${clipModelsNote(videoMeta) ? ` · ${esc(clipModelsNote(videoMeta))}` : ''} · clipes deste vídeo ~$${Number(videoMeta.veoUsd ?? 0).toFixed(2)}${videoMeta.fallbackSegments?.length ? ` · ${videoMeta.fallbackSegments.length} falas com imagem fixa` : ''}${videoMeta.paidBy === 'entity' ? ' · pago pela entidade, no projeto Google dela (sem créditos)' : ''}${videoMeta.intro ? ' · com a introdução animada do entrevistador (oferecida)' : ''}` : ''}${veoSpent ? ` · total pago ao Google Veo nesta entrevista ~$${veoSpent.toFixed(2)}` : ''}${veoFailed ? ` · operações falhadas na Google ~$${veoFailed.toFixed(2)} (normalmente não cobradas; confirme no painel da Google)` : ''}</span></p>
${videoMeta?.googleBusy ? '<div class="flash">O Google Veo estava com procura elevada: algumas falas ficaram com a fotografia fixa. Gere de novo mais tarde; os clipes já obtidos são reaproveitados e só se pagam os que faltam.</div>' : ''}
${videoMeta?.engine === 'veo' ? `<details ${videoMeta.fidelityIssues || videoMeta.fallbackSegments?.length ? 'open' : ''}><summary class="sans">Fidelidade ao guião: ${videoMeta.fidelityIssues ? `${videoMeta.fidelityIssues} pedaço(s) sem clipe aprovado (não disseram o texto aprovado ou não foi possível verificar); essas falas ficaram com a fotografia fixa e a voz do episódio` : 'todos os clipes dizem o texto aprovado'}</summary>
<table class="sans"><thead><tr><th>Fala</th><th>Guião</th><th>Ouvido no vídeo</th><th>Resultado</th></tr></thead><tbody>${(videoMeta.fidelity ?? []).map((f: any) => `<tr><td>${esc(f.segmentId)}</td><td>${esc(f.expected)}</td><td>${esc(f.heard || '—')}</td><td>${f.ok ? pill(f.edits ? 'coincide (grafia de nome)' : 'coincide', 'ok') : f.problem === 'busy' ? pill('Google indisponível (procura elevada): fotografia fixa', 'warn') : f.problem === 'busycap' ? pill('em pausa após 4 falhas da Google em 36 h (gere de novo mais tarde): fotografia fixa', 'warn') : f.problem === 'filtered' ? pill('bloqueado pelos filtros da Google: fotografia fixa', 'warn') : f.problem === 'capped' ? pill(`limite de tentativas esgotado${f.cause ? ` (${f.cause})` : ''}: fotografia fixa`, 'warn') : f.problem === 'capped_budget' ? pill('teto do orçamento atingido: fotografia fixa, não cobrada', 'warn') : f.problem === 'breaker' ? pill('disjuntor (demasiadas repetições falhadas): fotografia fixa, não cobrada', 'warn') : f.problem === 'no_clips' ? pill('clipes já pagos indisponíveis: fotografia fixa', 'warn') : f.problem === 'unchecked' ? pill('não verificado: fotografia fixa', 'warn') : f.problem === 'error' ? pill('falhou na Google: fotografia fixa', 'warn') : !f.checked ? pill('não verificado: fotografia fixa', 'warn') : pill(`${f.edits ?? '?'} diferença(s): fotografia fixa`, 'bad')}${f.ok && !f.used ? ' <span class="hint">(outra parte da fala falhou: fala em fotografia fixa)</span>' : ''}${f.attempts > 1 ? ` <span class="hint">${f.attempts} tentativas</span>` : ''}${f.reused ? ' <span class="hint">(reaproveitado: fala já paga)</span>' : ''}</td></tr>`).join('')}</tbody></table></details>` : ''}` : '<p class="hint">Ainda não foi gerado.</p>'}
${!live && lastVideoJob?.state === 'failed' ? `<div class="flash bad">A última geração do vídeo não terminou: ${esc(String(lastVideoJob.error ?? '').slice(0, 400))}</div>` : ''}
${!ep.stale ? `${ep.status !== 'preview' ? `<p class="hint"><strong>${esc(VIDEO_ONLY_PREVIEW)}</strong></p>` : videosOut ? `<div class="flash" id="videos-aviso">${FREE_VIDEOS_USED_HTML}</div>` : `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/video" class="row" onsubmit="return confirm('Gerar o vídeo?')">
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
${introHint}
${quoteHtml}
${ep.video_asset_id && ep.status !== 'published' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/video/retirar" onsubmit="return confirm('Tirar o vídeo deste episódio? O ficheiro fica guardado em privado.')"><button class="ghost">Tirar o vídeo do episódio (volta à versão sem vídeo)</button></form>` : ''}
<p class="hint">Capa durante o aviso inicial e o agradecimento final; composição de estúdio com as duas fotografias autorizadas durante a apresentação; a partir da primeira pergunta, só quem fala, em grande plano. Grafismo incluído em todos os planos, sem IA: cartão de título a seguir ao aviso (título, «with» e o nome do convidado, marca), rodapé com o nome e a função de cada um quando fala pela primeira vez (acima das legendas), título de capítulo em cada pergunta e cartão final, sobre um fundo em movimento feito da capa (os cartões acrescentam ~8 s em silêncio). As legendas ficam gravadas na imagem, numa só língua. Só entram fotografias autorizadas (a do convidado exige autorização de publicação).</p>` : ''}
${!pubOk ? '<div class="flash bad">O entrevistado não autorizou a publicação.</div>' : ''}
${ep.status === 'withdrawn' ? `<p class="sans">Retirado em ${fmtDate(ep.withdrawn_at)}.</p><p class="hint">${esc(pubBlock ?? '')}</p>`
  : ep.status !== 'published' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/publicar" onsubmit="return confirm('Publicar agora?')"><label for="vis">Modalidade</label><select id="vis" name="visibility"><option value="private">Privado (só pessoas autorizadas)</option><option value="unlisted" ${iv.planned_visibility === 'unlisted' ? 'selected' : ''}>Não listado (quem tem o link; não equivale a privado)</option><option value="public" ${iv.planned_visibility === 'public' ? 'selected' : ''}>Público (indexável)</option></select>
<fieldset style="border:1px solid var(--line);border-radius:8px;margin-top:12px"><legend class="sans">Galeria pública «Podcasts gerados»</legend>
<label class="check"><input type="checkbox" name="gallery" value="1"> Permito que este episódio fique na galeria pública do portal, para consulta, organizada por temas (só para episódios públicos).</label>
<label for="th">Tema</label><input id="th" name="theme" type="text" list="themes" maxlength="60" placeholder="Ex.: Energia, Telecomunicações, Hotelaria"><datalist id="themes">${(await db.query(`SELECT DISTINCT theme FROM episodes WHERE theme<>'' ORDER BY theme`)).map((t: any) => `<option value="${esc(t.theme)}">`).join('')}</datalist></fieldset>
<p><button class="accent" ${canPublish ? '' : 'disabled'}>Publicar</button></p>${canPublish ? '' : `<p class="hint">Ainda não é possível publicar: ${esc(pubBlock ?? '')} (Publicar exige a aprovação válida do entrevistador${needGuest ? ' e do entrevistado' : ''}, a autorização de publicação, a versão atual e nenhum alerta de qualidade.)</p>`}</form>`
  : `<p class="sans">Publicado (${esc(ep.visibility)}) em ${fmtDate(ep.published_at)}${ep.visibility !== 'private' ? ` · <a href="/e/${ep.slug}">/e/${esc(ep.slug)}</a>` : ''}</p>
${coverW ? '<p class="hint">O entrevistado retirou a autorização da capa: a capa, a miniatura e o vídeo (que mostra a capa) deixaram de ser mostrados neste episódio publicado, até ele voltar a autorizar.</p>' : ''}
${ep.visibility === 'public' ? `<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/galeria" class="card"><strong class="sans">Galeria pública «Podcasts gerados»</strong>
<label class="check"><input type="checkbox" name="gallery" value="1" ${ep.gallery ? 'checked' : ''}> Mostrar na galeria pública, organizada por temas</label>
<label for="th2">Tema</label><input id="th2" name="theme" type="text" maxlength="60" value="${esc(ep.theme)}"><button class="ghost">Guardar</button></form>` : ''}
<form method="post" action="/entrevistas/${iv.id}/episodio/${ep.id}/retirar" onsubmit="return confirm('Retirar o episódio?')"><button class="danger">Retirar episódio</button></form>
<p class="hint">Cópias já descarregadas ou distribuídas externamente podem não ser recuperáveis.</p>`}</div>`;
    }
    if (!live && (script || ep || ['failed', 'stale', 'editorial_review', 'ready', 'qc'].includes(iv.production_status))) {
      body += `<div class="card"><h2 style="margin-top:0">Recomeçar a produção</h2>
<p class="hint">Arquiva o guião e o episódio atuais (não são eliminados) e volta ao passo «Processar podcast». As gravações e as transcrições originais mantêm-se. Se o episódio estiver publicado, é retirado e sai da galeria.</p>
<form method="post" action="/entrevistas/${iv.id}/producao/recomecar" onsubmit="return confirm('Arquivar o guião e o episódio atuais e recomeçar a produção?')"><button class="danger" ${(scriptBefore && !canRegen) || jobsLow ? 'disabled' : ''}>Recomeçar produção</button></form>${scriptPay ? `${regenHint}${canRegen ? `<p class="hint">Depois de recomeçar, processar de novo custa ${cr(EXTRA_REGEN_CENTS)} crédito.</p>` : ''}` : ''}</div>`;
    }
    body += '</div>';
    return reply.type('text/html; charset=utf-8').send(page({ title: 'Produção', body, noindex: true, script: live ? '/static/progress.js' : '/static/player.js', nav: `<a href="/painel">Painel</a>${helpNav(req.user)}` }));
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
    // Entrevista grátis sem os trabalhos de produção de um guião novo (FREE_JOBS_FOR_SCRIPT): processar de novo seria recusado,
    // e a produção atual não se arquiva. Antes da regra do crédito (que mandaria carregar créditos sem servir de nada).
    const freeBlock = freeJobsBlock(await freeJobsFor(req, iv), FREE_JOBS_FOR_SCRIPT);
    if (freeBlock) return back(reply, iv.id, undefined, `${freeBlock} Não é possível recomeçar a produção.`);
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
    // Processar quando já houve um guião (depois de «Recomeçar» ou de uma falha) refaz o guião: é uma regeneração. O trabalho
    // que falhou não conta (regenerationsUsed), conta o que o refaz. Antes, «Tentar de novo» depois de qualquer falha não
    // contava: uma geração do episódio que falhava logo ao início e sem custo (autorização retirada pelo convidado,
    // transcrição editada antes de o trabalho começar) tornava gratuito o guião seguinte, sem fim. Depois de uma geração do
    // episódio que falhou, «Tentar de novo» repete-a (/gerar/repetir) em vez de processar.
    const r = await enqueueProduction(req, iv.id, 'process_submission', (tx, cur) => hadScript(tx, cur.id), async tx => {
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
    const raw = String((req.body as any)?.text ?? '').trim();
    const text = raw.slice(0, 20000);
    // 1.ª entrevista grátis: até um máximo pela duração da gravação (transcriptMax); acima, nada se grava.
    const lim = cur && text && text !== cur.text ? await transcriptMax(db, iv, takeId, req.user!.role === 'admin') : null;
    if (lim && raw.length > lim.max)
      return back(reply, iv.id, undefined, `Transcrição não guardada. Na 1.ª entrevista grátis, a transcrição desta resposta pode ter até ${milhares(lim.max)} caracteres (calculado a partir de ${lim.minutes.toFixed(1).replace('.', ',')} min de gravação) e tem ${milhares(raw.length)}. Encurte o texto.`);
    // 1.ª entrevista grátis: uma revisão desatualiza o guião e o episódio, e refazê-los precisa de FREE_JOBS_FOR_SCRIPT trabalhos
    // de produção. Antes, a 7 de 8, gravar uma transcrição punha o episódio pronto como desatualizado, regenerar o guião gastava
    // o último trabalho e o episódio, que só esperava a aprovação, deixava de se poder publicar.
    const freeBlock = cur && text && text !== cur.text ? freeJobsBlock(await freeJobsFor(req, iv), FREE_JOBS_FOR_SCRIPT) : null;
    if (freeBlock) return back(reply, iv.id, undefined, `Transcrição não guardada. ${freeBlock}`);
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
    const blocked = await scriptAiBlock(iv);
    if (blocked) return back(reply, iv.id, undefined, blocked);
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
    // Tamanho: cada segmento abaixo do limite da síntese de voz e o guião abaixo do total (na entrevista grátis, pelas respostas).
    const big = await scriptSizeError(db, iv, segs, req.user!.role === 'admin');
    if (big) return back(reply, iv.id, undefined, `Revisão não guardada. ${big}`);
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
    const blocked = await scriptAiBlock(iv);
    if (blocked) return back(reply, iv.id, undefined, blocked);
    if (!rateLimit(`review:${iv.id}`, 6, 3600_000)) return back(reply, iv.id, undefined, 'Limite de verificações atingido.');
    const s = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    if (!s) return back(reply, iv.id, undefined, 'Sem guião editável.');
    // 1.ª entrevista grátis: total por entrevista, contado na base antes de chamar a IA; a vez só volta se a OpenAI não respondeu.
    const counted = !!iv.free_at && req.user!.role !== 'admin';
    if (counted && !(await takeAiUse(db, iv.id, 'script_review', FREE_SCRIPT_REVIEWS))) return back(reply, iv.id, undefined, FREE_REVIEWS_USED);
    const items = await db.query(`SELECT q.id, q.text, a.selected_take_id FROM questions q LEFT JOIN answers a ON a.question_id=q.id WHERE q.interview_id=$1 ORDER BY q.position`, [iv.id]);
    const tr = [];
    for (const it of items) tr.push({ questionId: it.id, question: it.text, answer: it.selected_take_id ? (await latestTranscript(db, 'answer_take', it.selected_take_id))?.text : null });
    // Os tokens ficam no usage_ledger ('review_tokens'), também numa resposta paga que falha depois (cortada, inválida).
    const meter = newMeter();
    try {
      const r = await reviewScript(tr, s.segments, meter).finally(() => recordTextUsage(db, iv.id, 'review_tokens', meter));
      const flags = [...s.review_flags, ...r.issues.map((i: any) => ({ segmentId: String(i.scriptSegmentId), reason: `[${i.severity}] ${i.explanation}` }))];
      await db.query('UPDATE scripts SET review_flags=$2 WHERE id=$1', [s.id, JSON.stringify(flags)]);
      return back(reply, iv.id, r.issues.length ? `${r.issues.length} possíveis problemas assinalados.` : 'Sem alertas — isto não substitui a revisão humana.');
    } catch (e: any) {
      // Antes, a vez voltava em qualquer erro, também depois de uma resposta paga que falhava aqui (JSON cortado, um problema
      // null): com o guião e as transcrições, escritos pelo próprio entrevistador, provocava-se a falha e o total deixava de contar.
      if (counted && await aiNotAnswered(e)) await giveBackAiUse(db, iv.id, 'script_review');
      return back(reply, iv.id, undefined, 'Falha na verificação: ' + String(e?.message ?? e).slice(0, 120));
    }
  });

  app.post('/entrevistas/:id/guiao/aprovar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const s = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    if (!s || s.blocking_issues.length || !(req.body as any)?.reviewed) return back(reply, iv.id, undefined, 'Não é possível aprovar (bloqueios ou revisão não confirmada).');
    if (!(await submittedOnce(iv))) return back(reply, iv.id, undefined, 'A entrevista não foi submetida.');
    if (!(await consent(iv.id, 'processing'))) return back(reply, iv.id, undefined, 'Autorização de processamento retirada.');
    const big = await scriptSizeError(db, iv, s.segments, req.user!.role === 'admin');
    if (big) return back(reply, iv.id, undefined, `Não é possível aprovar. ${big}`);
    await db.query(`UPDATE scripts SET status='approved', approved_at=now() WHERE id=$1`, [s.id]);
    await db.query(`INSERT INTO approvals(interview_id, kind, actor, script_id, decision) VALUES ($1,'script','interviewer',$2,'approved')`, [iv.id, s.id]);
    await audit(db, req.user!.email, 'script.approved', iv.id, { revision: s.revision });
    return back(reply, iv.id, 'Guião aprovado para síntese.');
  });

  /**
   * Põe na fila a geração do episódio do guião aprovado `s` («Gerar episódio» e «Tentar de novo»). Com a autorização de
   * processamento do convidado (antes, o /gerar não a verificava e o trabalho falhava logo ao início) e o guião dentro dos
   * tamanhos (scriptSizeError). O primeiro episódio da entrevista está incluído; gerar outro é uma regeneração.
   */
  const queueGeneration = async (req: any, reply: any, iv: any, s: any, o: { langs: string[]; photos: string[]; dedupe: (tx: Db) => Promise<string>; retry?: boolean }) => {
    const blocked = await scriptAiBlock(iv);
    if (blocked) return back(reply, iv.id, undefined, blocked);
    // Só com «o entrevistado aprova» o pedido de alterações do convidado trava uma nova geração do mesmo guião (como no main com host_only).
    if (iv.review_policy === 'guest_preview' && await db.one(`SELECT 1 FROM approvals a JOIN episodes e ON e.id=a.episode_id WHERE e.script_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes' LIMIT 1`, [s.id]))
      return back(reply, iv.id, undefined, 'O convidado pediu alterações a um episódio deste guião: reveja o guião e aprove uma nova revisão antes de gerar.');
    const big = await scriptSizeError(db, iv, s.segments, req.user.role === 'admin');
    if (big) return back(reply, iv.id, undefined, `Não é possível gerar o episódio. ${big}`);
    const est = await estimateCost(db, iv.id, o.langs.length ? o.langs : subtitleLangs(iv.subtitle_langs));
    const r = await enqueueProduction(req, iv.id, 'generate_episode', (tx, cur) => hadEpisode(tx, cur.id), async tx =>
      ({ input: { scriptId: s.id, subtitleLangs: o.langs, coverPhotoIds: o.photos }, dedupe: await o.dedupe(tx), costUsd: est.parts.speech + est.parts.text + est.parts.cover }));
    if (r.blocked) return back(reply, iv.id, undefined, r.blocked);
    if (r.busy) return back(reply, iv.id, undefined, BUSY);
    if (!r.id) return back(reply, iv.id, undefined, 'Já existe uma geração com esta configuração para este guião. Altere o guião ou a configuração.');
    await db.query(`UPDATE interviews SET production_status='queued' WHERE id=$1`, [iv.id]);
    await audit(db, req.user.email, 'episode.generate', iv.id, o.retry ? { retry: true } : undefined);
    return back(reply, iv.id, o.retry ? 'Geração iniciada de novo.' : 'Geração iniciada.');
  };

  app.post('/entrevistas/:id/gerar', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const s = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='approved' ORDER BY revision DESC LIMIT 1`, [iv.id]);
    if (!s) return back(reply, iv.id, undefined, 'Aprove primeiro o guião.');
    const b = req.body as any;
    // Só as línguas oferecidas e cada uma uma vez (subtitleLangs): cada uma é uma tradução paga das legendas.
    const langs = subtitleLangs(b.subtitle_langs);
    const photos = await ownPhotos(iv.id, ([] as unknown[]).concat(b.cover_photo ?? []));
    const cfg = sha256(JSON.stringify([langs.sort(), photos.sort(), config.openai.voices, config.openai.models]));
    return queueGeneration(req, reply, iv, s, { langs, photos, dedupe: async () => `gen:${s.id}:${cfg}` });
  });

  // «Tentar de novo» depois de uma geração do episódio que falhou, com o guião dela ainda aprovado: a mesma geração (legendas e
  // fotografias), com uma chave nova que leva o número da tentativa (a anterior ficou com a dela). Não conta como regeneração
  // enquanto não houver episódio (hadEpisode ignora os falhados), como o primeiro «Gerar episódio»; antes, «Tentar de novo»
  // processava de novo (transcrições e guião).
  app.post('/entrevistas/:id/gerar/repetir', async (req, reply) => {
    const iv = await guard(req, reply); if (!iv) return;
    const prev = await failedGeneration(db, iv.id);
    if (!prev) return back(reply, iv.id, undefined, 'Não há nenhuma geração do episódio falhada para repetir com o guião aprovado.');
    const s = await db.one('SELECT * FROM scripts WHERE id=$1 AND interview_id=$2', [prev.scriptId, iv.id]);
    const langs = subtitleLangs(Array.isArray(prev.subtitleLangs) ? prev.subtitleLangs : []);
    const photos = await ownPhotos(iv.id, Array.isArray(prev.coverPhotoIds) ? prev.coverPhotoIds : []);
    return queueGeneration(req, reply, iv, s, { langs, photos, retry: true, dedupe: async tx =>
      `gen:${s.id}:tentativa:${Number((await tx.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [iv.id])).n)}` });
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
    const blocked = publishBlock({ ep, pubOk: await consent(iv.id, 'publish'), coverWithdrawn: await coverWithdrawn(db, ep.id), videoBusy: await videoBusy(iv.id, ep.id), hostAp: !!hostAp, needGuest, guestAp });
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
    const VIDEO_BUSY = 'Já há um vídeo a ser gerado; aguarde que termine.';
    const videoInQueue = (q: Db) => q.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind='render_video' AND (state='queued' OR (state='running' AND locked_at > now() - interval '15 minutes'))`, [c.iv.id]);
    if (await videoInQueue(db)) return back(reply, c.iv.id, undefined, VIDEO_BUSY);
    const admin = req.user!.role === 'admin';
    // 1.ª entrevista grátis: total de gerações do vídeo com fotografias (FREE_VIDEO_RENDERS), antes das verificações do Veo; contado outra vez na transação.
    if (c.iv.free_at && !admin && (await freeVideoRenders(db, c.iv.id)) >= FREE_VIDEO_RENDERS) return back(reply, c.iv.id, undefined, FREE_VIDEOS_USED);
    if (engine === 'veo') {
      if ((await db.one('SELECT status FROM scripts WHERE id=$1', [c.ep.script_id]))?.status !== 'approved') return back(reply, c.iv.id, undefined, VEO_SCRIPT_REPLACED);
      if (await db.one(`SELECT 1 FROM approvals a JOIN episodes e ON e.id=a.episode_id WHERE e.script_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes' LIMIT 1`, [c.ep.script_id])) return back(reply, c.iv.id, undefined, VEO_CHANGES);
      if (!config.openai.mock && !inEntity(ent, () => veoConfigured())) return back(reply, c.iv.id, undefined, VEO_NO_CREDENTIALS);
      if (!config.openai.mock && !inEntity(ent, () => aiAvailable())) return back(reply, c.iv.id, undefined, 'Falta a chave da OpenAI (transcrição para verificar os clipes) em Definições.');
    }
    // Contado e posto na fila com a entrevista bloqueada (como o enqueueProduction): dois pedidos em simultâneo na última
    // geração grátis não passam os dois. `admin`: o vídeo do administrador não conta para o total (freeVideoRenders).
    const r = await db.tx(async (tx): Promise<{ blocked?: string }> => {
      await tx.one('SELECT id FROM interviews WHERE id=$1 FOR UPDATE', [c.iv.id]);
      if (await videoInQueue(tx)) return { blocked: VIDEO_BUSY };
      if (c.iv.free_at && !admin && (await freeVideoRenders(tx, c.iv.id)) >= FREE_VIDEO_RENDERS) return { blocked: FREE_VIDEOS_USED };
      const n = Number((await tx.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind='render_video'`, [c.iv.id])).n);
      await enqueue(tx, { kind: 'render_video', interviewId: c.iv.id, input: { episodeId: c.ep.id, lang: lang && c.ep.subtitles?.[lang] ? lang : null, animate: engine === 'lipsync', requestedBy: req.user!.id, ...(engine === 'veo' ? { engine: 'veo', veoRetries: 1 } : {}), ...(admin && c.iv.free_at ? { admin: true } : {}) }, dedupe: `video:${c.ep.id}:${n}` });
      return {};
    });
    if (r.blocked) return back(reply, c.iv.id, undefined, r.blocked);
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
