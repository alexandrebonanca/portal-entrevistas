import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc } from './lib.ts';
import { S, stripeScopedValue, saveStripeScoped, stripeScope, inEntity } from './settings.ts';
import { vatFor, countryName, ptRegion, regionalRate, withVat, vatOf, eurPt, eurEn, fmtRate, type VatDecision, type VatOk } from './vat.ts';
import { seller, sellerBlock, contactEmail, TERMS_VERSION, WITHDRAWAL_DAYS, type Seller } from './legal.ts';
import { queueEmail, emailShell } from './mail.ts';
import { walletFor, creditTopup, refundAccepted, refundFailed, externalRefund, externalRefundFailed, externalRefundSucceeded, disputeOpened, disputeClosed, startRefund, cr, crEn, REFUND_WINDOW_DAYS } from './wallet.ts';

export const ACTIVE_STATUSES = ['active', 'trialing', 'comped'];
/** Estados em que uma subscrição Stripe continua viva (a cobrar). */
export const LIVE_STRIPE = ['active', 'trialing', 'past_due'];
/** Marca dos objetos deste portal na Stripe (a conta pode ser partilhada com outros portais). */
export const STRIPE_APP = 'quietinterview';
/** Eventos a ativar no webhook da Stripe (global e de cada entidade). */
export const STRIPE_EVENTS = 'checkout.session.completed, checkout.session.async_payment_succeeded/failed, checkout.session.expired, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed, customer.tax_id.created/updated, refund.created/updated/failed, charge.refunded, charge.dispute.created/closed';

/** O perfil convida sem subscrição: o administrador e o gestor de entidade. */
export const noSubscriptionNeeded = (role: string) => role === 'admin' || role === 'entity_admin';

/**
 * Estado da subscrição e quota de entrevistas do período corrente. O administrador e o gestor de entidade convidam sem
 * subscrição e sem limite mensal (`unlimited`); só o administrador fica também sem os limites técnicos de cada entrevista
 * (`exempt`): o gestor tem os por omissão (perguntas, minutos de respostas, áudio do entrevistador e regenerações).
 */
export async function quotaFor(db: Db, user: { id: string; role: string }) {
  if (user.role === 'admin') return { allowed: true, unlimited: true, exempt: true, used: 0, limit: Infinity, plan: null as any, sub: null as any, reason: '' };
  const sub = await db.one(`SELECT s.*, p.name AS plan_name, p.interviews_per_month, p.price_cents, p.max_answer_total_sec, p.max_questions FROM subscriptions s LEFT JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1`, [user.id]);
  if (user.role === 'entity_admin') {
    // (contagem do mês de calendário, só para mostrar; uma subscrição que ainda tenha fica visível, para a poder cancelar)
    const used = Number((await db.one(`SELECT count(*)::int AS n FROM interviews WHERE owner_id=$1 AND invited_at >= date_trunc('month', now())`, [user.id])).n);
    return { allowed: true, unlimited: true, exempt: false, used, limit: Infinity, plan: null as any, sub, reason: '' };
  }
  if (!sub || !ACTIVE_STATUSES.includes(sub.status)) return { allowed: false, unlimited: false, exempt: false, used: 0, limit: 0, plan: null, sub, reason: 'no_subscription' };
  if (sub.current_period_end && new Date(sub.current_period_end) < new Date(Date.now() - 3 * 86400_000)) return { allowed: false, unlimited: false, exempt: false, used: 0, limit: 0, plan: sub, sub, reason: 'expired' };
  const now = new Date();
  const start = sub.current_period_start ? new Date(sub.current_period_start) : new Date(now.getFullYear(), now.getMonth(), 1);
  const limit = sub.interviews_override ?? sub.interviews_per_month ?? 0;
  // As entrevistas extra (pagas com créditos) não contam para a quota do plano.
  const used = Number((await db.one(`SELECT count(*)::int AS n FROM interviews WHERE owner_id=$1 AND invited_at >= $2 AND extra_cents IS NULL`, [user.id, start])).n);
  return { allowed: used < limit, unlimited: false, exempt: false, used, limit, plan: sub, sub, reason: used < limit ? '' : 'quota' };
}

// ---------- Stripe (API REST, sem SDK) ----------
const flatten = (o: any, prefix = ''): [string, string][] =>
  Object.entries(o).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (Array.isArray(v)) return v.flatMap((x, i) => (typeof x === 'object' ? flatten(x, `${key}[${i}]`) : [[`${key}[${i}]`, String(x)] as [string, string]]));
    return typeof v === 'object' ? flatten(v, key) : [[key, String(v)] as [string, string]];
  });

export const stripeConfigured = () => !!S('STRIPE_SECRET_KEY');

/** Erro devolvido pela Stripe (status HTTP e código, ex.: 404 resource_missing, 402 card_declined). */
export class StripeError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code = '') { super(message); this.status = status; this.code = code; }
}

/** Pedido à API da Stripe. Num GET os parâmetros vão no URL (ex.: { expand: ['default_payment_method'] }). */
export async function stripe(path: string, params?: object, method = 'POST', opts: { idempotencyKey?: string } = {}): Promise<any> {
  const key = S('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Stripe não configurado');
  const qs = params ? new URLSearchParams(flatten(params)).toString() : '';
  const body = qs && method !== 'GET' ? qs : undefined;
  const res = await fetch(`https://api.stripe.com/v1/${path}${qs && method === 'GET' ? `?${qs}` : ''}`, {
    method, body,
    headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}), ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}) },
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new StripeError(`Stripe: ${j?.error?.message ?? res.status}`, res.status, j?.error?.code ?? '');
  return j;
}
const missing = (e: unknown) => e instanceof StripeError && e.status === 404;
const enc = encodeURIComponent;
/** Identificador curto da chave em uso (sem a revelar): objetos criados com outra chave (ex.: a de teste) não servem. */
export const keyFingerprint = () => createHash('sha256').update(S('STRIPE_SECRET_KEY')).digest('hex').slice(0, 16);

/** Taxas de IVA guardadas da conta Stripe em contexto: { acct, rates: { 'PT:23': 'txr_…' } }. */
export function savedTaxRates(): { acct?: string; rates: Record<string, string> } {
  try { const j = JSON.parse(stripeScopedValue('STRIPE_TAX_RATES') || '{}'); return { acct: j.acct, rates: j.rates && typeof j.rates === 'object' ? j.rates : {} }; }
  catch { return { rates: {} }; }
}

/**
 * Taxa de IVA manual e exclusiva de um país e taxa (23%, 22% Madeira e 16% Açores em Portugal), criada na Stripe na
 * primeira venda e reutilizada depois (guardada nas Definições da conta Stripe em contexto). Sem Stripe Tax, que cobra por
 * transação. A Idempotency-Key evita duplicados se dois pedidos a criarem ao mesmo tempo.
 */
export async function ensureTaxRate(db: Db, country: string, rate: number): Promise<string> {
  const fp = keyFingerprint();
  let saved = savedTaxRates();
  if (saved.acct !== fp) saved = { acct: fp, rates: {} }; // outra conta (ou chave de teste ↔ real): as taxas antigas não servem
  const k = `${country}:${rate}`;
  if (/^txr_\w+$/.test(saved.rates[k] ?? '')) return saved.rates[k];
  const place = country === 'PT' ? (rate === 22 ? 'Madeira' : rate === 16 ? 'Açores' : 'Portugal') : countryName(country);
  const tr = await stripe('tax_rates', {
    display_name: 'IVA', description: `IVA ${rate}% ${place}`, jurisdiction: place, percentage: rate, inclusive: false,
    country, tax_type: 'vat', metadata: { app: STRIPE_APP, country, rate: String(rate) },
  }, 'POST', { idempotencyKey: `${STRIPE_APP}:tax_rate:${fp}:${k}` });
  saved.rates[k] = tr.id;
  await saveStripeScoped(db, 'STRIPE_TAX_RATES', JSON.stringify(saved));
  return tr.id as string;
}

/** Produto de cada plano na Stripe, com id fixo: o Checkout e a mudança de plano usam o mesmo. */
async function ensureProduct(plan: any) {
  const id = `${STRIPE_APP}_${plan.id}`.replace(/[^A-Za-z0-9_-]/g, '_');
  const name = `${config.brand} — ${plan.name} (up to ${plan.interviews_per_month} interviews / month, images only)`;
  try { await stripe(`products/${id}`, { name }); }
  catch (e) { if (!missing(e)) throw e; await stripe('products', { id, name, metadata: { app: STRIPE_APP, plan_id: plan.id } }); }
  return id;
}

