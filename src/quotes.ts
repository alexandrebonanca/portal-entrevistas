import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc } from './lib.ts';
import { enqueue } from './jobs.ts';
import { queueEmail, emailShell } from './mail.ts';
import { inEntity } from './settings.ts';
import { veoTier, veoModel, veoLabel, veoConfigured, veoKeyModel, type VeoTier } from './talking.ts';
import { aiAvailable } from './ai/openai.ts';
import { veoPlan, inputsHashOf, chunkExhausted, chunkKeyOf, releaseQuote, namesUsedIn, personNames, veoWithoutQuote, VEO_MAX_ATTEMPTS, VEO_NOTICE, FALA_REASON,
  VEO_ONLY_PREVIEW, VEO_SCRIPT_REPLACED, VEO_CHANGES, VEO_NO_CREDENTIALS, type PlanSeg } from './veo-episode.ts';
import { walletFor, reserve, spendBlock, cr } from './wallet.ts';
import { seller, checkoutBlock, sellerBlock, TERMS_VERSION, WITHDRAWAL_DAYS, type Seller } from './legal.ts';
import { vatForProfile } from './billing.ts';
import { withVat, eurPt } from './vat.ts';

/**
 * Orçamento firme da animação (1 crédito = 1 € sem IVA). O cliente vê segundos de fala, medidos no áudio do episódio:
 * por fala s = max(4, ⌈duração⌉) s e p = ⌈s × tarifa⌉ cêntimos; o orçamento é a soma das falas escolhidas ainda não pagas.
 * O arredondamento dos clipes a 4/6/8 s e as repetições ficam do nosso lado, travados pelo teto interno.
 */
/** Parte do orçamento que pode ir para a Google: 1 − 15% de margem mínima − 3,5% de comissões do cartão. */
export const CAP_RATIO = 0.815;
export const QUOTE_VALID_DAYS = 7;
export const MIN_SPEECH_SEC = 4;
/**
 * Um orçamento aceite tem este prazo para começar, contado a partir do momento em que o trabalho pode arrancar
 * (jobs.ready_at: via dos vídeos livre e nada à frente). A espera pelos vídeos à frente na fila não conta.
 */
export const START_DEADLINE_HOURS = 24;

export interface AnimationRate {
  id: string; engine: string; tier: string | null; label: string; cents_per_min: number; cost_usd_per_sec: number; usd_eur: number;
  max_clip_sec: number; resolution: string; available: boolean; active: boolean; valid_until: string | Date | null; version: number;
}

export const speechSec = (durationMs: number) => Math.max(MIN_SPEECH_SEC, Math.ceil((Number(durationMs) || 0) / 1000));
/** Preço de uma fala em cêntimos (créditos × 100), arredondado ao cêntimo para cima. */
export const segmentCents = (sec: number, centsPerMin: number) => Math.ceil((sec * centsPerMin) / 60);
/** Teto em dólares de um valor em cêntimos: Q × 0,815 ÷ câmbio (4 casas, por defeito). */
export const budgetUsd = (cents: number, usdEur: number) => Math.floor(((cents / 100) * CAP_RATIO / usdEur) * 10000) / 10000;
/** Tarifa mínima recomendada (cr/min) para 55% de margem típica depois do cartão: custo típico ÷ 0,415 (fatores 1,55 × 1,25 ÷ 0,9). */
export const recommendedCentsPerMin = (r: Pick<AnimationRate, 'cost_usd_per_sec' | 'usd_eur'>) => Math.ceil(((r.cost_usd_per_sec * 2.1528 * r.usd_eur) / 0.415) * 60 * 100);

export const allRates = (db: Db) => db.query<AnimationRate>('SELECT * FROM animation_rates ORDER BY available DESC, engine, cents_per_min DESC');
/** Tarifa do nível escolhido em Definições (Fast ou Lite); null se esse motor não estiver ativo ou já tiver sido desativado. */
export async function rateForTier(db: Db, tier: VeoTier): Promise<AnimationRate | null> {
  const r = await db.one<AnimationRate>(`SELECT * FROM animation_rates WHERE engine='veo' AND tier=$1`, [tier]);
  return r?.active && r.available && (!r.valid_until || new Date(r.valid_until).getTime() > Date.now()) ? r : null;
}

