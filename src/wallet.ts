import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc } from './lib.ts';
import { queueEmail, emailShell } from './mail.ts';
import { eurPt } from './vat.ts';

/**
 * Carteira de créditos: 1 crédito = 1 € sem IVA, sempre (em cêntimos na base; nunca «segundos de motor»).
 * Uma carteira por (utilizador, entidade). Os lotes são os carregamentos (credit_topups): consomem-se pela ordem de
 * validade (FIFO) e cada movimento fica no livro-razão imutável (wallet_entries) com os lotes que tocou.
 * Regras: a carteira bloqueia-se primeiro e os lotes depois (sempre por esta ordem); disponível = soma do que resta nos lotes.
 */
export const TOPUP_PACKS = [2500, 5000, 10000, 25000, 50000];
export const TOPUP_MIN_CENTS = 2500;
export const TOPUP_MAX_CENTS = 100000;
export const CREDIT_VALID_MONTHS = 24;
export const EXPIRY_WARNING_DAYS = 30;
/** Reembolso do saldo disponível de um carregamento nos dias seguintes (todos os clientes). */
export const REFUND_WINDOW_DAYS = 14;
/** Entrevista para além da quota do plano e regeneração para além das incluídas. */
export const EXTRA_INTERVIEW_CENTS = 600;
export const EXTRA_REGEN_CENTS = 100;

export interface Wallet { id: string; user_id: string; entity_id: string | null; available_cents: number; reserved_cents: number; debt_cents: number; frozen: boolean }
/** Parcela de um lote tocada por um movimento: lote, cêntimos e a coluna do lote para onde foram. */
export interface LotPart { t: string; c: number; b: Bucket }
type Bucket = 'used' | 'refunded' | 'disputed' | 'expired';
const BUCKETS: Bucket[] = ['used', 'refunded', 'disputed', 'expired'];

/** Créditos (com duas casas quando não são inteiros): «25», «6», «9,50». */
export const cr = (cents: number) => (cents % 100 ? (cents / 100).toFixed(2).replace('.', ',') : String(cents / 100));
export const crEn = (cents: number) => (cents % 100 ? (cents / 100).toFixed(2) : String(cents / 100));