/** Conta Stripe em contexto, como chave dos clientes: a entidade com Stripe própria, ou 'global'. */
const scopeKey = () => stripeScope() ?? 'global';
/** Cliente Stripe do utilizador na conta Stripe em contexto (os anteriores a esta versão estão em users.stripe_customer_id). */
export async function customerFor(db: Db, userId: string): Promise<string | null> {
  const r = await db.one('SELECT customer_id FROM stripe_customers WHERE user_id=$1 AND scope=$2', [userId, scopeKey()]);
  if (r) return r.customer_id;
  return (await db.one('SELECT stripe_customer_id FROM users WHERE id=$1', [userId]))?.stripe_customer_id ?? null;
}
export async function saveCustomer(db: Db, userId: string, customerId: string) {
  await db.query(`INSERT INTO stripe_customers(user_id, scope, customer_id) VALUES ($1,$2,$3) ON CONFLICT (user_id, scope) DO UPDATE SET customer_id=$3, updated_at=now()`, [userId, scopeKey(), customerId]);
  await db.query('UPDATE users SET stripe_customer_id=$2 WHERE id=$1', [userId, customerId]); // o último usado (página do administrador)
}

/** Cliente Stripe com os dados de faturação (o Checkout mostra-os preenchidos), por (utilizador, conta Stripe). Se for de outra conta, cria outro. */
export async function ensureCustomer(db: Db, user: { id: string; email: string }, profile: any) {
  const fields = { name: profile.name, email: user.email, address: { line1: profile.address, postal_code: profile.postal_code, city: profile.city, country: profile.country }, metadata: { app: STRIPE_APP, user_id: user.id } };
  const cur = await customerFor(db, user.id);
  if (cur) {
    try { await stripe(`customers/${enc(cur)}`, fields); await saveCustomer(db, user.id, cur); return cur; }
    catch (e) { if (!missing(e)) throw e; }
  }
  const c = await stripe('customers', fields);
  await saveCustomer(db, user.id, c.id);
  return c.id as string;
}

/**
 * Número de IVA de uma empresa de outro país da UE verificado pela Stripe no VIES (objeto tax_id do cliente, tipo eu_vat).
 * Cria-o se ainda não existir neste cliente, ou se o número mudou; consulta o estado se já existir.
 * Devolve o estado: pending, verified, unverified ou unavailable (o VIES não respondeu).
 */
export async function verifyVatNumber(db: Db, user: { id: string; email: string }, profile: any): Promise<string> {
  const customer = await ensureCustomer(db, user, profile);
  let obj: any = null;
  if (profile.stripe_tax_id && profile.stripe_tax_customer === customer) {
    try { obj = await stripe(`customers/${enc(customer)}/tax_ids/${enc(profile.stripe_tax_id)}`, undefined, 'GET'); }
    catch (e) { if (!missing(e)) throw e; }
    if (obj && obj.value !== profile.vat_number) {
      await stripe(`customers/${enc(customer)}/tax_ids/${enc(obj.id)}`, undefined, 'DELETE').catch(() => {});
      obj = null;
    }
  }
  if (!obj) obj = await stripe(`customers/${enc(customer)}/tax_ids`, { type: 'eu_vat', value: profile.vat_number });
  const status = ['pending', 'verified', 'unverified', 'unavailable'].includes(obj.verification?.status) ? obj.verification.status : 'pending';
  await db.query(`UPDATE billing_profiles SET vat_status=$2, vat_verified_name=$3, stripe_tax_id=$4, stripe_tax_customer=$5, vat_checked_at=now() WHERE user_id=$1 AND vat_number=$6`,
    [user.id, status, obj.verification?.verified_name ?? null, obj.id, customer, profile.vat_number]);
  return status;
}

/** IVA de uma venda a este cliente, pela empresa vendedora da conta Stripe em contexto. */
export function vatForProfile(profile: any, s: Seller = seller()): VatDecision {
  return vatFor(s.vat, { country: profile.country, kind: profile.kind, vatNumber: profile.vat_number, vatVerified: profile.vat_status === 'verified', postalCode: profile.postal_code });
}

/** Retrato do IVA da compra (guardado na subscrição e copiado para a lista «por faturar»). */
export const vatSnapshot = (profile: any, d: VatOk, s: Seller) => ({
  regime: d.regime, rate: d.rate, country: d.country, customerKind: profile.kind, customerCountry: profile.country, sellerNif: s.nif, termsVersion: TERMS_VERSION,
});
const subMeta = (user: { id: string }, plan: any, profile: any, d: VatOk, s: Seller) => ({
  app: STRIPE_APP, user_id: user.id, plan_id: plan.id, customer_kind: profile.kind, customer_country: profile.country,
  vat_regime: d.regime, vat_rate: String(d.rate), vat_country: d.country, seller_nif: s.nif, terms_version: TERMS_VERSION,
});
const priceData = (plan: any, product: string) => ({ currency: plan.currency, product, unit_amount: plan.price_cents, recurring: { interval: 'month' }, tax_behavior: 'exclusive' });
const taxRates = async (db: Db, d: VatOk) => (d.rate > 0 ? [await ensureTaxRate(db, d.country, d.rate)] : undefined);

/** Nova subscrição: só cartão, morada de faturação obrigatória, número de IVA na Stripe e a taxa de IVA decidida. */
export async function createCheckout(db: Db, user: { id: string; email: string }, plan: any, profile: any, d: VatOk, s: Seller = seller()) {
  const rates = await taxRates(db, d);
  const product = await ensureProduct(plan);
  const customer = await ensureCustomer(db, user, profile);
  const meta = subMeta(user, plan, profile, d, s);
  const session = await stripe('checkout/sessions', {
    mode: 'subscription', customer, client_reference_id: user.id,
    payment_method_types: ['card'],
    billing_address_collection: 'required',
    customer_update: { address: 'auto', name: 'auto' },
    tax_id_collection: { enabled: true },
    // Consumidores em Portugal: o Checkout em português (informação obrigatória na língua do consumidor).
    ...(profile.kind === 'consumer' && profile.country === 'PT' ? { locale: 'pt' } : {}),
    success_url: `${config.baseUrl}/account?checkout=success`,
    cancel_url: `${config.baseUrl}/account?checkout=cancelled`,
    line_items: [{ quantity: 1, price_data: priceData(plan, product), tax_rates: rates }],
    metadata: meta,
    subscription_data: { metadata: meta },
  });
  return session.url as string;
}

/**
 * Mudança de plano na subscrição que já existe (nunca uma segunda): a diferença é faturada logo, proporcionalmente,
 * e a mudança só se aplica se o pagamento passar (error_if_incomplete). O IVA é decidido de novo com os dados atuais.
 * 'gone' = a subscrição já não está viva na Stripe (o chamador abre um Checkout novo).
 */
export async function changePlan(db: Db, user: { id: string }, sub: any, plan: any, profile: any, d: VatOk, s: Seller = seller()): Promise<'switched' | 'gone' | 'past_due'> {
  const id = enc(sub.stripe_subscription_id);
  let cur: any;
  try { cur = await stripe(`subscriptions/${id}`, undefined, 'GET'); }
  catch (e) { if (missing(e)) return 'gone'; throw e; }
  if (cur.status === 'past_due' || cur.status === 'unpaid') return 'past_due';
  if (!['active', 'trialing'].includes(cur.status)) return 'gone';
  const item = cur.items?.data?.[0];
  if (!item?.id) throw new Error('Stripe: a subscrição não tem linhas.');
  const rates = await taxRates(db, d);
  const product = await ensureProduct(plan);
  await stripe(`subscriptions/${id}`, {
    // tax_rates vazio retira a taxa anterior (autoliquidação).
    items: [{ id: item.id, price_data: priceData(plan, product), tax_rates: rates ?? '' }],
    proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete', cancel_at_period_end: false,
    metadata: subMeta(user, plan, profile, d, s),
  });
  await db.query(`UPDATE subscriptions SET plan_id=$2, cancel_at_period_end=false, vat=$4, updated_at=now() WHERE user_id=$1 AND stripe_subscription_id=$3`,
    [user.id, plan.id, sub.stripe_subscription_id, JSON.stringify(vatSnapshot(profile, d, s))]);
  return 'switched';
}

