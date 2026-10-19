import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import { config } from './config.ts';
import { S } from './settings.ts';

export const ACTIVE_STATUSES = ['active', 'trialing', 'comped'];

/** Estado da subscrição e quota de entrevistas do período corrente. Administradores não têm limite. */
export async function quotaFor(db: Db, user: { id: string; role: string }) {
  if (user.role === 'admin') return { allowed: true, unlimited: true, used: 0, limit: Infinity, plan: null as any, sub: null as any, reason: '' };
  const sub = await db.one(`SELECT s.*, p.name AS plan_name, p.interviews_per_month, p.price_cents FROM subscriptions s LEFT JOIN plans p ON p.id=s.plan_id WHERE s.user_id=$1`, [user.id]);
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

export async function stripe(path: string, params?: object, method = 'POST'): Promise<any> {
  const key = S('STRIPE_SECRET_KEY');
  if (!key) throw new Error('Stripe não configurado');
  const body = params ? new URLSearchParams(flatten(params)).toString() : undefined;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method, headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body: method === 'GET' ? undefined : body,
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe: ${j?.error?.message ?? res.status}`);
  return j;
}

export async function createCheckout(db: Db, user: { id: string; email: string }, plan: any) {
  const u = await db.one('SELECT stripe_customer_id FROM users WHERE id=$1', [user.id]);
  const s = await stripe('checkout/sessions', {
    mode: 'subscription',
    ...(u?.stripe_customer_id ? { customer: u.stripe_customer_id } : { customer_email: user.email }),
    client_reference_id: user.id,
    success_url: `${config.baseUrl}/account?checkout=success`,
    cancel_url: `${config.baseUrl}/account?checkout=cancelled`,
    line_items: [{ quantity: 1, price_data: { currency: plan.currency, unit_amount: plan.price_cents, recurring: { interval: 'month' }, product_data: { name: `${config.brand} — ${plan.name} (up to ${plan.interviews_per_month} interviews / month)` } } }],
    metadata: { user_id: user.id, plan_id: plan.id },
    subscription_data: { metadata: { user_id: user.id, plan_id: plan.id } },
  });
  return s.url as string;
}

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

/** Aplica um evento Stripe. Idempotente por id de evento. */
export async function applyStripeEvent(db: Db, ev: any): Promise<'applied' | 'duplicate' | 'ignored'> {
  const dup = await db.one('INSERT INTO payment_events(id, type, payload) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id', [ev.id, ev.type, JSON.stringify({ id: ev.id, type: ev.type, object: ev.data?.object?.id })]);
  if (!dup) return 'duplicate';
  const o = ev.data?.object ?? {};
  if (ev.type === 'checkout.session.completed' && o.mode === 'subscription') {
    const userId = o.client_reference_id ?? o.metadata?.user_id, planId = o.metadata?.plan_id;
    if (!userId) return 'ignored';
    if (o.customer) await db.query('UPDATE users SET stripe_customer_id=$2 WHERE id=$1', [userId, o.customer]);
    await db.query(
      `INSERT INTO subscriptions(user_id, plan_id, status, source, stripe_subscription_id) VALUES ($1,$2,'active','stripe',$3)
       ON CONFLICT (user_id) DO UPDATE SET plan_id=COALESCE($2, subscriptions.plan_id), status='active', source='stripe', stripe_subscription_id=$3, updated_at=now()`, [userId, planId ?? null, o.subscription ?? null]);
    return 'applied';
  }
  if (['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted'].includes(ev.type)) {
    const item = o.items?.data?.[0];
    const start = iso(o.current_period_start ?? item?.current_period_start), end = iso(o.current_period_end ?? item?.current_period_end);
    const status = ev.type.endsWith('deleted') ? 'canceled' : mapStatus(o.status);
    const userId = o.metadata?.user_id;
    const r = await db.one(
      `UPDATE subscriptions SET status=$2, current_period_start=COALESCE($3, current_period_start), current_period_end=COALESCE($4, current_period_end), cancel_at_period_end=$5, updated_at=now()
       WHERE stripe_subscription_id=$1 RETURNING id`, [o.id, status, start, end, !!o.cancel_at_period_end]);
    if (!r && userId) {
      await db.query(
        `INSERT INTO subscriptions(user_id, plan_id, status, source, stripe_subscription_id, current_period_start, current_period_end, cancel_at_period_end) VALUES ($1,$2,$3,'stripe',$4,$5,$6,$7)
         ON CONFLICT (user_id) DO UPDATE SET status=$3, stripe_subscription_id=$4, current_period_start=$5, current_period_end=$6, updated_at=now()`,
        [userId, o.metadata?.plan_id ?? null, status, o.id, start, end, !!o.cancel_at_period_end]);
    }
    return 'applied';
  }
  return 'ignored';
}