export class QuoteError extends Error {}
/**
 * Nível do Veo de um orçamento: o das Definições globais. Um orçamento é pago com créditos e gera-se sempre com as
 * credenciais Google do portal (veo-episode.ts), mesmo para um entrevistador de uma entidade com credenciais próprias.
 */
export const quoteTier = (): VeoTier => 'fast'; // o Premium vende-se sempre com o Fast (o Lite pôs texto inventado no ecrã no Laboratório)
/** Entrevista do gestor de uma entidade com credenciais Google próprias: o Veo gera-se sem orçamento nem créditos. */
export const ENTITY_VEO_NO_QUOTE = 'A entidade tem credenciais Google próprias: o gestor gera o vídeo do Google Veo sem orçamento nem créditos (a Google cobra no projeto Google da entidade), na opção do vídeo acima.';
const guestAskedChanges = async (db: Db, scriptId: string) => !!(await db.one(`SELECT 1 FROM approvals a JOIN episodes e ON e.id=a.episode_id WHERE e.script_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes' LIMIT 1`, [scriptId]));
const ownerOf = (db: Db, iv: any) => db.one('SELECT id, email, name, role, entity_id FROM users WHERE id=$1', [iv.owner_id]);
export const isConsumerOwner = async (db: Db, userId: string) => (await db.one('SELECT kind FROM billing_profiles WHERE user_id=$1', [userId]))?.kind === 'consumer';
/**
 * Regime de IVA dos dados de faturação do cliente (o dos carregamentos): 'domestic', 'reverse_charge', 'not_registered', …;
 * null sem dados. Decide o texto do preço («+ IVA, já pago no carregamento» só quando houve IVA).
 */
export async function vatRegimeOf(db: Db, userId: string, s: Seller): Promise<string | null> {
  const p = await db.one('SELECT * FROM billing_profiles WHERE user_id=$1', [userId]);
  if (!p) return s.regime === 'not_registered' ? 'not_registered' : null;
  const d = vatForProfile(p, s);
  return d.ok ? d.regime : null;
}
/** Taxa de IVA com que o consumidor pagou os créditos (para mostrar o € com IVA primeiro); null para empresas ou sem dados. */
export async function consumerVatRate(db: Db, userId: string, s: Seller): Promise<number | null> {
  const p = await db.one('SELECT * FROM billing_profiles WHERE user_id=$1', [userId]);
  if (p?.kind !== 'consumer') return null;
  const d = vatForProfile(p, s);
  return d.ok ? d.rate : null;
}

/** Porque é que não se pode orçamentar (nem gerar) a animação deste episódio agora; null = pode. As mesmas regras do trabalho. */
export async function quoteBlock(db: Db, iv: any, ep: any): Promise<string | null> {
  if (ep.stale || ep.status !== 'preview') return VEO_ONLY_PREVIEW;
  if ((await db.one('SELECT status FROM scripts WHERE id=$1', [ep.script_id]))?.status !== 'approved') return VEO_SCRIPT_REPLACED;
  if (await guestAskedChanges(db, ep.script_id)) return VEO_CHANGES;
  const owner = await ownerOf(db, iv);
  if (!config.openai.mock && !inEntity(null, () => veoConfigured())) return VEO_NO_CREDENTIALS; // credenciais do portal (ver quoteTier)
  if (!config.openai.mock && !inEntity(owner?.entity_id, () => aiAvailable())) return 'Falta a chave da OpenAI (transcrição para verificar os clipes) em Definições.';
  return null;
}

/** Falas que se podem animar num episódio, com os segundos e os créditos de cada uma (antes do reaproveitamento). */
export function candidateFalas(ep: any, scriptSegs: any[], allowed: { host: boolean; guest: boolean }, rate: AnimationRate) {
  const textOf = new Map<string, string>(scriptSegs.map((s: any) => [s.id, String(s.textEnglish ?? '')]));
  return ((ep.technical?.timing ?? []) as any[])
    .filter(t => t.kind !== 'disclosure' && (t.role === 'host' ? allowed.host : allowed.guest) && (textOf.get(t.id) ?? '').trim())
    .map(t => { const sec = speechSec(t.durationMs); return { id: String(t.id), role: t.role as 'host' | 'guest', kind: String(t.kind ?? ''), text: textOf.get(t.id)!, sec, cents: segmentCents(sec, rate.cents_per_min) }; });
}