/** Cancela já a subscrição na Stripe (livre resolução); o acerto do valor fica para o administrador. */
export const cancelNow = (subscriptionId: string) => stripe(`subscriptions/${enc(subscriptionId)}`, undefined, 'DELETE');

export async function createPortal(customerId: string) {
  const s = await stripe('billing_portal/sessions', { customer: customerId, return_url: `${config.baseUrl}/account` });
  return s.url as string;
}

/** Verifica Stripe-Signature (HMAC-SHA256 sobre "t.corpo") com tolerância de 5 minutos. */
export function verifyStripeSignature(raw: Buffer, header: string | undefined, secret: string, now = Date.now()) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > 300) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${raw.toString('utf8')}`).digest('hex');
  return header.split(',').filter(p => p.startsWith('v1=')).some(p => {
    const sig = p.slice(3);
    return sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  });
}

const mapStatus = (s: string) => (['active', 'trialing'].includes(s) ? s : s === 'past_due' || s === 'unpaid' ? 'past_due' : s === 'canceled' ? 'canceled' : 'inactive');
const iso = (n?: number) => (n ? new Date(n * 1000) : null);
const ref = (v: any): string | null => (typeof v === 'string' ? v : typeof v?.id === 'string' ? v.id : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const existingUser = async (t: Db, id: unknown) => (typeof id === 'string' && UUID.test(id) && (await t.one('SELECT id FROM users WHERE id=$1', [id])) ? id : null);
const existingPlan = async (t: Db, id: unknown) => (typeof id === 'string' && id && (await t.one('SELECT id FROM plans WHERE id=$1', [id])) ? id : null);
const alert = (t: Db, action: string, meta: object) => t.query(`INSERT INTO audit_events(actor, action, interview_id, meta) VALUES ('stripe',$1,NULL,$2)`, [action, JSON.stringify(meta)]);
/** Metadata e subscrição de uma fatura (API nova: parent.subscription_details; antiga: subscription_details e subscription). */
const invoiceSubMeta = (o: any) => o.parent?.subscription_details?.metadata ?? o.subscription_details?.metadata ?? {};
const invoiceSubId = (o: any) => ref(o.parent?.subscription_details?.subscription) ?? ref(o.subscription);

/**
 * País do cartão do pagamento (prova do país do cliente para o IVA): o meio de pagamento da subscrição ou, na falta dele,
 * o do cliente. Melhor esforço e ANTES da transação (nada de rede com a base bloqueada); null se não se souber.
 */
async function cardCountry(subId: string | null, customerId: string | null): Promise<string | null> {
  if (!stripeConfigured()) return null;
  try {
    if (subId) { const s = await stripe(`subscriptions/${enc(subId)}`, { expand: ['default_payment_method'] }, 'GET'); if (s?.default_payment_method?.card?.country) return s.default_payment_method.card.country; }
  } catch { /* tenta o do cliente */ }
  try {
    if (customerId) { const c = await stripe(`customers/${enc(customerId)}`, { expand: ['invoice_settings.default_payment_method'] }, 'GET'); return c?.invoice_settings?.default_payment_method?.card?.country ?? null; }
  } catch { /* sem esta prova */ }
  return null;
}

/**
 * Aplica um evento Stripe. Idempotente por id de evento: o registo em payment_events e o efeito estão na MESMA transação,
 * por isso um efeito que falhe não deixa o evento marcado e o reenvio da Stripe volta a aplicá-lo.
 * entityId: entidade do webhook (a dona da conta Stripe), guardada na lista «por faturar».
 */
export async function applyStripeEvent(db: Db, ev: any, entityId: string | null = null): Promise<'applied' | 'duplicate' | 'ignored'> {
  if (await db.one('SELECT 1 FROM payment_events WHERE id=$1', [ev.id])) return 'duplicate';
  const o = ev.data?.object ?? {};
  // Consultas à Stripe antes da transação: país do cartão (prova do IVA), cobrança do carregamento, reembolsos de uma cobrança.
  const extra: EventExtra = ev.type === 'invoice.paid' && typeof o.id === 'string' ? { cardCountry: await cardCountry(invoiceSubId(o), ref(o.customer)) }
    : /^checkout\.session\.(completed|async_payment_succeeded)$/.test(ev.type) && o.mode === 'payment' && o.metadata?.kind === 'topup' ? await topupPaymentInfo(ref(o.payment_intent))
    : ev.type === 'charge.refunded' && !Array.isArray(o.refunds?.data) && typeof o.id === 'string' ? { refunds: await chargeRefunds(o.id) } : {};
  return db.tx(async (t) => {
    const fresh = await t.one('INSERT INTO payment_events(id, type, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [ev.id, ev.type, JSON.stringify({ id: ev.id, type: ev.type, object: o.id })]);
    if (!fresh) return 'duplicate';
    return applyEffect(t, ev, entityId, extra);
  });
}

interface EventExtra { cardCountry?: string | null; charge?: string | null; refunds?: any[] }

async function applyEffect(t: Db, ev: any, entityId: string | null, extra: EventExtra): Promise<'applied' | 'ignored'> {
  const o = ev.data?.object ?? {}, type = String(ev.type ?? '');
  if (type.startsWith('checkout.session.')) {
    if (!(await ownSession(t, o))) return 'ignored';
    if (o.mode === 'payment') return o.metadata?.kind === 'topup' ? topupSessionEvent(t, type, o, extra) : 'ignored';
    return type === 'checkout.session.completed' && o.mode === 'subscription' ? sessionCompleted(t, o) : 'ignored';
  }
  if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(type)) return subscriptionChanged(t, type, o);
  if (type === 'invoice.paid' || type === 'invoice.payment_failed') return invoiceEvent(t, type, o, entityId, extra);
  if (type === 'customer.tax_id.updated' || type === 'customer.tax_id.created') return taxIdChanged(t, o);
  // Reembolsos e disputas: o carregamento identifica-se pelo pagamento (payment_intent ou charge), nunca pela metadata.
  if (['refund.created', 'refund.updated', 'refund.failed', 'charge.refund.updated'].includes(type)) return refundEvent(t, o);
  if (type === 'charge.refunded') {
    let any = false;
    for (const r of (Array.isArray(o.refunds?.data) ? o.refunds.data : extra.refunds ?? []))
      if ((await refundEvent(t, { ...r, payment_intent: r.payment_intent ?? o.payment_intent, charge: r.charge ?? o.id })) === 'applied') any = true;
    return any ? 'applied' : 'ignored';
  }
  if (type === 'charge.dispute.created' || type === 'charge.dispute.closed') return disputeEvent(t, type, o);
  return 'ignored';
}

/**
 * Sessões de Checkout deste portal: metadata.app = quietinterview. As criadas antes desta versão (sem app) só contam se
 * apontarem para um utilizador e um plano nossos; as de outros portais da mesma conta Stripe são ignoradas.
 */
async function ownSession(t: Db, o: any) {
  const app = o.metadata?.app;
  if (app) return app === STRIPE_APP;
  return !!(await existingUser(t, o.client_reference_id)) && !!(await existingPlan(t, o.metadata?.plan_id));
}

/** Retrato do IVA a partir da metadata da subscrição (null nas subscrições anteriores a esta versão). */
const snapshotFromMeta = (m: any) => (m?.vat_regime ? { regime: m.vat_regime, rate: Number(m.vat_rate), country: m.vat_country || '', customerKind: m.customer_kind ?? null, customerCountry: m.customer_country ?? null, sellerNif: m.seller_nif ?? null, termsVersion: m.terms_version ?? null } : null);
const json = (v: any) => (v ? JSON.stringify(v) : null);

async function sessionCompleted(t: Db, o: any): Promise<'applied' | 'ignored'> {
  const userId = await existingUser(t, o.client_reference_id ?? o.metadata?.user_id);
  if (!userId) return 'ignored';
  const planId = await existingPlan(t, o.metadata?.plan_id), subId = ref(o.subscription), customer = ref(o.customer);
  const prev = await t.one('SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id=$1', [userId]);
  // Duas subscrições vivas (ex.: dois separadores): fica a nova; o administrador cancela a anterior no painel da Stripe.
  if (prev?.stripe_subscription_id && subId && prev.stripe_subscription_id !== subId && LIVE_STRIPE.includes(prev.status))
    await alert(t, 'billing.duplicate_subscription', { userId, previous: prev.stripe_subscription_id, current: subId });
  // A morada recolhida no Checkout tem de ser do país (e da região) em que o IVA foi decidido; se não for, o administrador corrige.
  const addr = o.customer_details?.address, m = o.metadata ?? {};
  if (addr?.country && m.customer_country && addr.country !== m.customer_country) await alert(t, 'billing.address_country_mismatch', { userId, session: o.id, expected: m.customer_country, country: addr.country });
  else if (addr?.country === 'PT' && m.vat_country === 'PT' && m.vat_rate && regionalRate('PT', addr.postal_code) !== Number(m.vat_rate))
    await alert(t, 'billing.address_region_mismatch', { userId, session: o.id, rate: Number(m.vat_rate), postal: addr.postal_code ?? null });
  if (customer) await saveCustomer(t, userId, customer);
  await t.query(
    `INSERT INTO subscriptions(user_id, plan_id, status, source, stripe_subscription_id, contract_started_at, vat) VALUES ($1,$2,'active','stripe',$3,now(),$4)
     ON CONFLICT (user_id) DO UPDATE SET plan_id=COALESCE($2, subscriptions.plan_id), status='active', source='stripe', stripe_subscription_id=$3, vat=COALESCE($4, subscriptions.vat),
       contract_started_at=CASE WHEN subscriptions.stripe_subscription_id IS NOT DISTINCT FROM $3 THEN COALESCE(subscriptions.contract_started_at, now()) ELSE now() END, updated_at=now()`,
    [userId, planId, subId, json(snapshotFromMeta(m))]);
  // Consumidor: confirmação do contrato em suporte duradouro (DL 24/2014, art. 6.º), com o pedido de início imediato.
  // Uma por subscrição (a chave da outbox deduplica), chegue este evento antes ou depois de customer.subscription.created.
  if (m.customer_kind === 'consumer') await contractEmail(t, userId, planId, subId ?? String(o.id), o.customer_details?.email, m.vat_rate);
  return 'applied';
}

async function contractEmail(t: Db, userId: string, planId: string | null, key: string, email?: string, vatRate?: string) {
  const u = await t.one('SELECT email FROM users WHERE id=$1', [userId]);
  const plan = planId ? await t.one('SELECT name, price_cents FROM plans WHERE id=$1', [planId]) : null;
  const s = seller();
  // A taxa decidida na compra (metadata da sessão); sem ela, a da morada em Portugal.
  const p = await t.one('SELECT postal_code, country FROM billing_profiles WHERE user_id=$1', [userId]);
  const rate = vatRate !== undefined && vatRate !== '' && Number.isFinite(Number(vatRate)) ? Number(vatRate) : p?.country === 'PT' ? ptRegion(p.postal_code).rate : null;
  const price = plan ? (rate === null ? `${eurPt(plan.price_cents)}/mês + IVA` : `${eurPt(withVat(plan.price_cents, rate))}/mês com IVA (${eurPt(plan.price_cents)} + IVA ${fmtRate(rate)}%)`) : '';
  const text = `Confirmamos a sua subscrição ${plan?.name ?? ''} de ${config.brand}${price ? `, por ${price}` : ''}, renovada todos os meses até a cancelar. Pediu que o serviço começasse já: pode desistir nos ${WITHDRAWAL_DAYS} dias seguintes, sem indicar o motivo, pelo botão «Desistir do contrato aqui» na sua conta (${config.baseUrl}/account), e nesse caso paga a parte do serviço já prestada. Termos e condições: ${config.baseUrl}/termos (versão ${TERMS_VERSION}). Vendedor: ${s.name || s.tradeName}${s.nif ? `, NIF ${s.nif}` : ''}.`;
  await queueEmail(t, { key: `contract:${key}`, to: email || u.email, subject: `Confirmação da subscrição ${config.brand}`, text,
    html: emailShell('Confirmação da subscrição', `<p>${esc(text)}</p>${sellerBlock(s)}`) });
}

async function subscriptionChanged(t: Db, type: string, o: any): Promise<'applied' | 'ignored'> {
  const item = o.items?.data?.[0];
  const start = iso(o.current_period_start ?? item?.current_period_start), end = iso(o.current_period_end ?? item?.current_period_end);
  const deleted = type.endsWith('deleted');
  const status = deleted ? 'canceled' : mapStatus(o.status);
  const planId = await existingPlan(t, o.metadata?.plan_id);
  const vat = json(snapshotFromMeta(o.metadata));
  const row = typeof o.id === 'string' ? await t.one('SELECT id, status FROM subscriptions WHERE stripe_subscription_id=$1', [o.id]) : null;
  if (row) {
    // Cancelada é definitivo na Stripe: um evento atrasado não a reativa.
    if (row.status === 'canceled' && !deleted) return 'ignored';
    await t.query(
      `UPDATE subscriptions SET status=$2, current_period_start=COALESCE($3, current_period_start), current_period_end=COALESCE($4, current_period_end), cancel_at_period_end=$5, plan_id=COALESCE($6, plan_id), vat=COALESCE($7, vat), updated_at=now() WHERE id=$1`,
      [row.id, status, start, end, !!o.cancel_at_period_end, planId, vat]);
    return 'applied';
  }
  // Não é a subscrição atual de ninguém: só é adotada se for deste portal, estiver viva e o utilizador não tiver outra viva.
  // Assim os eventos de uma subscrição antiga (ou duplicada) nunca substituem nem cancelam a atual.
  if (deleted || !['active', 'trialing'].includes(status)) return 'ignored';
  if (o.metadata?.app && o.metadata.app !== STRIPE_APP) return 'ignored';
  const userId = await existingUser(t, o.metadata?.user_id);
  if (!userId) return 'ignored';
  const cur = await t.one('SELECT stripe_subscription_id, status FROM subscriptions WHERE user_id=$1', [userId]);
  if (cur?.stripe_subscription_id && LIVE_STRIPE.includes(cur.status)) return 'ignored';
  await t.query(
    `INSERT INTO subscriptions(user_id, plan_id, status, source, stripe_subscription_id, current_period_start, current_period_end, cancel_at_period_end, contract_started_at, vat) VALUES ($1,$2,$3,'stripe',$4,$5,$6,$7,COALESCE($8, now()),$9)
     ON CONFLICT (user_id) DO UPDATE SET plan_id=COALESCE($2, subscriptions.plan_id), status=$3, source='stripe', stripe_subscription_id=$4, current_period_start=$5, current_period_end=$6, cancel_at_period_end=$7, contract_started_at=COALESCE($8, now()), vat=COALESCE($9, subscriptions.vat), updated_at=now()`,
    [userId, planId, status, o.id, start, end, !!o.cancel_at_period_end, iso(o.start_date ?? o.created), vat]);
  return 'applied';
}

/** A verificação de um número de IVA no VIES (pela Stripe) terminou: atualiza o perfil de faturação que o usa. */
async function taxIdChanged(t: Db, o: any): Promise<'applied' | 'ignored'> {
  if (typeof o.id !== 'string') return 'ignored';
  const status = String(o.verification?.status ?? 'pending');
  if (!['pending', 'verified', 'unverified', 'unavailable'].includes(status)) return 'ignored';
  const r = await t.one(`UPDATE billing_profiles SET vat_status=$2, vat_verified_name=$3, vat_checked_at=now() WHERE stripe_tax_id=$1 AND vat_number=$4 RETURNING user_id`,
    [o.id, status, o.verification?.verified_name ?? null, String(o.value ?? '')]);
  return r ? 'applied' : 'ignored';
}

/** Menção da fatura para cada regime (a autoliquidação é obrigatória: CIVA, art. 36.º, n.º 13). */
export const invoiceNote = (regime: string | null | undefined) => (regime === 'reverse_charge' ? 'IVA – autoliquidação (art. 6.º, n.º 6, al. a) do CIVA e art. 196.º da Diretiva 2006/112/CE)' : null);

/**
 * Faturas da Stripe das subscrições: invoice.paid entra na lista «por faturar» (fatura-recibo emitida à mão no Moloni da
 * empresa vendedora), com o IVA decidido, os valores, a vendedora e as provas do país do cliente; invoice.payment_failed
 * passa a subscrição a «pagamento em atraso». Faturas de outros portais são ignoradas.
 */
async function invoiceEvent(t: Db, type: string, o: any, entityId: string | null, extra: EventExtra): Promise<'applied' | 'ignored'> {
  const subId = invoiceSubId(o);
  if (!subId || typeof o.id !== 'string') return 'ignored';
  const meta = invoiceSubMeta(o);
  if (meta.app && meta.app !== STRIPE_APP) return 'ignored';
  const row = await t.one('SELECT id, user_id, status, plan_id, vat FROM subscriptions WHERE stripe_subscription_id=$1', [subId]);
  const userId = row?.user_id ?? (meta.app === STRIPE_APP ? await existingUser(t, meta.user_id) : null);
  if (!userId) return 'ignored';
  if (type === 'invoice.payment_failed') {
    if (row && row.status !== 'canceled') await t.query(`UPDATE subscriptions SET status='past_due', updated_at=now() WHERE id=$1`, [row.id]);
    await alert(t, 'billing.payment_failed', { userId, invoice: o.id, subscription: subId });
    return 'applied';
  }
  if (row?.status === 'past_due') await t.query(`UPDATE subscriptions SET status='active', updated_at=now() WHERE id=$1`, [row.id]);
  const total = Math.round(Number(o.total ?? o.amount_paid ?? 0));
  if (!total) return 'applied'; // nada a faturar (fatura a zero)
  const net = Math.round(Number(o.total_excluding_tax ?? o.subtotal_excluding_tax ?? o.subtotal ?? total));
  const vatCents = total - net;
  const lines: any[] = o.lines?.data ?? [];
  const starts = lines.map(l => l.period?.start).filter(Boolean), ends = lines.map(l => l.period?.end).filter(Boolean);
  const planId = (await existingPlan(t, meta.plan_id)) ?? row?.plan_id ?? null;
  const plan = planId ? await t.one('SELECT name FROM plans WHERE id=$1', [planId]) : null;
  const snap: any = snapshotFromMeta(meta) ?? row?.vat ?? null;
  const profile = await t.one('SELECT kind, name, country, address, postal_code, city, nif, vat_number, vat_status, vat_verified_name, vat_checked_at, last_checkout_ip, last_checkout_at FROM billing_profiles WHERE user_id=$1', [userId]);
  // Dados para a fatura e provas do país do cliente: morada de faturação, país do cartão, NIF ou número de IVA e verificação, IP.
  const customer = { name: o.customer_name ?? profile?.name ?? null, email: o.customer_email ?? null, address: o.customer_address ?? null, taxIds: (o.customer_tax_ids ?? []).map((x: any) => ({ type: x.type, value: x.value })) };
  const evidence = {
    billingCountry: o.customer_address?.country ?? null, billingPostal: o.customer_address?.postal_code ?? null, cardCountry: extra.cardCountry ?? null,
    nif: profile?.nif ?? null, vatNumber: profile?.vat_number ?? null, vatStatus: profile?.vat_status ?? null, vatVerifiedName: profile?.vat_verified_name ?? null, vatCheckedAt: profile?.vat_checked_at ?? null,
    ip: profile?.last_checkout_ip ?? null, ipAt: profile?.last_checkout_at ?? null, profile: profile ?? null,
  };
  const s = seller();
  const sellerSnap = { name: s.name, tradeName: s.tradeName, nif: s.nif, address: s.address, country: s.country };
  const planName = plan?.name ?? planId ?? '—';
  const description = total < 0 ? `Acerto a favor do cliente na mudança para o plano ${planName} (nota de crédito)`
    : o.billing_reason === 'subscription_update' ? `Mudança para o plano ${planName} (acerto proporcional)` : `Subscrição ${config.brand} — plano ${planName}`;
  await t.query(
    `INSERT INTO invoice_queue(kind, user_id, entity_id, stripe_ref, stripe_number, stripe_subscription_id, stripe_customer_id, plan_id, reason, description, net_cents, vat_cents, total_cents, currency,
       vat_rate, vat_regime, vat_country, vat_note, customer_kind, customer_country, customer, evidence, seller, terms_version, paid_at, period_start, period_end)
     VALUES ('subscription',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) ON CONFLICT (stripe_ref) DO NOTHING`,
    [userId, entityId, o.id, o.number ?? null, subId, ref(o.customer), planId, o.billing_reason ?? null, description, net, vatCents, total, String(o.currency ?? 'eur'),
      snap ? Number(snap.rate) : null, snap?.regime ?? null, snap?.country ?? null, invoiceNote(snap?.regime), snap?.customerKind ?? profile?.kind ?? null, snap?.customerCountry ?? profile?.country ?? null,
      JSON.stringify(customer), JSON.stringify(evidence), JSON.stringify(sellerSnap), snap?.termsVersion ?? null,
      iso(o.status_transitions?.paid_at) ?? new Date(), starts.length ? iso(Math.min(...starts)) : null, ends.length ? iso(Math.max(...ends)) : null]);
  return 'applied';
}

// ---------- créditos: carregamentos (Checkout mode=payment), reembolsos e disputas ----------
/** Retrato do cliente e das provas do país no momento do pedido de carregamento. */
const profileEvidence = (profile: any, ip: string) => ({
  nif: profile.nif ?? null, vatNumber: profile.vat_number ?? null, vatStatus: profile.vat_status ?? null, vatVerifiedName: profile.vat_verified_name ?? null, vatCheckedAt: profile.vat_checked_at ?? null,
  ip, ipAt: new Date().toISOString(),
  profile: { kind: profile.kind, name: profile.name, country: profile.country, address: profile.address, postal_code: profile.postal_code, city: profile.city, nif: profile.nif ?? null, vat_number: profile.vat_number ?? null },
});
const sellerSnapshot = (s: Seller) => ({ name: s.name, tradeName: s.tradeName, nif: s.nif, address: s.address, country: s.country });

/**
 * Pede um carregamento: lote 'pending' com o IVA decidido e as provas, e a sessão de Checkout (pagamento único, só cartão,
 * morada obrigatória, NIF; Idempotency-Key do lote). Os créditos só entram quando a Stripe confirma o pagamento.
 */
export async function startTopup(db: Db, user: { id: string; email: string; entity_id: string | null }, netCents: number, profile: any, d: VatOk, s: Seller, ip: string, returnPath: string | null = null) {
  const w = await walletFor(db, user.id, user.entity_id);
  const vat = vatOf(netCents, d.rate);
  const tp = await db.one(`INSERT INTO credit_topups(wallet_id, user_id, entity_id, stripe_scope, stripe_account, net_cents, vat_cents, gross_cents, vat_rate, vat_regime, vat_country, vat_note,
      customer_kind, customer_country, customer, evidence, seller, terms_version, return_path)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
  [w.id, user.id, user.entity_id ?? null, stripeScope(), keyFingerprint(), netCents, vat, netCents + vat, d.rate, d.regime, d.country || null, invoiceNote(d.regime),
    profile.kind, profile.country, JSON.stringify({ name: profile.name, email: user.email }), JSON.stringify(profileEvidence(profile, ip)), JSON.stringify(sellerSnapshot(s)), TERMS_VERSION, returnPath]);
  try {
    const rates = await taxRates(db, d);
    const customer = await ensureCustomer(db, user, profile);
    const credits = netCents / 100;
    const meta = { app: STRIPE_APP, kind: 'topup', topup_id: tp.id, user_id: user.id, customer_kind: profile.kind, customer_country: profile.country,
      vat_regime: d.regime, vat_rate: String(d.rate), vat_country: d.country, seller_nif: s.nif, terms_version: TERMS_VERSION };
    const session = await stripe('checkout/sessions', {
      mode: 'payment', customer, client_reference_id: user.id,
      payment_method_types: ['card'],
      billing_address_collection: 'required',
      customer_update: { address: 'auto', name: 'auto' },
      tax_id_collection: { enabled: true },
      ...(profile.kind === 'consumer' && profile.country === 'PT' ? { locale: 'pt' } : {}),
      line_items: [{ quantity: 1, tax_rates: rates, price_data: { currency: 'eur', unit_amount: netCents, tax_behavior: 'exclusive',
        product_data: { name: `${config.brand} — ${credits} créditos pré-pagos · ${credits} prepaid credits`, description: '1 crédito = 1 € sem IVA, válido 24 meses · 1 credit = €1 excl. VAT, valid 24 months', metadata: { app: STRIPE_APP } } } }],
      metadata: meta,
      payment_intent_data: { metadata: meta, description: `${config.brand}: ${credits} créditos` },
      success_url: `${config.baseUrl}/conta/creditos?sessao={CHECKOUT_SESSION_ID}`,
      cancel_url: `${config.baseUrl}/conta/creditos?carregamento=cancelado`,
      expires_at: Math.floor(Date.now() / 1000) + 45 * 60,
    }, 'POST', { idempotencyKey: `${STRIPE_APP}:topup:${tp.id}` });
    await db.query('UPDATE credit_topups SET stripe_session_id=$2, stripe_customer_id=$3, updated_at=now() WHERE id=$1', [tp.id, session.id, customer]);
    return { topup: tp, url: session.url as string };
  } catch (e) {
    await db.query(`UPDATE credit_topups SET status='failed', alert=$2, updated_at=now() WHERE id=$1 AND status='pending'`, [tp.id, `Checkout não criado: ${String((e as any)?.message ?? e).slice(0, 200)}`]);
    throw e;
  }
}

