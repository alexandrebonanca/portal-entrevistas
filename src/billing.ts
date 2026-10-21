import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc } from './lib.ts';
import { S, stripeScopedValue, saveStripeScoped } from './settings.ts';
import { vatFor, countryName, ptRegion, regionalRate, withVat, eurPt, fmtRate, type VatDecision, type VatOk } from './vat.ts';
import { seller, sellerBlock, TERMS_VERSION, WITHDRAWAL_DAYS, type Seller } from './legal.ts';
import { queueEmail, emailShell } from './mail.ts';

export const ACTIVE_STATUSES = ['active', 'trialing', 'comped'];
/** Estados em que uma subscrição Stripe continua viva (a cobrar). */
export const LIVE_STRIPE = ['active', 'trialing', 'past_due'];
/** Marca dos objetos deste portal na Stripe (a conta pode ser partilhada com outros portais). */
export const STRIPE_APP = 'quietinterview';
/** Eventos a ativar no webhook da Stripe (global e de cada entidade). */
export const STRIPE_EVENTS = 'checkout.session.completed, customer.subscription.created/updated/deleted, invoice.paid, invoice.payment_failed, customer.tax_id.created/updated';

/** Estado da subscrição e quota de entrevistas do período corrente. Administradores não têm limite. */
export async function quotaFor(db: Db, user: { id: string; role: string }) {
  if (user.role === 'admin') return { allowed: true, unlimited: true, used: 0, limit: Infinity, plan: null as any, sub: null as any, reason: '' };
  const sub = await db.one(`SELECT s.*, p.name AS plan_name, p.interviews_per_month, p.price_cents, p.max_answer_total_sec, p.max_questions FROM subscriptions s LEFT JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1`, [user.id]);
  if (!sub || !ACTIVE_STATUSES.includes(sub.status)) return { allowed: false, unlimited: false, used: 0, limit: 0, plan: null, sub, reason: 'no_subscription' };
  if (sub.current_period_end && new Date(sub.current_period_end) < new Date(Date.now() - 3 * 86400_000)) return { allowed: false, unlimited: false, used: 0, limit: 0, plan: sub, sub, reason: 'expired' };
  const now = new Date();
  const start = sub.current_period_start ? new Date(sub.current_period_start) : new Date(now.getFullYear(), now.getMonth(), 1);
  const limit = sub.interviews_override ?? sub.interviews_per_month ?? 0;
  const used = Number((await db.one(`SELECT count(*)::int AS n FROM interviews WHERE owner_id=$1 AND invited_at >= $2`, [user.id, start])).n);
  return { allowed: used < limit, unlimited: false, used, limit, plan: sub, sub, reason: used < limit ? '' : 'quota' };
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
const keyFingerprint = () => createHash('sha256').update(S('STRIPE_SECRET_KEY')).digest('hex').slice(0, 16);

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

/** Cliente Stripe com os dados de faturação (o Checkout mostra-os preenchidos). Se for de outra conta Stripe, cria outro. */
export async function ensureCustomer(db: Db, user: { id: string; email: string }, profile: any) {
  const fields = { name: profile.name, email: user.email, address: { line1: profile.address, postal_code: profile.postal_code, city: profile.city, country: profile.country }, metadata: { app: STRIPE_APP, user_id: user.id } };
  const cur = (await db.one('SELECT stripe_customer_id FROM users WHERE id=$1', [user.id]))?.stripe_customer_id;
  if (cur) {
    try { await stripe(`customers/${enc(cur)}`, fields); return cur as string; }
    catch (e) { if (!missing(e)) throw e; }
  }
  const c = await stripe('customers', fields);
  await db.query('UPDATE users SET stripe_customer_id=$2 WHERE id=$1', [user.id, c.id]);
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
  const extra = ev.type === 'invoice.paid' && typeof o.id === 'string' ? { cardCountry: await cardCountry(invoiceSubId(o), ref(o.customer)) } : {};
  return db.tx(async (t) => {
    const fresh = await t.one('INSERT INTO payment_events(id, type, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [ev.id, ev.type, JSON.stringify({ id: ev.id, type: ev.type, object: o.id })]);
    if (!fresh) return 'duplicate';
    return applyEffect(t, ev, entityId, extra);
  });
}

async function applyEffect(t: Db, ev: any, entityId: string | null, extra: { cardCountry?: string | null }): Promise<'applied' | 'ignored'> {
  const o = ev.data?.object ?? {}, type = String(ev.type ?? '');
  if (type.startsWith('checkout.session.')) {
    if (!(await ownSession(t, o))) return 'ignored';
    return type === 'checkout.session.completed' && o.mode === 'subscription' ? sessionCompleted(t, o) : 'ignored';
  }
  if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(type)) return subscriptionChanged(t, type, o);
  if (type === 'invoice.paid' || type === 'invoice.payment_failed') return invoiceEvent(t, type, o, entityId, extra);
  if (type === 'customer.tax_id.updated' || type === 'customer.tax_id.created') return taxIdChanged(t, o);
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
  if (customer) await t.query('UPDATE users SET stripe_customer_id=$2 WHERE id=$1', [userId, customer]);
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
async function invoiceEvent(t: Db, type: string, o: any, entityId: string | null, extra: { cardCountry?: string | null }): Promise<'applied' | 'ignored'> {
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
