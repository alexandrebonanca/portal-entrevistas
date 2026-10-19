import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit } from '../app.ts';
import { quotaFor, createCheckout, createPortal, stripeConfigured, verifyStripeSignature, applyStripeEvent, ACTIVE_STATUSES } from '../billing.ts';
import { S, inEntity } from '../settings.ts';

const eur = (c: number) => `€${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

export async function billingRoutes(app: FastifyInstance) {
  const db = app.db;
  const send = (reply: any, html: string) => reply.type('text/html; charset=utf-8').send(html);
  const nav = `<a href="/painel">Dashboard</a><a href="/account">Account</a><form method="post" action="/sair" style="display:inline"><button class="ghost" style="padding:6px 12px;min-height:0;margin-left:16px">Sign out</button></form>`;

  app.get('/account', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, () => accountPage(req, reply));
  });
  const accountPage = async (req: any, reply: any) => {
    const q = req.query as any;
    const plans = await db.query('SELECT * FROM plans WHERE active ORDER BY sort');
    const quota = await quotaFor(db, req.user);
    const sub = quota.sub;
    const active = sub && ACTIVE_STATUSES.includes(sub.status);
    const body = `<div class="narrow" style="padding-top:36px"><h1>Your account</h1>
${q.checkout === 'success' ? flash('Thank you! Your subscription will be active in a few seconds. Refresh this page if it still shows as inactive.') : ''}${q.checkout === 'cancelled' ? flash('Checkout cancelled — nothing was charged.', 'bad') : ''}${flash(q.e, 'bad')}
<div class="card sans"><strong>${esc(req.user.name)}</strong> · ${esc(req.user.email)}<br>
${req.user.role === 'admin' ? 'Administrator — no interview limit.' : active ? `Plan: <strong>${esc(sub.plan_name ?? '—')}</strong> ${pill(sub.status, 'ok')}<br>Interviews this period: <strong>${quota.used} / ${quota.limit}</strong>${sub.current_period_end ? `<br>Renews / ends: ${fmtDate(sub.current_period_end)}${sub.cancel_at_period_end ? ' (cancels at period end)' : ''}` : ''}` : `No active subscription ${sub ? pill(sub.status, 'bad') : ''}`}</div>
${req.user.role === 'admin' ? '' : `<h2>${active ? 'Change plan' : 'Choose a plan'}</h2>
<div class="grid3">${plans.map((p: any) => `<form method="post" action="/subscribe/${esc(p.id)}" class="card"><h3 style="margin-top:0">${esc(p.name)}</h3><p style="font-size:1.6rem;margin:.2em 0">${eur(p.price_cents)}<span class="hint"> / month</span></p><p>Up to <strong>${p.interviews_per_month}</strong> interviews per month.</p><button class="accent" ${stripeConfigured() ? '' : 'disabled'}>${active ? 'Switch' : 'Subscribe'}</button></form>`).join('')}</div>
${stripeConfigured() ? '' : '<p class="hint">Online payments are not enabled yet. Please contact us to activate your plan.</p>'}
${req.user.role !== 'admin' && (await db.one('SELECT stripe_customer_id FROM users WHERE id=$1', [req.user.id]))?.stripe_customer_id ? '<form method="post" action="/billing/portal"><button class="ghost">Manage billing, invoices &amp; cancellation</button></form>' : ''}`}
</div>`;
    return send(reply, page({ lang: 'en', title: 'Account', body, nav, noindex: true }));
  };

  app.post('/subscribe/:plan', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    const plan = await db.one('SELECT * FROM plans WHERE id=$1 AND active', [(req.params as any).plan]);
    if (!plan) return reply.code(404).send('Plan not found');
    try {
      const url = await inEntity(req.user.entity_id, () => createCheckout(db, req.user!, plan));
      await audit(db, req.user.email, 'billing.checkout_started', null, { plan: plan.id });
      return reply.redirect(url, 303);
    } catch (e: any) { return reply.redirect('/account?e=' + encodeURIComponent(String(e.message).slice(0, 160))); }
  });

  app.post('/billing/portal', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    const u = await db.one('SELECT stripe_customer_id FROM users WHERE id=$1', [req.user.id]);
    if (!u?.stripe_customer_id) return reply.redirect('/account');
    try { return reply.redirect(await inEntity(req.user.entity_id, () => createPortal(u.stripe_customer_id)), 303); }
    catch (e: any) { return reply.redirect('/account?e=' + encodeURIComponent(String(e.message).slice(0, 160))); }
  });

  // Webhook: o corpo tem de chegar em bruto para verificar a assinatura.
  // /webhooks/stripe (chaves globais) e /webhooks/stripe/:slug (chaves da entidade).
  const webhook = async (req: any, reply: any, entityId: string | null) => inEntity(entityId, async () => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.headers['stripe-signature'] as string, S('STRIPE_WEBHOOK_SECRET'))) return reply.code(400).send({ error: 'invalid signature' });
    let ev: any;
    try { ev = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'bad json' }); }
    const r = await applyStripeEvent(db, ev);
    return { received: true, result: r };
  });
  app.post('/webhooks/stripe', (req, reply) => webhook(req, reply, null));
  app.post('/webhooks/stripe/:slug', async (req, reply) => {
    const e = await db.one('SELECT id FROM entities WHERE slug=$1', [(req.params as any).slug]);
    if (!e) return reply.code(404).send({ error: 'unknown entity' });
    return webhook(req, reply, e.id);
  });
  void config;
}