/** Pagamento do carregamento na Stripe: país do cartão (prova) e a cobrança (identifica reembolsos e disputas). Melhor esforço. */
async function topupPaymentInfo(pi: string | null): Promise<EventExtra> {
  if (!pi || !stripeConfigured()) return {};
  try {
    const p = await stripe(`payment_intents/${enc(pi)}`, { expand: ['payment_method', 'latest_charge'] }, 'GET');
    return { cardCountry: p?.payment_method?.card?.country ?? p?.latest_charge?.payment_method_details?.card?.country ?? null, charge: ref(p?.latest_charge) };
  } catch { return {}; }
}
/** Reembolsos de uma cobrança (a API recente já não os traz no evento charge.refunded). */
async function chargeRefunds(charge: string): Promise<any[]> {
  if (!stripeConfigured()) return [];
  try { return (await stripe('refunds', { charge, limit: 100 }, 'GET'))?.data ?? []; } catch { return []; }
}
const topupByPayment = (t: Db, pi: string | null, charge: string | null) =>
  pi || charge ? t.one(`SELECT * FROM credit_topups WHERE ($1::text IS NOT NULL AND stripe_payment_intent=$1) OR ($2::text IS NOT NULL AND stripe_charge=$2) ORDER BY created_at LIMIT 1`, [pi, charge]) : Promise.resolve(undefined);