/** A cobrança de uma fala ainda serve para a reaproveitar (todos os clipes guardados, nenhum rejeitado)? */
async function chargeUsable(db: Db, interviewId: string, reuseKey: string, take: number) {
  const ch = await db.one('SELECT chunks FROM animation_charges WHERE interview_id=$1 AND reuse_key=$2 AND take=$3', [interviewId, reuseKey, take]);
  if (!ch || !(ch.chunks as any[]).length) return false;
  for (const x of ch.chunks as any[]) if (!(await db.one(`SELECT 1 FROM assets WHERE id=$1 AND deleted_at IS NULL AND COALESCE(meta->>'rejected','')<>'true'`, [x.assetId]))) return false;
  return true;
}

/**
 * Takes do orçamento: o de cada fala é o seguinte ao último rejeitado; uma fala cujos pedaços já esgotaram as tentativas
 * sem clipe aprovado passa a um take novo (tentativas novas, que o cliente só paga se a fala sair animada).
 */
async function quoteTakes(db: Db, iv: any, segs: PlanSeg[], plan: { start: Record<string, { hash: string; vertical: boolean } | null> }, tier: VeoTier) {
  const takes = new Map<string, number>();
  for (const s of segs) {
    const st = plan.start[s.role]!;
    let take = s.take;
    for (let k = 0; k < 5; k++) {
      const keys = s.chunks.map(c => chunkKeyOf(st.hash, c.prompt, st.vertical, veoKeyModel(tier), config.openai.mock, take));
      let exhausted = false;
      for (const key of keys) if (await chunkExhausted(db, iv.id, key, VEO_MAX_ATTEMPTS)) { exhausted = true; break; }
      if (!exhausted) break;
      take++;
    }
    takes.set(s.id, take);
  }
  return takes;
}