/** Carteira do utilizador na entidade (criada vazia na primeira vez). */
export async function walletFor(db: Db, userId: string, entityId: string | null | undefined): Promise<Wallet> {
  await db.query('INSERT INTO wallets(user_id, entity_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [userId, entityId ?? null]);
  return (await db.one('SELECT * FROM wallets WHERE user_id=$1 AND entity_id IS NOT DISTINCT FROM $2', [userId, entityId ?? null]))!;
}
/** Carteira existente (sem a criar); undefined se nunca houve créditos. */
export const findWallet = (db: Db, userId: string, entityId: string | null | undefined) =>
  db.one<Wallet>('SELECT * FROM wallets WHERE user_id=$1 AND entity_id IS NOT DISTINCT FROM $2', [userId, entityId ?? null]);

/** Pode gastar? (nem congelada nem com dívida) e porquê não. */
export function spendBlock(w: Pick<Wallet, 'frozen' | 'debt_cents'> | undefined | null): { pt: string; en: string } | null {
  if (w?.frozen) return { pt: 'A sua carteira de créditos está suspensa (um pagamento foi contestado ou devolvido). Contacte-nos.', en: 'Your credit wallet is on hold (a payment was disputed or reversed). Please contact us.' };
  if (w && w.debt_cents > 0) return { pt: `A sua carteira tem ${cr(w.debt_cents)} créditos em dívida (um pagamento foi devolvido): o próximo carregamento paga-os primeiro.`, en: `Your wallet owes ${crEn(w.debt_cents)} credits (a payment was reversed): your next top-up pays them first.` };
  return null;
}

/** Carregamento sugerido para cobrir o que falta: o pacote seguinte; acima do maior, euros inteiros até ao máximo. */
export function packFor(missingCents: number): number {
  const need = Math.max(0, Math.ceil(missingCents));
  const pack = TOPUP_PACKS.find(p => p >= need);
  if (pack) return pack;
  return Math.min(TOPUP_MAX_CENTS, Math.ceil(need / 100) * 100);
}

// ---------- movimentos (sempre dentro de uma transação: t) ----------
interface EntryOpts { kind: string; avail?: number; reserved?: number; debt?: number; lots?: LotPart[]; topupId?: string | null; quoteId?: string | null; interviewId?: string | null; jobId?: string | null; stripeRef?: string | null; ref?: string | null; note?: string | null; actor?: string | null }
async function entry(t: Db, walletId: string, o: EntryOpts) {
  return t.one(`INSERT INTO wallet_entries(wallet_id, kind, available_delta, reserved_delta, debt_delta, lots, topup_id, quote_id, interview_id, job_id, stripe_ref, ref, note, actor)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
  [walletId, o.kind, o.avail ?? 0, o.reserved ?? 0, o.debt ?? 0, JSON.stringify(o.lots ?? []), o.topupId ?? null, o.quoteId ?? null, o.interviewId ?? null, o.jobId ?? null, o.stripeRef ?? null, o.ref ?? null, o.note ?? null, o.actor ?? null]);
}
const lockWallet = (t: Db, walletId: string) => t.one<Wallet>('SELECT * FROM wallets WHERE id=$1 FOR UPDATE', [walletId]);
async function bump(t: Db, walletId: string, avail: number, reserved: number, debt: number, frozen?: boolean) {
  await t.query(`UPDATE wallets SET available_cents=available_cents+$2, reserved_cents=reserved_cents+$3, debt_cents=debt_cents+$4, frozen=COALESCE($5, frozen), updated_at=now() WHERE id=$1`,
    [walletId, avail, reserved, debt, frozen ?? null]);
}

/**
 * Tira créditos do que resta nos lotes, pela ordem de validade (o lote `prefer` primeiro, se indicado).
 * `bucket` diz para onde vão no lote; os de outros lotes que não o preferido vão para `otherBucket`.
 */
async function takeFromLots(t: Db, walletId: string, cents: number, bucket: Bucket, prefer: string | null = null, otherBucket: Bucket = bucket, onlyPrefer = false): Promise<LotPart[]> {
  const lots = await t.query(`SELECT id, remaining_cents FROM credit_topups WHERE wallet_id=$1 AND remaining_cents>0 ${onlyPrefer ? 'AND id=$2::uuid' : ''}
    ORDER BY (id = $2::uuid) DESC NULLS LAST, expires_at, paid_at, id FOR UPDATE`, [walletId, prefer]);
  let left = cents;
  const out: LotPart[] = [];
  for (const l of lots) {
    if (left <= 0) break;
    const c = Math.min(left, l.remaining_cents), b = l.id === prefer ? bucket : otherBucket;
    await t.query(`UPDATE credit_topups SET remaining_cents=remaining_cents-$2, ${b}_cents=${b}_cents+$2, updated_at=now() WHERE id=$1`, [l.id, c]);
    out.push({ t: l.id, c, b });
    left -= c;
  }
  if (left > 0) throw new Error('Carteira incoerente: os lotes não cobrem o saldo disponível.');
  return out;
}
/** Devolve aos lotes o que um movimento tinha tirado (cada parcela volta da coluna para onde tinha ido). */
async function returnToLots(t: Db, lots: LotPart[]) {
  for (const p of lots) {
    if (!BUCKETS.includes(p.b)) throw new Error('Parcela de lote inválida');
    await t.query(`UPDATE credit_topups SET remaining_cents=remaining_cents+$2, ${p.b}_cents=${p.b}_cents-$2, updated_at=now() WHERE id=$1`, [p.t, p.c]);
  }
}
/** Divide as parcelas: as primeiras `cents` (por ordem) e o resto. */
function splitLots(lots: LotPart[], cents: number): [LotPart[], LotPart[]] {
  const head: LotPart[] = [], tail: LotPart[] = [];
  let left = cents;
  for (const p of lots) {
    const h = Math.min(left, p.c);
    if (h > 0) head.push({ ...p, c: h });
    if (p.c - h > 0) tail.push({ ...p, c: p.c - h });
    left -= h;
  }
  return [head, tail];
}

/**
 * Credita um carregamento pago (idempotente: um lote já pago não volta a ser creditado). A dívida, se houver, paga-se primeiro.
 * Devolve false se o lote já estava pago.
 */
export async function creditTopup(t: Db, topupId: string, o: { paymentIntent?: string | null; charge?: string | null; customerId?: string | null; vatCents?: number; actor?: string } = {}): Promise<boolean> {
  const pre = await t.one('SELECT wallet_id FROM credit_topups WHERE id=$1', [topupId]);
  if (!pre) throw new Error('Carregamento inexistente');
  const w = (await lockWallet(t, pre.wallet_id))!;
  const tp = await t.one('SELECT * FROM credit_topups WHERE id=$1 FOR UPDATE', [topupId]);
  if (!['pending', 'expired', 'failed'].includes(tp.status)) return false;
  const toDebt = Math.min(w.debt_cents, tp.net_cents), free = tp.net_cents - toDebt;
  // O valor efetivamente cobrado (a Stripe pode arredondar o IVA de outra forma, ±1 cêntimo) fica no lote.
  const vat = o.vatCents ?? tp.vat_cents;
  await t.query(`UPDATE credit_topups SET status='paid', paid_at=now(), expires_at=now() + ($2 || ' months')::interval, remaining_cents=$3, used_cents=$4,
      vat_cents=$5, gross_cents=net_cents+$5, stripe_payment_intent=COALESCE($6, stripe_payment_intent), stripe_charge=COALESCE($7, stripe_charge), stripe_customer_id=COALESCE($8, stripe_customer_id), updated_at=now() WHERE id=$1`,
  [topupId, String(CREDIT_VALID_MONTHS), free, toDebt, vat, o.paymentIntent ?? null, o.charge ?? null, o.customerId ?? null]);
  // Dívida paga e sem disputas abertas: a carteira volta a funcionar.
  const unfreeze = toDebt > 0 && toDebt === w.debt_cents && w.frozen && !(await openWalletDisputes(t, w.id));
  await bump(t, w.id, free, 0, -toDebt, unfreeze ? false : undefined);
  await entry(t, w.id, { kind: 'topup', avail: free, debt: -toDebt, lots: free ? [{ t: topupId, c: free, b: 'used' }] : [], topupId, stripeRef: o.paymentIntent ?? `topup:${topupId}`, ref: `topup:${topupId}`, note: toDebt ? `${cr(toDebt)} créditos pagaram a dívida` : null, actor: o.actor ?? 'stripe' });
  return true;
}

/**
 * Gasta créditos do disponível (entrevista extra, regeneração extra): só com saldo, sem dívida e com a carteira ativa.
 * `ref` torna a cobrança única (a mesma regeneração nunca se cobra duas vezes). Devolve a entrada, ou null sem saldo.
 */
export async function spend(t: Db, walletId: string, cents: number, o: { ref: string; note: string; interviewId?: string | null; jobId?: string | null; actor?: string | null }) {
  if (!(cents > 0)) throw new Error('Valor inválido');
  const done = await t.one(`SELECT * FROM wallet_entries WHERE kind='debit' AND ref=$1`, [o.ref]);
  if (done) return done;
  const w = await t.one(`UPDATE wallets SET available_cents=available_cents-$2, updated_at=now() WHERE id=$1 AND NOT frozen AND debt_cents=0 AND available_cents>=$2 RETURNING *`, [walletId, cents]);
  if (!w) return null;
  const lots = await takeFromLots(t, walletId, cents, 'used');
  return entry(t, walletId, { kind: 'debit', avail: -cents, lots, ref: o.ref, note: o.note, interviewId: o.interviewId, jobId: o.jobId, actor: o.actor });
}

/** Anula uma cobrança (ex.: a regeneração paga falhou): os créditos voltam aos mesmos lotes. Idempotente. */
export async function reverseDebit(t: Db, ref: string, note: string) {
  const d = await t.one(`SELECT * FROM wallet_entries WHERE kind='debit' AND ref=$1`, [ref]);
  if (!d) return null;
  await lockWallet(t, d.wallet_id);
  if (await t.one(`SELECT 1 FROM wallet_entries WHERE kind='reversal' AND ref=$1`, [ref])) return null;
  await returnToLots(t, d.lots);
  await bump(t, d.wallet_id, -d.available_delta, 0, 0);
  return entry(t, d.wallet_id, { kind: 'reversal', avail: -d.available_delta, lots: d.lots, ref, note, interviewId: d.interview_id, jobId: d.job_id, actor: 'sistema' });
}

/**
 * Cativa créditos na aceitação de um orçamento (UPDATE condicional: duas aceitações em simultâneo nunca deixam o saldo
 * negativo; a CHECK é a última barreira). Devolve a entrada, ou null sem saldo, com dívida ou com a carteira congelada.
 */
export async function reserve(t: Db, walletId: string, cents: number, o: { ref: string; quoteId?: string | null; interviewId?: string | null; note?: string; actor?: string | null }) {
  if (!(cents >= 0)) throw new Error('Valor inválido');
  const done = await t.one(`SELECT * FROM wallet_entries WHERE kind='reserve' AND ref=$1`, [o.ref]);
  if (done) return done;
  const w = await t.one(`UPDATE wallets SET available_cents=available_cents-$2, reserved_cents=reserved_cents+$2, updated_at=now() WHERE id=$1 AND NOT frozen AND debt_cents=0 AND available_cents>=$2 RETURNING *`, [walletId, cents]);
  if (!w) return null;
  const lots = cents ? await takeFromLots(t, walletId, cents, 'used') : [];
  return entry(t, walletId, { kind: 'reserve', avail: -cents, reserved: cents, lots, ref: o.ref, quoteId: o.quoteId, interviewId: o.interviewId, note: o.note ?? null, actor: o.actor });
}

/**
 * Liquida uma cativação: cobra `capturedCents` (nunca mais do que o cativo) e devolve o resto ao disponível, aos mesmos
 * lotes de onde saiu. Idempotente: uma cativação liquida-se uma vez. Devolve { captured, released }.
 */
export async function settle(t: Db, reserveRef: string, capturedCents: number, note?: string): Promise<{ captured: number; released: number } | null> {
  const r = await t.one(`SELECT * FROM wallet_entries WHERE kind='reserve' AND ref=$1`, [reserveRef]);
  if (!r) return null;
  await lockWallet(t, r.wallet_id);
  if (await t.one(`SELECT 1 FROM wallet_entries WHERE kind IN ('capture','release') AND ref=$1`, [reserveRef])) return null;
  const total = r.reserved_delta, captured = Math.max(0, Math.min(total, Math.round(capturedCents))), released = total - captured;
  const [used, back] = splitLots(r.lots, captured);
  await returnToLots(t, back);
  await bump(t, r.wallet_id, released, -total, 0);
  if (captured) await entry(t, r.wallet_id, { kind: 'capture', reserved: -captured, lots: used, ref: reserveRef, quoteId: r.quote_id, interviewId: r.interview_id, note: note ?? null, actor: 'sistema' });
  if (released || !captured) await entry(t, r.wallet_id, { kind: 'release', avail: released, reserved: -released, lots: back, ref: reserveRef, quoteId: r.quote_id, interviewId: r.interview_id, note: note ?? null, actor: 'sistema' });
  return { captured, released };
}
/** Liberta tudo o que estava cativo (orçamento anulado, falhado ou expirado). */
export const release = (t: Db, reserveRef: string, note?: string) => settle(t, reserveRef, 0, note);

/**
 * Débito forçado (reembolso feito fora da aplicação ou disputa): tira do disponível o que houver, começando pelo lote
 * do pagamento, e o que faltar passa a dívida (nunca viola a CHECK ≥ 0). `freeze` congela a carteira.
 */
async function forceDebit(t: Db, walletId: string, cents: number, o: { kind: 'external_refund' | 'dispute'; topupId: string; stripeRef: string; note: string; freeze: boolean }) {
  const w = (await lockWallet(t, walletId))!;
  const fromAvail = Math.min(w.available_cents, cents), toDebt = cents - fromAvail;
  const lots = fromAvail ? await takeFromLots(t, walletId, fromAvail, o.kind === 'dispute' ? 'disputed' : 'refunded', o.topupId, 'used') : [];
  await bump(t, walletId, -fromAvail, 0, toDebt, o.freeze || toDebt > 0 ? true : undefined);
  return entry(t, walletId, { kind: o.kind, avail: -fromAvail, debt: toDebt, lots, topupId: o.topupId, stripeRef: o.stripeRef, note: o.note, actor: 'stripe' });
}

/**
 * Anula um débito forçado (disputa ganha, reembolso que falhou): devolve o que saiu dos lotes e reduz a dívida que ele criou.
 * Se essa dívida já tiver sido paga entretanto, a diferença não volta sozinha: devolve-a para o administrador ver.
 */
async function reverseForced(t: Db, e: any, kind: 'dispute_won' | 'external_refund_reversal', note: string): Promise<number> {
  const w = (await lockWallet(t, e.wallet_id))!;
  const debtBack = Math.min(w.debt_cents, e.debt_delta);
  await returnToLots(t, e.lots);
  await bump(t, e.wallet_id, -e.available_delta, 0, -debtBack);
  await entry(t, e.wallet_id, { kind, avail: -e.available_delta, debt: -debtBack, lots: e.lots, topupId: e.topup_id, stripeRef: e.stripe_ref, note, actor: 'stripe' });
  return e.debt_delta - debtBack;
}

// ---------- reembolsos e disputas dos carregamentos ----------
/** Bruto (com IVA) de um reembolso de `net` cêntimos de créditos do lote; o último reembolso acerta o arredondamento. */
export async function refundGross(t: Db, tp: any, net: number): Promise<number> {
  const prev = await t.one(`SELECT COALESCE(sum(net_cents),0)::int AS net, COALESCE(sum(gross_cents),0)::int AS gross FROM credit_refunds WHERE topup_id=$1 AND status<>'failed'`, [tp.id]);
  if (prev.net + net >= tp.net_cents) return tp.gross_cents - prev.gross;
  return net + Math.round((net * tp.vat_cents) / tp.net_cents);
}

/** Reembolso do saldo disponível de um carregamento, pedido pelo administrador: a carteira é debitada antes do pedido à Stripe. */
export async function startRefund(t: Db, topupId: string, o: { reason: 'withdrawal' | 'closure'; actor: string; now?: Date }) {
  const pre = await t.one('SELECT wallet_id FROM credit_topups WHERE id=$1', [topupId]);
  if (!pre) throw new RefundError('Carregamento inexistente.');
  const w = (await lockWallet(t, pre.wallet_id))!;
  const tp = await t.one('SELECT * FROM credit_topups WHERE id=$1 FOR UPDATE', [topupId]);
  if (!['paid', 'partially_refunded'].includes(tp.status)) throw new RefundError('Só se reembolsam carregamentos pagos.');
  if (w.frozen) throw new RefundError('A carteira está congelada (disputa em aberto).');
  if (!tp.stripe_payment_intent) throw new RefundError('O carregamento não tem o pagamento da Stripe registado.');
  const now = o.now ?? new Date();
  if (o.reason === 'withdrawal' && now.getTime() - new Date(tp.paid_at).getTime() > REFUND_WINDOW_DAYS * 86400_000)
    throw new RefundError(`Passaram mais de ${REFUND_WINDOW_DAYS} dias desde o carregamento: só se reembolsa por encerramento do serviço.`);
  const net = tp.remaining_cents;
  if (!net) throw new RefundError('Este carregamento já não tem saldo disponível (gasto, cativo, caducado ou já reembolsado).');
  const gross = await refundGross(t, tp, net);
  const cr0 = await t.one(`INSERT INTO credit_refunds(topup_id, wallet_id, source, reason, net_cents, gross_cents, requested_by) VALUES ($1,$2,'app',$3,$4,$5,$6) RETURNING *`, [tp.id, w.id, o.reason, net, gross, o.actor]);
  const lots = await takeFromLots(t, w.id, net, 'refunded', tp.id, 'refunded', true);
  await bump(t, w.id, -net, 0, 0);
  await entry(t, w.id, { kind: 'refund', avail: -net, lots, topupId: tp.id, ref: `refund:${cr0.id}`, note: o.reason === 'closure' ? 'reembolso por encerramento do serviço' : `reembolso nos ${REFUND_WINDOW_DAYS} dias`, actor: o.actor });
  return { refund: cr0, topup: tp };
}
export class RefundError extends Error {}

/** Estado do lote depois de reembolsos e disputas. */
async function topupStatus(t: Db, topupId: string) {
  const tp = await t.one('SELECT * FROM credit_topups WHERE id=$1', [topupId]);
  const open = await openDisputes(t, topupId);
  const ref = await t.one(`SELECT COALESCE(sum(net_cents),0)::int AS n FROM credit_refunds WHERE topup_id=$1 AND status='succeeded'`, [topupId]);
  const status = open > 0 ? 'disputed' : ref.n >= tp.net_cents ? 'refunded' : ref.n > 0 ? 'partially_refunded' : 'paid';
  await t.query('UPDATE credit_topups SET status=$2, updated_at=now() WHERE id=$1', [topupId, status]);
}
const openWalletDisputes = async (t: Db, walletId: string) => Number((await t.one(`SELECT
  (SELECT count(*) FROM wallet_entries WHERE wallet_id=$1 AND kind='dispute') - (SELECT count(*) FROM wallet_entries WHERE wallet_id=$1 AND kind IN ('dispute_won','dispute_lost')) AS n`, [walletId])).n);
/** Disputas do lote ainda abertas ou perdidas (o lote fica «em disputa»; só uma disputa ganha o devolve ao estado anterior). */
const openDisputes = async (t: Db, topupId: string) => Number((await t.one(`SELECT
  (SELECT count(*) FROM wallet_entries WHERE topup_id=$1 AND kind='dispute') - (SELECT count(*) FROM wallet_entries WHERE topup_id=$1 AND kind='dispute_won') AS n`, [topupId])).n);

/** O reembolso pedido pela aplicação foi aceite pela Stripe (ou está a ser processado). */
export async function refundAccepted(t: Db, refundId: string, stripeRefundId: string, succeeded: boolean) {
  const r = await t.one(`UPDATE credit_refunds SET stripe_refund_id=COALESCE(stripe_refund_id, $2), status=CASE WHEN $3 THEN 'succeeded' ELSE status END, error=NULL, updated_at=now()
    WHERE id=$1 AND status<>'failed' RETURNING *`, [refundId, stripeRefundId, succeeded]);
  if (r && succeeded) await topupStatus(t, r.topup_id);
  return r;
}
/** O reembolso pedido pela aplicação falhou: os créditos voltam ao lote. Idempotente. */
export async function refundFailed(t: Db, refundId: string, error: string) {
  const r = await t.one('SELECT * FROM credit_refunds WHERE id=$1', [refundId]);
  if (!r || r.status === 'failed') return r;
  const e = await t.one(`SELECT * FROM wallet_entries WHERE kind='refund' AND ref=$1`, [`refund:${refundId}`]);
  await lockWallet(t, r.wallet_id);
  if (e && !(await t.one(`SELECT 1 FROM wallet_entries WHERE kind='refund_reversal' AND ref=$1`, [`refund:${refundId}`]))) {
    await returnToLots(t, e.lots);
    await bump(t, r.wallet_id, -e.available_delta, 0, 0);
    await entry(t, r.wallet_id, { kind: 'refund_reversal', avail: -e.available_delta, lots: e.lots, topupId: r.topup_id, ref: `refund:${refundId}`, note: `reembolso falhou: ${error}`.slice(0, 300), actor: 'stripe' });
  }
  const u = await t.one(`UPDATE credit_refunds SET status='failed', error=$2, updated_at=now() WHERE id=$1 RETURNING *`, [refundId, error.slice(0, 500)]);
  await topupStatus(t, r.topup_id);
  return u;
}

/**
 * Reembolso feito fora da aplicação (painel da Stripe), identificado pelo pagamento do carregamento: debita a carteira pelo
 * líquido proporcional; sem saldo, o resto fica em dívida e a carteira é congelada. Idempotente pelo id do reembolso.
 */
export async function externalRefund(t: Db, tp: any, o: { stripeRefundId: string; grossCents: number; succeeded: boolean }) {
  if (await t.one('SELECT 1 FROM credit_refunds WHERE stripe_refund_id=$1', [o.stripeRefundId])) return null;
  const prev = await t.one(`SELECT COALESCE(sum(net_cents),0)::int AS net, COALESCE(sum(gross_cents),0)::int AS gross FROM credit_refunds WHERE topup_id=$1 AND status<>'failed'`, [tp.id]);
  const gross = Math.min(o.grossCents, tp.gross_cents - prev.gross);
  if (gross <= 0) return null;
  const net = prev.gross + gross >= tp.gross_cents ? tp.net_cents - prev.net : Math.min(tp.net_cents - prev.net, Math.round((gross * tp.net_cents) / tp.gross_cents));
  const r = await t.one(`INSERT INTO credit_refunds(topup_id, wallet_id, source, reason, net_cents, gross_cents, status, stripe_refund_id, requested_by) VALUES ($1,$2,'stripe','stripe',$3,$4,$5,$6,'stripe') RETURNING *`,
    [tp.id, tp.wallet_id, Math.max(1, net), gross, o.succeeded ? 'succeeded' : 'pending', o.stripeRefundId]);
  const e = await forceDebit(t, tp.wallet_id, r.net_cents, { kind: 'external_refund', topupId: tp.id, stripeRef: o.stripeRefundId, note: 'reembolso feito no painel da Stripe', freeze: false });
  await t.query(`UPDATE credit_topups SET alert=$2, updated_at=now() WHERE id=$1`, [tp.id, `Reembolso de ${eurPt(gross)} feito fora da aplicação (painel da Stripe): carteira debitada em ${cr(r.net_cents)} créditos${e.debt_delta ? `, ${cr(e.debt_delta)} em dívida e carteira congelada` : ''}.`]);
  if (o.succeeded) await topupStatus(t, tp.id);
  return { refund: r, entry: e };
}
/** Reembolso feito fora da aplicação que acabou por falhar: anula o débito. */
export async function externalRefundFailed(t: Db, stripeRefundId: string) {
  const r = await t.one(`SELECT * FROM credit_refunds WHERE stripe_refund_id=$1 AND source='stripe'`, [stripeRefundId]);
  if (!r || r.status === 'failed') return null;
  const e = await t.one(`SELECT * FROM wallet_entries WHERE kind='external_refund' AND stripe_ref=$1`, [stripeRefundId]);
  if (e) {
    const left = await reverseForced(t, e, 'external_refund_reversal', 'o reembolso feito na Stripe falhou');
    if (left) await t.query(`UPDATE credit_topups SET alert=$2 WHERE id=$1`, [r.topup_id, `O reembolso ${stripeRefundId} falhou depois de a dívida que criou ter sido paga: ${cr(left)} créditos por devolver à mão.`]);
  }
  await t.query(`UPDATE credit_refunds SET status='failed', updated_at=now() WHERE id=$1`, [r.id]);
  await topupStatus(t, r.topup_id);
  return r;
}
/** Reembolso feito fora da aplicação que estava pendente e terminou. */
export async function externalRefundSucceeded(t: Db, stripeRefundId: string) {
  const r = await t.one(`UPDATE credit_refunds SET status='succeeded', updated_at=now() WHERE stripe_refund_id=$1 AND status='pending' RETURNING *`, [stripeRefundId]);
  if (r) await topupStatus(t, r.topup_id);
  return r;
}

/** Disputa aberta sobre o pagamento de um carregamento: carteira congelada e débito do líquido (o que faltar fica em dívida). */
export async function disputeOpened(t: Db, tp: any, o: { disputeId: string; grossCents: number }) {
  if (await t.one(`SELECT 1 FROM wallet_entries WHERE kind='dispute' AND stripe_ref=$1`, [o.disputeId])) return null;
  const net = Math.min(tp.net_cents, Math.round((Math.min(o.grossCents, tp.gross_cents) * tp.net_cents) / tp.gross_cents));
  const e = await forceDebit(t, tp.wallet_id, net, { kind: 'dispute', topupId: tp.id, stripeRef: o.disputeId, note: 'disputa do pagamento (chargeback)', freeze: true });
  await t.query(`UPDATE credit_topups SET alert=$2, updated_at=now() WHERE id=$1`, [tp.id, `Disputa ${o.disputeId} aberta (${eurPt(o.grossCents)}): carteira congelada e debitada em ${cr(net)} créditos${e.debt_delta ? ` (${cr(e.debt_delta)} em dívida)` : ''}.`]);
  await topupStatus(t, tp.id);
  return e;
}
/** Disputa encerrada: ganha, os créditos voltam; perdida, ficam debitados. A carteira descongela sem disputas abertas. */
export async function disputeClosed(t: Db, o: { disputeId: string; won: boolean }) {
  const e = await t.one(`SELECT * FROM wallet_entries WHERE kind='dispute' AND stripe_ref=$1`, [o.disputeId]);
  if (!e) return null;
  await lockWallet(t, e.wallet_id);
  if (await t.one(`SELECT 1 FROM wallet_entries WHERE kind IN ('dispute_won','dispute_lost') AND stripe_ref=$1`, [o.disputeId])) return null;
  let left = 0;
  if (o.won) left = await reverseForced(t, e, 'dispute_won', 'disputa ganha: créditos repostos');
  else await entry(t, e.wallet_id, { kind: 'dispute_lost', topupId: e.topup_id, stripeRef: o.disputeId, note: 'disputa perdida: os créditos ficam debitados', actor: 'stripe' });
  // Descongela sem disputas abertas e sem dívida (a dívida de um reembolso fora da aplicação mantém-na congelada).
  const w2 = await t.one('SELECT debt_cents FROM wallets WHERE id=$1', [e.wallet_id]);
  if (!(await openWalletDisputes(t, e.wallet_id)) && !w2.debt_cents) await t.query('UPDATE wallets SET frozen=false, updated_at=now() WHERE id=$1', [e.wallet_id]);
  await t.query(`UPDATE credit_topups SET alert=$2, updated_at=now() WHERE id=$1`, [e.topup_id, o.won ? `Disputa ${o.disputeId} ganha: créditos repostos${left ? `; ${cr(left)} créditos de dívida já pagos ficam por acertar à mão` : ''}.` : `Disputa ${o.disputeId} perdida: créditos debitados${e.debt_delta ? ` e ${cr(e.debt_delta)} em dívida` : ''}.`]);
  await topupStatus(t, e.topup_id);
  return { won: o.won };
}

// ---------- validade (trabalho periódico) ----------
/** Caducam os lotes com a validade passada: o que resta sai do disponível (sem efeito no IVA, já liquidado no carregamento). */
export async function expireLots(db: Db, now = new Date()): Promise<number> {
  const due = await db.query(`SELECT id, wallet_id FROM credit_topups WHERE remaining_cents>0 AND expires_at<=$1 ORDER BY expires_at LIMIT 500`, [now]);
  let n = 0;
  for (const d of due) {
    await db.tx(async (t) => {
      await lockWallet(t, d.wallet_id);
      const tp = await t.one('SELECT * FROM credit_topups WHERE id=$1 FOR UPDATE', [d.id]);
      if (!(tp.remaining_cents > 0) || new Date(tp.expires_at) > now) return;
      const c = tp.remaining_cents;
      await t.query(`UPDATE credit_topups SET remaining_cents=0, expired_cents=expired_cents+$2, updated_at=now() WHERE id=$1`, [tp.id, c]);
      await bump(t, d.wallet_id, -c, 0, 0);
      await entry(t, d.wallet_id, { kind: 'expire', avail: -c, lots: [{ t: tp.id, c, b: 'expired' }], topupId: tp.id, ref: `expire:${tp.id}:${tp.expired_cents}`, note: 'validade de 24 meses terminada', actor: 'sistema' });
      n++;
    });
  }
  return n;
}

/** Aviso por email 30 dias antes de um lote caducar (um por lote). */
export async function warnExpiring(db: Db, now = new Date()): Promise<number> {
  const rows = await db.query(`SELECT tp.id, tp.remaining_cents, tp.expires_at, u.email, u.name FROM credit_topups tp JOIN users u ON u.id=tp.user_id
    WHERE tp.remaining_cents>0 AND tp.expiry_warned_at IS NULL AND tp.expires_at > $1 AND tp.expires_at <= $1::timestamptz + ($2 || ' days')::interval`, [now, String(EXPIRY_WARNING_DAYS)]);
  for (const r of rows) {
    const day = new Date(r.expires_at).toLocaleDateString('pt-PT'), dayEn = new Date(r.expires_at).toISOString().slice(0, 10);
    const text = `${cr(r.remaining_cents)} créditos do seu carregamento caducam a ${day}. Pode usá-los até lá em ${config.baseUrl}/conta/creditos. · ${crEn(r.remaining_cents)} credits from one of your top-ups expire on ${dayEn}. You can use them until then.`;
    await queueEmail(db, { key: `credits-expiry:${r.id}`, to: r.email, subject: `Créditos a caducar a ${day} · Credits expiring on ${dayEn}`, text,
      html: emailShell('Créditos a caducar · Credits expiring', `<p>${esc(text)}</p><p><a href="${esc(config.baseUrl)}/conta/creditos">${esc(config.baseUrl)}/conta/creditos</a></p>`) });
    await db.query('UPDATE credit_topups SET expiry_warned_at=now() WHERE id=$1', [r.id]);
  }
  return rows.length;
}

/**
 * Regenerações pagas cujo trabalho falhou sem passar pelo __onFail (ex.: interrompido por um reinício sem mais tentativas):
 * o crédito volta. Idempotente (uma anulação por cobrança).
 */
export async function reverseFailedJobDebits(db: Db): Promise<number> {
  const rows = await db.query(`SELECT e.ref FROM wallet_entries e JOIN jobs j ON j.id=e.job_id WHERE e.kind='debit' AND e.ref LIKE 'regen:%' AND j.state='failed'
    AND NOT EXISTS (SELECT 1 FROM wallet_entries r WHERE r.kind='reversal' AND r.ref=e.ref) LIMIT 200`);
  for (const r of rows) await db.tx(t => reverseDebit(t, r.ref, 'a regeneração falhou: crédito devolvido'));
  return rows.length;
}

/** Trabalho periódico das carteiras: avisos, caducidade e créditos de regenerações falhadas. */
export async function walletHousekeeping(db: Db, now = new Date()) {
  const warned = await warnExpiring(db, now);
  const expired = await expireLots(db, now);
  const reversed = await reverseFailedJobDebits(db);
  return { warned, expired, reversed };
}

// ---------- invariantes ----------
/**
 * Confere as carteiras: soma das entradas = saldos; soma do que resta nos lotes = disponível; repartição de cada lote = valor.
 * Devolve a lista de problemas (vazia = tudo certo).
 */
export async function ledgerCheck(db: Db, walletId?: string): Promise<string[]> {
  const out: string[] = [];
  const rows = await db.query(`SELECT w.id, w.available_cents, w.reserved_cents, w.debt_cents,
      COALESCE((SELECT sum(available_delta) FROM wallet_entries e WHERE e.wallet_id=w.id),0)::int AS ea,
      COALESCE((SELECT sum(reserved_delta) FROM wallet_entries e WHERE e.wallet_id=w.id),0)::int AS er,
      COALESCE((SELECT sum(debt_delta) FROM wallet_entries e WHERE e.wallet_id=w.id),0)::int AS ed,
      COALESCE((SELECT sum(remaining_cents) FROM credit_topups tp WHERE tp.wallet_id=w.id),0)::int AS lots
    FROM wallets w WHERE ($1::uuid IS NULL OR w.id=$1::uuid)`, [walletId ?? null]);
  for (const r of rows) {
    if (r.ea !== r.available_cents) out.push(`carteira ${r.id}: disponível ${r.available_cents} ≠ entradas ${r.ea}`);
    if (r.er !== r.reserved_cents) out.push(`carteira ${r.id}: cativo ${r.reserved_cents} ≠ entradas ${r.er}`);
    if (r.ed !== r.debt_cents) out.push(`carteira ${r.id}: dívida ${r.debt_cents} ≠ entradas ${r.ed}`);
    if (r.lots !== r.available_cents) out.push(`carteira ${r.id}: disponível ${r.available_cents} ≠ lotes ${r.lots}`);
  }
  return out;
}

/** Linha do extrato de créditos (não é fatura nem recibo). */
export const ENTRY_LABEL: Record<string, { pt: string; en: string }> = {
  topup: { pt: 'Carregamento', en: 'Top-up' }, debit: { pt: 'Utilização', en: 'Used' }, reversal: { pt: 'Devolução de utilização', en: 'Usage returned' },
  reserve: { pt: 'Cativo (orçamento aceite)', en: 'On hold (accepted quote)' }, capture: { pt: 'Cobrado do cativo', en: 'Charged from hold' }, release: { pt: 'Libertado do cativo', en: 'Released from hold' },
  refund: { pt: 'Reembolso', en: 'Refund' }, refund_reversal: { pt: 'Reembolso anulado', en: 'Refund cancelled' },
  external_refund: { pt: 'Reembolso (Stripe)', en: 'Refund (Stripe)' }, external_refund_reversal: { pt: 'Reembolso anulado (Stripe)', en: 'Refund cancelled (Stripe)' },
  dispute: { pt: 'Disputa do pagamento', en: 'Payment dispute' }, dispute_won: { pt: 'Disputa encerrada: créditos repostos', en: 'Dispute closed: credits restored' },
  dispute_lost: { pt: 'Disputa encerrada', en: 'Dispute closed' }, expire: { pt: 'Caducidade', en: 'Expired' },
};