const PAID = ['paid', 'partially_refunded', 'refunded', 'disputed'];
const topupAlert = (t: Db, id: string, text: string) => t.query('UPDATE credit_topups SET alert=$2, updated_at=now() WHERE id=$1', [id, text.slice(0, 600)]);
const dayPt = (d: any) => new Date(d).toLocaleDateString('pt-PT');

async function topupSessionEvent(t: Db, type: string, o: any, extra: EventExtra): Promise<'applied' | 'ignored'> {
  const id = o.metadata?.topup_id;
  if (!(typeof id === 'string' && UUID.test(id))) return 'ignored';
  const tp = await t.one('SELECT * FROM credit_topups WHERE id=$1', [id]);
  if (!tp) return 'ignored';
  if (tp.stripe_session_id && o.id && tp.stripe_session_id !== o.id) {
    await alert(t, 'billing.topup_other_session', { topup: tp.id, session: o.id, expected: tp.stripe_session_id });
    return 'ignored';
  }
  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    // Pagamento assíncrono (ex.: Multibanco): completed chega «unpaid»; os créditos entram em async_payment_succeeded.
    if (o.payment_status !== 'paid') return 'applied';
    await fulfilTopup(t, tp.id, o, extra);
    return 'applied';
  }
  // Só a Stripe expira um carregamento (nunca o relógio): sessão expirada ou pagamento assíncrono recusado.
  if (type === 'checkout.session.expired' || type === 'checkout.session.async_payment_failed') {
    await t.query(`UPDATE credit_topups SET status=$2, stripe_session_id=COALESCE(stripe_session_id, $3), updated_at=now() WHERE id=$1 AND status='pending'`, [tp.id, type.endsWith('expired') ? 'expired' : 'failed', o.id ?? null]);
    return 'applied';
  }
  return 'ignored';
}