/** Rascunho grátis (não cativa nada): calcula a tabela por fala, o total, o teto interno e a impressão das entradas. */
export async function createQuote(db: Db, o: { iv: any; ep: any; actor: { email: string }; segmentIds: string[]; lang: string | null }) {
  const { iv, ep } = o;
  const block = await quoteBlock(db, iv, ep);
  if (block) throw new QuoteError(block);
  const owner = await ownerOf(db, iv);
  if (!owner) throw new QuoteError('Entrevista sem titular.');
  if (owner.role === 'admin') throw new QuoteError('Esta entrevista é do administrador: o vídeo do Google Veo gera-se sem orçamento (custo interno).');
  if (veoWithoutQuote(owner, owner.entity_id)) throw new QuoteError(ENTITY_VEO_NO_QUOTE);
  if (await db.one(`SELECT 1 FROM animation_quotes WHERE episode_id=$1 AND status IN ('accepted','running')`, [ep.id])) throw new QuoteError('Já há um orçamento aceite em curso para este episódio: aguarde que a produção termine.');
  return inEntity(owner.entity_id, async () => {
    const tier = quoteTier();
    const rate = await rateForTier(db, tier);
    if (!rate) throw new QuoteError(`A animação com o ${veoLabel(tier)} não está disponível de momento (motor inativo nas tarifas).`);
    const pick = new Set(o.segmentIds);
    let plan = await veoPlan(db, iv, ep, { tier });
    if (!plan.hostVeo && !plan.guestVeo) throw new QuoteError('Ninguém autorizou o vídeo gerado pelo Google Veo (entrevistador: em Editar; convidado: em «Autorizações das fotografias», e só com a política «o entrevistado aprova»).');
    let segs = plan.segs.filter(s => s.chunks.length && pick.has(s.id));
    if (!segs.length) throw new QuoteError('Escolha pelo menos uma fala autorizada para animar.');
    const takes = await quoteTakes(db, iv, segs, plan, tier);
    if (segs.some(s => takes.get(s.id) !== s.take)) {
      plan = await veoPlan(db, iv, ep, { tier, takes });
      segs = plan.segs.filter(s => s.chunks.length && pick.has(s.id));
    }
    const lang = o.lang && ep.subtitles?.[o.lang] ? o.lang : null;
    const people = personNames([iv.host_name ?? '', iv.guest_name ?? '']);
    const seen = new Set<string>();
    const selection: any[] = [];
    let genChunks = 0;
    for (const s of segs) {
      const sec = speechSec(s.durationMs), full = segmentCents(sec, rate.cents_per_min);
      const reused = await chargeUsable(db, iv.id, s.reuseKey!, s.take);
      const dup = !reused && seen.has(`${s.reuseKey}|${s.take}`); // a mesma fala duas vezes neste orçamento: paga-se uma
      seen.add(`${s.reuseKey}|${s.take}`);
      const cents = reused || dup ? 0 : full;
      if (!reused && !dup) genChunks += s.chunks.length;
      selection.push({ segmentId: s.id, role: s.role, kind: s.kind, text: s.text, durationMs: s.durationMs, sec, cents, fullCents: full, reused, dup, reuseKey: s.reuseKey, take: s.take,
        chunkKeys: s.chunks.map(c => c.key), chunks: s.chunks.length, budgetUsd: budgetUsd(cents, rate.usd_eur), realNames: [...namesUsedIn(s.text, people)] });
    }
    const price = selection.reduce((n, x) => n + x.cents, 0);
    const usdMax = genChunks * VEO_MAX_ATTEMPTS * rate.max_clip_sec * rate.cost_usd_per_sec;
    const cap = Math.min(budgetUsd(price, rate.usd_eur), Math.round(usdMax * 10000) / 10000);
    const validMs = Math.min(Date.now() + QUOTE_VALID_DAYS * 86400_000, rate.valid_until ? new Date(rate.valid_until).getTime() : Infinity);
    const snapshot = { id: rate.id, label: rate.label, cents_per_min: rate.cents_per_min, cost_usd_per_sec: rate.cost_usd_per_sec, usd_eur: rate.usd_eur, max_clip_sec: rate.max_clip_sec, resolution: rate.resolution, version: rate.version };
    const hash = inputsHashOf(ep, plan, tier, lang, selection.map(x => x.segmentId));
    return db.tx(async t => {
      // Um rascunho por episódio: o anterior deixa de valer.
      await t.query(`UPDATE animation_quotes SET status='cancelled', void_reason='substituído por um orçamento novo', updated_at=now() WHERE episode_id=$1 AND status='draft'`, [ep.id]);
      return t.one(`INSERT INTO animation_quotes(interview_id, episode_id, script_id, owner_id, entity_id, created_by, rate_id, rate, engine, model, tier, lang, selection, inputs_hash, speech_sec, price_cents, cap_usd, est_minutes, valid_until)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'veo',$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [iv.id, ep.id, ep.script_id, owner.id, owner.entity_id ?? null, o.actor.email, rate.id, JSON.stringify(snapshot), inEntity(null, () => veoModel(tier)), tier, lang, JSON.stringify(selection), hash,
        selection.reduce((n, x) => n + x.sec, 0), price, cap, Math.ceil(Math.ceil(genChunks / 2) * 1.5 + 2), new Date(validMs)]);
    });
  });
}

/**
 * Porque é que um rascunho já não pode ser aceite (null = pode): validade, tarifa e motor, episódio, guião, autorizações,
 * falas entretanto pagas e a impressão das entradas recalculada (guião, fotografias, vozes e pedaços).
 */
export async function quoteProblem(db: Db, q: any): Promise<string | null> {
  if (q.status !== 'draft') return 'Este orçamento já não está por aceitar.';
  if (new Date(q.valid_until).getTime() <= Date.now()) return 'O orçamento passou a validade: peça um orçamento novo.';
  const rate = await db.one<AnimationRate>('SELECT * FROM animation_rates WHERE id=$1', [q.rate_id]);
  if (!rate?.active) return 'O motor deste orçamento foi desativado: peça um orçamento novo.';
  if (Number(rate.version) !== Number(q.rate?.version)) return 'A tarifa mudou depois deste orçamento: peça um orçamento novo (o preço atual aparece antes de aceitar).';
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [q.interview_id]);
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [q.episode_id]);
  if (!iv || !ep) return 'O episódio já não existe.';
  if (ep.script_id !== q.script_id) return 'O guião do episódio mudou: peça um orçamento novo.';
  const block = await quoteBlock(db, iv, ep);
  if (block) return block;
  const owner = await ownerOf(db, iv);
  return inEntity(owner?.entity_id, async () => {
    if (quoteTier() !== q.tier) return 'O motor escolhido em Definições mudou: peça um orçamento novo.';
    for (const x of q.selection as any[]) if (!x.reused && x.cents > 0 && (await db.one('SELECT 1 FROM animation_charges WHERE interview_id=$1 AND reuse_key=$2 AND take=$3', [iv.id, x.reuseKey, x.take])))
      return 'Há falas deste orçamento que já foram pagas noutro: peça um orçamento novo (passam a 0 créditos).';
    const takes = new Map<string, number>((q.selection as any[]).map(x => [x.segmentId, Number(x.take) || 1]));
    const plan = await veoPlan(db, iv, ep, { tier: q.tier, takes });
    for (const x of q.selection as any[]) if (x.role === 'host' ? !plan.hostVeo : !plan.guestVeo)
      return x.role === 'host' ? 'A autorização do entrevistador para o Google Veo foi retirada.' : 'A autorização do convidado para o Google Veo foi retirada (ou a política deixou de ser «o entrevistado aprova»).';
    if (inputsHashOf(ep, plan, q.tier, q.lang ?? null, (q.selection as any[]).map(x => x.segmentId)) !== q.inputs_hash) return 'O guião, as fotografias ou as vozes mudaram depois deste orçamento: peça um orçamento novo.';
    return null;
  });
}

const uniqueViolation = (e: any) => e?.code === '23505' || /duplicate key|unique constraint/i.test(String(e?.message ?? ''));

/**
 * Aceitação, só pelo titular da entrevista (o administrador prepara o rascunho mas nunca aceita em nome do cliente), com
 * as duas caixas assinaladas. Numa só transação: recalcula a impressão, cativa o valor (UPDATE condicional da carteira),
 * passa o orçamento a aceite, regista a cativação, põe o vídeo na fila (um trabalho por orçamento) e põe na fila o email
 * com o orçamento e as condições, que sai antes de o trabalho começar.
 */
export async function acceptQuote(db: Db, user: any, quoteId: string, body: any, ip: string): Promise<{ ok: true; jobId: string; quote: any; consumer: boolean } | { error: string; missingCents?: number }> {
  const q0 = await db.one('SELECT * FROM animation_quotes WHERE id=$1', [quoteId]);
  if (!q0) return { error: 'Orçamento inexistente.' };
  if (user.role === 'admin' || user.id !== q0.owner_id) return { error: 'Só o titular da entrevista aceita o orçamento: o administrador pode prepará-lo, mas nunca o aceita em nome do cliente.' };
  // (orçamento feito antes de a entidade ter credenciais próprias: com elas, pagaria duas vezes, à Google e em créditos)
  if (veoWithoutQuote(user, user.entity_id)) return { error: ENTITY_VEO_NO_QUOTE };
  const consumer = await isConsumerOwner(db, user.id);
  if (body?.start_now !== '1' || body?.waiver !== '1')
    return { error: consumer ? 'Para aceitar, assinale as duas caixas: o pedido de início imediato e o reconhecimento sobre a livre resolução.' : 'Para aceitar, assinale as duas caixas: o pedido de início imediato e a aceitação das condições do orçamento.' };
  return inEntity(user.entity_id, async () => {
    const s = seller();
    const blk = checkoutBlock(s, consumer);
    if (blk) return { error: blk.pt };
    const vatRate = consumer ? await consumerVatRate(db, user.id, s) : null;
    const regime = await vatRegimeOf(db, user.id, s);
    let missing = 0;
    try {
      return await db.tx(async (t): Promise<any> => {
        const q = await t.one('SELECT * FROM animation_quotes WHERE id=$1 FOR UPDATE', [quoteId]);
        const why = await quoteProblem(t, q); // recalculado dentro da transação, com o orçamento bloqueado
        if (why) return { error: why };
        if (await t.one(`SELECT 1 FROM jobs WHERE interview_id=$1 AND kind='render_video' AND state IN ('queued','running')`, [q.interview_id])) return { error: 'Já há um vídeo a ser gerado nesta entrevista: aguarde que termine.' };
        const w = await walletFor(t, user.id, user.entity_id);
        const wb = spendBlock(w);
        if (wb) return { error: wb.pt };
        if (q.price_cents > 0 && !(await reserve(t, w.id, q.price_cents, { ref: `quote:${q.id}`, quoteId: q.id, interviewId: q.interview_id, note: `Orçamento da animação (${(q.selection as any[]).length} falas)`, actor: user.email }))) {
          missing = Math.max(0, q.price_cents - w.available_cents);
          return { error: `Saldo insuficiente: o orçamento é de ${cr(q.price_cents)} créditos e tem ${cr(w.available_cents)} disponíveis.`, missingCents: missing };
        }
        const acceptance = { startNow: true, second: consumer ? 'waiver' : 'conditions', consumer, vatRate, vatRegime: regime, ip, at: new Date().toISOString(), termsVersion: TERMS_VERSION, priceCents: q.price_cents, rateVersion: q.rate?.version ?? null, seller: { name: s.name, nif: s.nif } };
        const done = await t.one(`UPDATE animation_quotes SET status='accepted', wallet_id=$2, accepted_by=$3, accepted_at=now(), accepted_ip=$4, terms_version=$5, acceptance=$6, updated_at=now() WHERE id=$1 AND status='draft' RETURNING *`,
          [q.id, w.id, user.email, ip, TERMS_VERSION, JSON.stringify(acceptance)]);
        if (!done) return { error: 'Este orçamento já não está por aceitar.' };
        const jobId = await enqueue(t, { kind: 'render_video', interviewId: q.interview_id, input: { episodeId: q.episode_id, lang: q.lang, engine: 'veo', quoteId: q.id, veoRetries: 1, requestedBy: user.id }, dedupe: `video:quote:${q.id}` });
        if (!jobId) throw new Error('Trabalho do orçamento já existente');
        await t.query('UPDATE animation_quotes SET job_id=$2 WHERE id=$1', [q.id, jobId]);
        const iv = await t.one('SELECT id, title FROM interviews WHERE id=$1', [q.interview_id]);
        await queueEmail(t, quoteEmail({ ...done, job_id: jobId }, iv, user, s, consumer, vatRate, regime));
        return { ok: true, jobId, quote: done, consumer };
      });
    } catch (e: any) {
      if (uniqueViolation(e)) return { error: 'Já há um orçamento aceite em curso para este episódio: aguarde que a produção termine.' };
      throw e;
    }
  });
}

/** Desistir de um rascunho, ou de um orçamento aceite cujo trabalho ainda não começou (o cativo volta todo ao saldo). */
export async function cancelQuote(db: Db, quoteId: string, actor: string): Promise<string | null> {
  return db.tx(async t => {
    const q = await t.one('SELECT * FROM animation_quotes WHERE id=$1 FOR UPDATE', [quoteId]);
    if (!q) return 'Orçamento inexistente.';
    if (q.status === 'accepted') {
      const j = q.job_id ? await t.one(`UPDATE jobs SET state='failed', finished_at=now(), error=$2 WHERE id=$1 AND state='queued' AND attempts=0 RETURNING id`, [q.job_id, `Orçamento cancelado por ${actor}`]) : null;
      if (!j) return 'A produção já começou: já não é possível cancelar este orçamento.';
    } else if (q.status !== 'draft') return 'Este orçamento já não se pode cancelar.';
    await releaseQuote(t, q.id, `cancelado por ${actor}`, 'cancelled');
    return null;
  });
}

/**
 * Limpeza periódica (no vigilante do worker, a cada minuto): rascunhos fora da validade; orçamentos aceites ou em curso
 * cujo trabalho falhou (também sem passar pelo __onFail), terminou sem liquidar, não arrancou nas 24 h seguintes ao
 * momento em que podia arrancar ou ficou em pausa para além da validade. Em todos, os créditos cativos voltam ao saldo.
 */
export async function quoteHousekeeping(db: Db, now = new Date()) {
  const voided = (await db.query(`UPDATE animation_quotes SET status='void', void_reason='validade terminou', updated_at=now() WHERE status='draft' AND valid_until <= $1 RETURNING id`, [now])).length;
  let released = 0;
  const rows = await db.query(`SELECT q.id, q.status, q.valid_until, j.id AS job, j.state, j.ready_at FROM animation_quotes q LEFT JOIN jobs j ON j.id=q.job_id WHERE q.status IN ('accepted','running')`);
  for (const r of rows) {
    const queued = r.state === 'queued';
    const reason = !r.job ? 'a produção não tem trabalho'
      : r.state === 'failed' ? 'a produção falhou'
      : r.state === 'done' ? 'a produção terminou sem liquidar'
      : queued && new Date(r.valid_until).getTime() <= now.getTime() ? 'a validade terminou antes de a produção acabar'
      // Ainda não começou (o orçamento passa a «em curso» no arranque) e já podia ter arrancado há mais de 24 h.
      : queued && r.status === 'accepted' && r.ready_at && new Date(r.ready_at).getTime() <= now.getTime() - START_DEADLINE_HOURS * 3600_000 ? `a produção não arrancou em ${START_DEADLINE_HOURS} h`
      : null;
    if (!reason) continue;
    await db.tx(async t => {
      if (r.job && queued) await t.query(`UPDATE jobs SET state='failed', finished_at=now(), error=$2 WHERE id=$1 AND state='queued'`, [r.job, `Orçamento anulado: ${reason}`]);
      if (await releaseQuote(t, r.id, reason)) released++;
    });
  }
  return { voided, released };
}

// ---------- apresentação ----------
export const QUOTE_STATUS: Record<string, [string, '' | 'ok' | 'bad' | 'warn']> = {
  draft: ['rascunho por aceitar', 'warn'], accepted: ['aceite: na fila', 'ok'], running: ['em produção', 'ok'], settled: ['liquidado', 'ok'], void: ['anulado', 'bad'], cancelled: ['cancelado', ''],
};
export const roleLabel = (r: string) => (r === 'host' ? 'Entrevistador' : 'Convidado');
/**
 * Valor para o cliente: consumidor com o € com IVA primeiro; empresa em créditos (= € + IVA, já pago no carregamento). Sem
 * IVA no carregamento (autoliquidação de uma empresa da UE, ou vendedora não registada para IVA), o texto di-lo.
 */
export const priceLabel = (cents: number, vatRate: number | null, regime: string | null = null) =>
  regime === 'not_registered' ? (vatRate != null ? `${eurPt(cents)} (${cr(cents)} créditos)` : `${cr(cents)} créditos (= ${eurPt(cents)})`)
  : vatRate != null ? `${eurPt(withVat(cents, vatRate))} com IVA (${cr(cents)} créditos)`
  : regime === 'reverse_charge' ? `${cr(cents)} créditos (= ${eurPt(cents)}, sem IVA: autoliquidação)`
  : `${cr(cents)} créditos (= ${eurPt(cents)} + IVA, já pago no carregamento)`;
export const perMinuteLabel = (centsPerMin: number, vatRate: number | null, regime: string | null = null) => (vatRate != null && regime !== 'not_registered'
  ? `≈ ${eurPt(withVat(centsPerMin, vatRate))} por minuto de fala, com IVA (${cr(centsPerMin)} créditos)`
  : vatRate != null ? `≈ ${eurPt(centsPerMin)} por minuto de fala (${cr(centsPerMin)} créditos)`
  : `≈ ${cr(centsPerMin)} créditos por minuto de fala`);
/** Botão de aceitação: diz sem ambiguidade que há obrigação de pagar (TJUE C-249/21). */
export const acceptLabel = (cents: number, vatRate: number | null) => (!cents ? 'Aceitar (0 créditos: tudo reaproveitado)'
  : vatRate != null ? `Aceitar e pagar ${eurPt(withVat(cents, vatRate))} (${cr(cents)} créditos)` : `Aceitar e pagar ${cr(cents)} créditos`);
export const GUARANTEES = [
  'O orçamento aceite é o máximo: nunca se cobra mais, mesmo que o motor repita clipes, passe a clipes de 8 s ou a Google suba o preço.',
  'Nada começa sem a sua aceitação. Na aceitação o valor fica cativo; no fim cobram-se só as falas animadas e verificadas palavra a palavra.',
  'Uma fala que fique em fotografia (texto que não coincidiu, filtro da Google, Google indisponível, teto ou disjuntor, autorização retirada) não se paga: o valor volta ao saldo e o relatório mostra o motivo.',
  `Uma produção falhada, anulada, que não arranque nas ${START_DEADLINE_HOURS} h seguintes ao momento em que pode começar (a espera pelos vídeos à frente na fila não conta) ou cujo vídeo não fique ligado ao episódio custa 0 créditos.`,
  'As falas já pagas reaproveitam-se a 0 créditos noutras versões do vídeo, mesmo que o motor mude.',
  'Se uma autorização for retirada depois da entrega, o que foi entregue continua cobrado; o vídeo pode ser reconstruído só com o entrevistador, a 0 créditos, e os clipes do convidado são apagados.',
];

/** Email com o orçamento aceite, os consentimentos e as condições (suporte duradouro), antes de o trabalho começar. */
export function quoteEmail(q: any, iv: any, user: any, s: Seller, consumer: boolean, vatRate: number | null, regime: string | null = null) {
  const sel = q.selection as any[];
  const cents = (x: any) => (x.reused ? 'reaproveitado: 0 cr' : x.dup ? 'igual a outra fala: incluída' : `${cr(x.cents)} cr`);
  const url = `${config.baseUrl}/entrevistas/${iv.id}/orcamentos/${q.id}`;
  const second = consumer ? 'Reconheço que perco o direito de livre resolução quando a produção estiver concluída.' : 'Aceito este orçamento e as condições (o valor fica cativo e só se cobram as falas animadas e verificadas).';
  const head = [`Orçamento aceite para a animação do episódio de «${iv.title}».`, `Motor: ${q.rate.label}, ${q.rate.resolution}. Tarifa: ${perMinuteLabel(q.rate.cents_per_min, vatRate, regime)}.`];
  const total = `Total: ${priceLabel(q.price_cents, vatRate, regime)}. É o máximo que paga; o valor ficou cativo na sua carteira.`;
  const proof = [
    `Aceite por ${user.email} em ${new Date(q.accepted_at ?? Date.now()).toISOString()} (IP ${q.accepted_ip ?? '—'}), termos de venda versão ${q.terms_version ?? TERMS_VERSION}.`,
    `Consentimentos assinalados: «Peço que a produção comece já.» e «${second}»`,
  ];
  const terms = [
    ...GUARANTEES,
    ...(consumer ? [`Livre resolução: tem ${WITHDRAWAL_DAYS} dias para pedir o reembolso do saldo não usado de cada carregamento; ao pedir o início imediato, perde o direito de livre resolução sobre esta produção quando ela estiver concluída (DL 24/2014, art. 17.º, n.º 1, als. a) e l)).`] : []),
    `O vídeo leva o aviso visível «${VEO_NOTICE}» (Regulamento da IA, art. 50.º).`,
  ];
  const sellerLine = `Vendedor: ${s.name || s.tradeName || '—'}${s.nif ? `, NIF ${s.nif}` : ''}${s.address ? `, ${s.address}` : ''}. Reclamações: ${s.complaintsUrl || 'Livro de Reclamações Eletrónico'}${s.email ? ` · ${s.email}` : ''}.`;
  const text = [...head, `Falas (${sel.length}):`, ...sel.map(x => `  - ${x.segmentId} · ${roleLabel(x.role)} · ${x.sec} s · ${cents(x)}`), total, ...proof, 'Condições:', ...terms.map(g => `  - ${g}`), sellerLine, `Acompanhe a produção e veja o relatório por fala em ${url}`].join('\n');
  const td = (v: string) => `<td style="padding:4px 8px;border-bottom:1px solid #ddd">${esc(v)}</td>`;
  const html = emailShell('Orçamento aceite: animação do episódio', `<p>${head.map(esc).join('<br>')}</p>
<table style="border-collapse:collapse;font:14px Arial,sans-serif">${sel.map(x => `<tr>${td(x.segmentId)}${td(roleLabel(x.role))}${td(`${x.sec} s`)}${td(cents(x))}</tr>`).join('')}</table>
<p><strong>${esc(total)}</strong></p><p>${proof.map(esc).join('<br>')}</p><p>Condições:</p><ul>${terms.map(g => `<li>${esc(g)}</li>`).join('')}</ul>${sellerBlock(s)}`, { label: 'Acompanhar a produção', url });
  return { key: `quote:${q.id}`, interviewId: iv.id, to: user.email, subject: `Orçamento aceite: ${cr(q.price_cents)} créditos cativos para a animação`, text, html };
}

/** Motivo de uma fala em fotografia, para o relatório. */
export const reasonLabel = (r: string | null) => (r ? FALA_REASON[r] ?? r : '');