/**
 * Carregamento pago (webhook ou regresso do Checkout): confere o valor e a moeda, credita a carteira uma só vez, guarda as provas,
 * põe-no na lista «por faturar» e envia a confirmação. Um pagamento que chegue a um lote já expirado é aceite, com alerta.
 */
export async function fulfilTopup(t: Db, topupId: string, o: any, extra: EventExtra = {}): Promise<'credited' | 'already' | 'mismatch'> {
  const tp = await t.one('SELECT * FROM credit_topups WHERE id=$1', [topupId]);
  if (!tp || !['pending', 'expired', 'failed'].includes(tp.status)) return 'already';
  const total = Math.round(Number(o.amount_total)), currency = String(o.currency ?? '').toLowerCase();
  if (!Number.isFinite(total) || currency !== tp.currency || Math.abs(total - tp.gross_cents) > 1) {
    await topupAlert(t, tp.id, `Pagamento de ${Number.isFinite(total) ? eurPt(total) : '?'} (${currency || '?'}) não confere com o carregamento (${eurPt(tp.gross_cents)}): créditos NÃO aplicados. Verificar na Stripe e reembolsar ou corrigir à mão.`);
    await alert(t, 'billing.topup_amount_mismatch', { topup: tp.id, session: o.id ?? null, amount: total, currency, expected: tp.gross_cents });
    return 'mismatch';
  }
  const late = tp.status !== 'pending';
  const pi = ref(o.payment_intent);
  if (!(await creditTopup(t, tp.id, { paymentIntent: pi, charge: extra.charge ?? null, customerId: ref(o.customer), vatCents: total - tp.net_cents }))) return 'already';
  const addr = o.customer_details?.address ?? null;
  const evidence = { ...(tp.evidence ?? {}), billingCountry: addr?.country ?? null, billingPostal: addr?.postal_code ?? null, cardCountry: extra.cardCountry ?? null };
  const customer = { name: o.customer_details?.name ?? tp.customer?.name ?? null, email: o.customer_details?.email ?? tp.customer?.email ?? null, address: addr,
    taxIds: (o.customer_details?.tax_ids ?? []).map((x: any) => ({ type: x.type, value: x.value })) };
  await t.query('UPDATE credit_topups SET evidence=$2, customer=$3, stripe_session_id=COALESCE(stripe_session_id, $4), updated_at=now() WHERE id=$1', [tp.id, JSON.stringify(evidence), JSON.stringify(customer), o.id ?? null]);
  if (late) {
    await topupAlert(t, tp.id, `Pagamento recebido depois de o carregamento ter ficado «${tp.status === 'expired' ? 'expirado' : 'falhado'}»: valor conferido e créditos aplicados.`);
    await alert(t, 'billing.topup_paid_after_expiry', { topup: tp.id, status: tp.status });
  }
  // A morada recolhida no Checkout tem de ser do país (e da região) em que o IVA foi decidido; se não for, o administrador corrige.
  if (addr?.country && addr.country !== tp.customer_country) await alert(t, 'billing.address_country_mismatch', { topup: tp.id, expected: tp.customer_country, country: addr.country });
  else if (addr?.country === 'PT' && tp.vat_country === 'PT' && tp.vat_regime === 'domestic' && regionalRate('PT', addr.postal_code) !== Number(tp.vat_rate))
    await alert(t, 'billing.address_region_mismatch', { topup: tp.id, rate: Number(tp.vat_rate), postal: addr.postal_code ?? null });
  const paid = await t.one('SELECT * FROM credit_topups WHERE id=$1', [tp.id]);
  await t.query(
    `INSERT INTO invoice_queue(kind, user_id, entity_id, topup_id, stripe_ref, stripe_customer_id, reason, description, net_cents, vat_cents, total_cents, currency,
       vat_rate, vat_regime, vat_country, vat_note, customer_kind, customer_country, customer, evidence, seller, terms_version, paid_at)
     VALUES ('topup',$1,$2,$3,$4,$5,'topup',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT (stripe_ref) DO NOTHING`,
    [paid.user_id, paid.stripe_scope, paid.id, pi ?? `topup:${paid.id}`, paid.stripe_customer_id,
      `Créditos pré-pagos para serviços de produção de vídeo com IA — ${config.brand} (vale de finalidade única): ${cr(paid.net_cents)} créditos, válidos até ${dayPt(paid.expires_at)}`,
      paid.net_cents, paid.vat_cents, paid.gross_cents, paid.currency, Number(paid.vat_rate), paid.vat_regime, paid.vat_country, paid.vat_note, paid.customer_kind, paid.customer_country,
      JSON.stringify(customer), JSON.stringify(evidence), JSON.stringify(paid.seller ?? {}), paid.terms_version, paid.paid_at]);
  await topupEmail(t, paid);
  return 'credited';
}

/** Confirmação do carregamento em suporte duradouro: valor, validade, reembolso nos 14 dias e vendedora. */
async function topupEmail(t: Db, tp: any) {
  const u = await t.one('SELECT email FROM users WHERE id=$1', [tp.user_id]);
  const to = tp.customer?.email || u?.email;
  if (!to) return;
  const s = tp.seller ?? {};
  const consumer = tp.customer_kind === 'consumer';
  const until = new Date(new Date(tp.paid_at).getTime() + REFUND_WINDOW_DAYS * 86400_000);
  const price = consumer ? `${eurPt(tp.gross_cents)} com IVA (${eurPt(tp.net_cents)} + IVA ${fmtRate(Number(tp.vat_rate))}%)` : `${eurPt(tp.net_cents)} + IVA ${eurPt(tp.vat_cents)} = ${eurPt(tp.gross_cents)}`;
  const pt = `Carregámos ${cr(tp.net_cents)} créditos na sua conta ${config.brand}, por ${price}. 1 crédito = 1 € sem IVA. Os créditos valem até ${dayPt(tp.expires_at)} e gastam-se pela ordem de validade. Pode pedir o reembolso do saldo ainda disponível deste carregamento até ${dayPt(until)} (14 dias), por email para ${s.email || contactEmail()}; é devolvido pelo mesmo meio de pagamento. A fatura-recibo é emitida pela empresa vendedora e enviada por email (o recibo da Stripe é só um comprovativo). Termos: ${config.baseUrl}/termos (versão ${tp.terms_version ?? TERMS_VERSION}). Vendedor: ${s.name || s.tradeName || '—'}${s.nif ? `, NIF ${s.nif}` : ''}.`;
  const en = `We added ${crEn(tp.net_cents)} credits to your ${config.brand} account (${eurEn(tp.gross_cents)} paid). Credits are valid until ${new Date(tp.expires_at).toISOString().slice(0, 10)}; the unused balance of this top-up can be refunded until ${until.toISOString().slice(0, 10)}.`;
  await queueEmail(t, { key: `topup:${tp.id}`, to, subject: `Créditos carregados · Credits added (${cr(tp.net_cents)})`, text: `${pt}\n\n${en}`,
    html: emailShell('Créditos carregados · Credits added', `<p>${esc(pt)}</p><p lang="en">${esc(en)}</p>`) });
}

/** Regresso do Checkout (success_url): aplica já o pagamento, sem esperar pelo webhook. Idempotente (o mesmo efeito do webhook). */
export async function confirmTopupSession(db: Db, userId: string, sessionId: string): Promise<'credited' | 'already' | 'pending' | 'unknown' | 'mismatch'> {
  const tp = await db.one('SELECT * FROM credit_topups WHERE user_id=$1 AND stripe_session_id=$2', [userId, sessionId]);
  if (!tp) return 'unknown';
  if (PAID.includes(tp.status)) return 'already';
  if (!stripeConfigured()) return 'pending';
  const o = await stripe(`checkout/sessions/${enc(sessionId)}`, undefined, 'GET');
  if (o?.metadata?.topup_id !== tp.id || o.payment_status !== 'paid') return 'pending';
  const extra = await topupPaymentInfo(ref(o.payment_intent));
  return db.tx(t => fulfilTopup(t, tp.id, o, extra));
}

/** Nota de crédito na lista «por faturar» para um reembolso concluído (valores negativos, com referência ao carregamento). */
async function refundInvoice(t: Db, refundId: string) {
  const r = await t.one(`SELECT cr.*, tp.user_id, tp.stripe_scope, tp.stripe_customer_id, tp.vat_rate, tp.vat_regime, tp.vat_country, tp.vat_note, tp.customer_kind, tp.customer_country,
      tp.customer, tp.evidence, tp.seller, tp.terms_version, tp.paid_at AS topup_paid_at, tp.moloni_doc
    FROM credit_refunds cr JOIN credit_topups tp ON tp.id=cr.topup_id WHERE cr.id=$1`, [refundId]);
  if (!r?.stripe_refund_id || r.status !== 'succeeded') return;
  await t.query(
    `INSERT INTO invoice_queue(kind, user_id, entity_id, topup_id, stripe_ref, stripe_customer_id, reason, description, net_cents, vat_cents, total_cents, currency,
       vat_rate, vat_regime, vat_country, vat_note, customer_kind, customer_country, customer, evidence, seller, terms_version, paid_at)
     VALUES ('topup_refund',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'eur',$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now()) ON CONFLICT (stripe_ref) DO NOTHING`,
    [r.user_id, r.stripe_scope, r.topup_id, r.stripe_refund_id, r.stripe_customer_id, r.reason,
      `Nota de crédito: reembolso de ${cr(r.net_cents)} créditos do carregamento de ${dayPt(r.topup_paid_at)} (fatura-recibo ${r.moloni_doc ? `n.º ${r.moloni_doc}` : 'por emitir'})${r.source === 'stripe' ? ' — reembolso feito no painel da Stripe' : ''}`,
      -r.net_cents, -(r.gross_cents - r.net_cents), -r.gross_cents, Number(r.vat_rate), r.vat_regime, r.vat_country, r.vat_note, r.customer_kind, r.customer_country,
      JSON.stringify(r.customer ?? {}), JSON.stringify(r.evidence ?? {}), JSON.stringify(r.seller ?? {}), r.terms_version]);
}

/**
 * Reembolso que a Stripe deu como concluído e que depois falhou (refund.failed, raro): os créditos já voltaram à carteira;
 * a nota de crédito desse reembolso deixa de ter razão de ser. Por emitir, sai da lista «por faturar»; já emitida, entra
 * na lista uma linha corretiva (valores positivos) para a anular no Moloni. Em ambos os casos, alerta no carregamento e
 * registo na auditoria.
 */
async function refundInvoiceReversal(t: Db, r: any, why: string) {
  if (!r?.stripe_refund_id) return;
  const nc = await t.one(`SELECT * FROM invoice_queue WHERE stripe_ref=$1 AND kind='topup_refund'`, [r.stripe_refund_id]);
  let note: string;
  if (!nc) note = 'não havia nota de crédito na lista';
  else if (nc.status === 'pending') {
    await t.query(`DELETE FROM invoice_queue WHERE id=$1 AND status='pending'`, [nc.id]);
    note = 'a nota de crédito por emitir saiu da lista «por faturar»';
  } else {
    await t.query(
      `INSERT INTO invoice_queue(kind, user_id, entity_id, topup_id, stripe_ref, stripe_customer_id, reason, description, net_cents, vat_cents, total_cents, currency,
         vat_rate, vat_regime, vat_country, vat_note, customer_kind, customer_country, customer, evidence, seller, terms_version, paid_at)
       SELECT 'topup_refund_reversal', user_id, entity_id, topup_id, $2, stripe_customer_id, reason, $3, -net_cents, -vat_cents, -total_cents, currency,
         vat_rate, vat_regime, vat_country, vat_note, customer_kind, customer_country, customer, evidence, seller, terms_version, now()
       FROM invoice_queue WHERE id=$1 ON CONFLICT (stripe_ref) DO NOTHING`,
      [nc.id, `${r.stripe_refund_id}:falhou`, `Anular a nota de crédito n.º ${nc.moloni_doc}: o reembolso ${r.stripe_refund_id} falhou na Stripe depois de concluído (${why.slice(0, 80)}) e os créditos voltaram à carteira do cliente`.slice(0, 500)]);
    note = `a nota de crédito n.º ${nc.moloni_doc} já emitida tem de ser anulada (linha corretiva na lista «por faturar»)`;
  }
  await topupAlert(t, r.topup_id, `O reembolso ${r.stripe_refund_id} (${eurPt(r.gross_cents)}) falhou na Stripe depois de concluído (${why.slice(0, 80)}): os ${cr(r.net_cents)} créditos voltaram à carteira; ${note}.`);
  await alert(t, 'billing.topup_refund_failed_after_success', { topup: r.topup_id, refund: r.stripe_refund_id, net: r.net_cents, creditNote: nc ? { id: nc.id, status: nc.status, doc: nc.moloni_doc ?? null } : null });
}

/**
 * Reembolso do saldo disponível de um carregamento (ação do administrador): debita a carteira numa transação e só depois
 * pede o reembolso à Stripe (Idempotency-Key do pedido), com as chaves da conta que recebeu o pagamento.
 */
export async function refundTopup(db: Db, topupId: string, o: { reason: 'withdrawal' | 'closure'; actor: string }) {
  const { refund } = await db.tx(t => startRefund(t, topupId, o));
  return sendRefund(db, refund.id);
}

/** Envia (ou repete) o pedido de reembolso à Stripe. Num erro de rede fica pendente para repetir com a mesma chave. */
export async function sendRefund(db: Db, refundId: string): Promise<{ status: 'succeeded' | 'pending' | 'failed' | 'unknown'; message: string }> {
  const r = await db.one(`SELECT cr.*, tp.stripe_payment_intent, tp.entity_id, tp.stripe_account FROM credit_refunds cr JOIN credit_topups tp ON tp.id=cr.topup_id WHERE cr.id=$1`, [refundId]);
  if (!r || r.source !== 'app' || r.status !== 'pending') return { status: 'unknown', message: 'Pedido de reembolso inexistente ou já tratado.' };
  return inEntity(r.entity_id, async () => {
    if (!stripeConfigured()) return { status: 'unknown' as const, message: 'Stripe não configurado: o reembolso fica pendente.' };
    if (r.stripe_account && keyFingerprint() !== r.stripe_account) {
      await db.query('UPDATE credit_refunds SET error=$2, updated_at=now() WHERE id=$1', [r.id, 'A chave Stripe em uso não é a da conta que recebeu este pagamento.']);
      return { status: 'unknown' as const, message: 'A chave Stripe em uso não é a da conta que recebeu este pagamento: o reembolso fica pendente (repita com as chaves certas, ou faça-o no painel da Stripe).' };
    }
    try {
      let re: any = null;
      // Repetição de um pedido sem resposta: se a Stripe já o tiver, adota-o em vez de pedir outro.
      if (r.stripe_refund_id) re = await stripe(`refunds/${enc(r.stripe_refund_id)}`, undefined, 'GET');
      else if (r.error) re = ((await stripe('refunds', { payment_intent: r.stripe_payment_intent, limit: 100 }, 'GET'))?.data ?? []).find((x: any) => x?.metadata?.refund_id === r.id) ?? null;
      if (!re) re = await stripe('refunds', { payment_intent: r.stripe_payment_intent, amount: r.gross_cents, reason: 'requested_by_customer', metadata: { app: STRIPE_APP, kind: 'topup_refund', topup_id: r.topup_id, refund_id: r.id } }, 'POST', { idempotencyKey: `${STRIPE_APP}:refund:${r.id}` });
      if (re.status === 'failed' || re.status === 'canceled') {
        await db.tx(t => refundFailed(t, r.id, String(re.failure_reason ?? re.status)));
        return { status: 'failed' as const, message: `A Stripe recusou o reembolso (${re.failure_reason ?? re.status}); os créditos voltaram à carteira.` };
      }
      const ok = re.status === 'succeeded';
      await db.tx(async t => { await refundAccepted(t, r.id, re.id, ok); if (ok) await refundInvoice(t, r.id); });
      return { status: ok ? 'succeeded' as const : 'pending' as const, message: ok ? `Reembolso de ${eurPt(r.gross_cents)} feito (${cr(r.net_cents)} créditos).` : `Reembolso de ${eurPt(r.gross_cents)} pedido; a Stripe ainda o está a processar.` };
    } catch (e: any) {
      if (e instanceof StripeError && e.status >= 400 && e.status < 500 && ![409, 429].includes(e.status)) {
        await db.tx(t => refundFailed(t, r.id, e.message));
        return { status: 'failed' as const, message: `A Stripe recusou o reembolso: ${e.message}. Os créditos voltaram à carteira.` };
      }
      await db.query('UPDATE credit_refunds SET error=$2, updated_at=now() WHERE id=$1', [r.id, String(e?.message ?? e).slice(0, 500)]);
      return { status: 'unknown' as const, message: `Sem resposta da Stripe (${String(e?.message ?? e).slice(0, 120)}): o reembolso fica pendente; repita o pedido.` };
    }
  });
}

/** Reembolso (refund.*) de um pagamento de carregamento: pedido pela aplicação ou feito no painel da Stripe. */
async function refundEvent(t: Db, o: any): Promise<'applied' | 'ignored'> {
  if (typeof o?.id !== 'string') return 'ignored';
  const tp = await topupByPayment(t, ref(o.payment_intent), ref(o.charge));
  if (!tp) return 'ignored';
  const status = String(o.status ?? '');
  const gone = status === 'failed' || status === 'canceled';
  // O nosso pedido: pela metadata que lhe pusemos (o webhook pode chegar antes da resposta da API) ou pelo id já guardado.
  const mine = (typeof o.metadata?.refund_id === 'string' && UUID.test(o.metadata.refund_id) ? await t.one(`SELECT * FROM credit_refunds WHERE id=$1 AND topup_id=$2 AND source='app'`, [o.metadata.refund_id, tp.id]) : null)
    ?? await t.one('SELECT * FROM credit_refunds WHERE stripe_refund_id=$1', [o.id]);
  if (mine?.source === 'app') {
    if (gone) {
      await refundFailed(t, mine.id, String(o.failure_reason ?? status));
      if (mine.status === 'succeeded') await refundInvoiceReversal(t, mine, String(o.failure_reason ?? status));
    } else if ((await refundAccepted(t, mine.id, o.id, status === 'succeeded')) && status === 'succeeded') await refundInvoice(t, mine.id);
    return 'applied';
  }
  if (mine?.source === 'stripe') {
    if (gone) {
      await externalRefundFailed(t, o.id);
      if (mine.status === 'succeeded') await refundInvoiceReversal(t, mine, String(o.failure_reason ?? status));
    } else if (status === 'succeeded' && (await externalRefundSucceeded(t, o.id))) await refundInvoice(t, mine.id);
    return 'applied';
  }
  if (gone) return 'ignored';
  if (!PAID.includes(tp.status)) {
    await topupAlert(t, tp.id, `Reembolso ${o.id} de ${eurPt(Number(o.amount ?? 0))} sobre um carregamento que não foi creditado (${tp.status}): verificar.`);
    return 'applied';
  }
  const done = await externalRefund(t, tp, { stripeRefundId: o.id, grossCents: Math.round(Number(o.amount ?? 0)), succeeded: status === 'succeeded' });
  if (done) {
    await alert(t, 'billing.topup_refunded_outside_app', { topup: tp.id, refund: o.id, net: done.refund.net_cents, debt: done.entry.debt_delta });
    if (status === 'succeeded') await refundInvoice(t, done.refund.id);
  }
  return 'applied';
}

/**
 * Disputa (chargeback) do pagamento de um carregamento: aberta congela a carteira e debita; encerrada repõe se o dinheiro
 * não saiu. Um inquérito do emissor do cartão (estado warning_*) também abre por charge.dispute.created e é tratado como
 * uma disputa (créditos retidos enquanto está aberto); se fechar sem chargeback (warning_closed) é como uma disputa
 * ganha: os créditos voltam e a carteira descongela. Só 'lost' fica debitado; outro estado ao fechar fica para verificar.
 */
async function disputeEvent(t: Db, type: string, o: any): Promise<'applied' | 'ignored'> {
  if (typeof o?.id !== 'string') return 'ignored';
  const tp = await topupByPayment(t, ref(o.payment_intent), ref(o.charge));
  if (!tp) return 'ignored';
  const status = String(o.status ?? '');
  const inquiry = status.startsWith('warning_');
  if (type === 'charge.dispute.created') {
    if (!PAID.includes(tp.status)) { await topupAlert(t, tp.id, `Disputa ${o.id} sobre um carregamento que não foi creditado (${tp.status}): verificar.`); return 'applied'; }
    const e = await disputeOpened(t, tp, { disputeId: o.id, grossCents: Math.round(Number(o.amount ?? tp.gross_cents)), inquiry });
    if (e) await alert(t, 'billing.topup_disputed', { topup: tp.id, dispute: o.id, status: status || null, taken: -e.available_delta, debt: e.debt_delta });
    return 'applied';
  }
  if (!['won', 'warning_closed', 'lost'].includes(status)) {
    await topupAlert(t, tp.id, `Disputa ${o.id} encerrada com o estado «${status || '—'}», que o portal não conhece: verificar no painel da Stripe (a carteira continua congelada).`);
    return 'applied';
  }
  const r = await disputeClosed(t, { disputeId: o.id, won: status !== 'lost', inquiry: status === 'warning_closed' });
  if (r) await alert(t, 'billing.topup_dispute_closed', { topup: tp.id, dispute: o.id, status });
  return r ? 'applied' : 'ignored';
}
