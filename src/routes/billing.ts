import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit } from '../app.ts';
import { quotaFor, noSubscriptionNeeded, createCheckout, changePlan, cancelNow, createPortal, stripeConfigured, verifyStripeSignature, applyStripeEvent, verifyVatNumber, vatForProfile, customerFor, ACTIVE_STATUSES, LIVE_STRIPE } from '../billing.ts';
import { findWallet, crEn } from '../wallet.ts';
import { S, inEntity } from '../settings.ts';
import { seller, sellerId, checkoutBlock, contactEmail, homeConsumerRate, termsBody, paymentsPrivacyBody, complaintsLink, CONSENT_START_NOW, CONSENT_WAIVER, TERMS_VERSION, WITHDRAWAL_DAYS, type Seller } from '../legal.ts';
import { withVat, eurEn, eurPt, fmtRate, normNif, normPostal, normVatNumber, isEuCountry, outsideVatTerritory, countryName, EU_COUNTRIES, OUTSIDE_EU, type VatDecision } from '../vat.ts';
import { queueEmail, emailShell } from '../mail.ts';
import { premiumRate } from '../quotes.ts';
import { helpNav } from '../support.ts';
import { freeInterviewFor, freeNotice, freeMsg } from '../free-interview.ts';

/** Mensagem nas duas línguas (a área de faturação é em inglês; o português é obrigatório para os consumidores). */
const both = (m: { pt: string; en: string }) => `${m.en} · ${m.pt}`;
/** Subscrição paga na Stripe e ainda viva (a cobrar). */
const liveStripe = (sub: any) => !!(sub && sub.source === 'stripe' && sub.stripe_subscription_id && LIVE_STRIPE.includes(sub.status));
/** Consumidor dentro dos 14 dias da livre resolução de uma subscrição paga. */
const withdrawable = (profile: any, sub: any) => profile?.kind === 'consumer' && liveStripe(sub) && !!sub.contract_started_at && Date.now() - new Date(sub.contract_started_at).getTime() <= WITHDRAWAL_DAYS * 86400_000;
/** Empresa de outro país da UE com número de IVA ainda não confirmado no VIES (a autoliquidação depende dele). */
const vatUnconfirmed = (profile: any, s: Seller) => profile?.kind === 'business' && !!profile.vat_number && profile.country !== s.country && profile.vat_status !== 'verified';
/** Recusa com o email de contacto («contacte-nos»). */
const withContact = (m: { pt: string; en: string }, s?: Seller) => ({ en: `${m.en} (${contactEmail(s)})`, pt: `${m.pt} (${contactEmail(s)})` });
const VAT_STATUS: Record<string, string> = { pending: 'checking in VIES', verified: 'verified in VIES', unverified: 'not confirmed by VIES', unavailable: 'VIES unavailable, will retry' };

export async function billingRoutes(app: FastifyInstance) {
  const db = app.db;
  const send = (reply: any, html: string) => reply.type('text/html; charset=utf-8').send(html);
  const nav = (u: any) => `<a href="/painel">Dashboard</a><a href="/account">Account</a><a href="/conta/creditos">Credits</a>${helpNav(u, 'en')}<form method="post" action="/sair" style="display:inline"><button class="ghost" style="padding:6px 12px;min-height:0;margin-left:16px">Sign out</button></form>`;
  const profileOf = (userId: string) => db.one('SELECT * FROM billing_profiles WHERE user_id=$1', [userId]);
  const back = (reply: any, e: string, anchor = '') => reply.redirect('/account?e=' + encodeURIComponent(e.slice(0, 500)) + anchor);
  const okBack = (reply: any, m: string) => reply.redirect('/account?ok=' + encodeURIComponent(m));

  app.get('/account', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, () => accountPage(req, reply));
  });
  const accountPage = async (req: any, reply: any) => {
    const q = req.query as any;
    const isAdmin = req.user.role === 'admin';
    const manager = req.user.role === 'entity_admin'; // convida sem subscrição (os créditos continuam a servir-lhe)
    const plans = await db.query('SELECT * FROM plans WHERE active ORDER BY sort');
    const quota = await quotaFor(db, req.user);
    const sub = quota.sub;
    const active = sub && ACTIVE_STATUSES.includes(sub.status);
    const profile = await profileOf(req.user.id);
    const s = seller();
    const live = liveStripe(sub);
    const consumer = profile?.kind === 'consumer';
    const d: VatDecision | null = profile ? vatForProfile(profile, s) : null;
    const block = profile ? checkoutBlock(s, consumer) : checkoutBlock(s, false);
    const pendingVat = vatUnconfirmed(profile, s);
    const legacy = active && sub.plan_id && !plans.some((p: any) => p.id === sub.plan_id);
    const withdrawal = await db.one(`SELECT * FROM withdrawals WHERE user_id=$1 ORDER BY requested_at DESC LIMIT 1`, [req.user.id]);
    const customerId = await customerFor(db, req.user.id);
    const wallet = isAdmin ? null : await findWallet(db, req.user.id, req.user.entity_id);
    const home = homeConsumerRate(s);
    // 1.ª entrevista grátis (entrevistador sem entidade nem subscrição): disponível, falta confirmar o email, usada ou indisponível.
    const freeBox = await freeNotice(db, isAdmin || manager ? null : await freeInterviewFor(db, req.user), req.user, { lang: 'en', back: '/account', msg: freeMsg(q) });

    // Preço: empresas «+ VAT»; consumidores o valor com IVA primeiro, também em português.
    const price = (p: any) => {
      if (!d || !d.ok) return `<p style="font-size:1.6rem;margin:.2em 0">${eurEn(p.price_cents)}<span class="hint"> + VAT / month</span></p>${home ? `<p class="hint">${eurEn(withVat(p.price_cents, home))} incl. ${fmtRate(home)}% VAT · <span lang="pt-PT">consumidores: ${eurPt(withVat(p.price_cents, home))}/mês com IVA incluído</span></p>` : ''}`;
      const gross = withVat(p.price_cents, d.rate);
      if (consumer) return `<p style="font-size:1.6rem;margin:.2em 0">${eurEn(gross)}<span class="hint"> / month incl. VAT</span></p><p class="hint" lang="pt-PT">${eurPt(gross)}/mês com IVA incluído (${eurPt(p.price_cents)} + IVA ${fmtRate(d.rate)}%)</p>`;
      if (d.regime === 'reverse_charge') return `<p style="font-size:1.6rem;margin:.2em 0">${eurEn(p.price_cents)}<span class="hint"> / month</span></p><p class="hint">No VAT: reverse charge (VAT number verified in VIES).</p>`;
      return `<p style="font-size:1.6rem;margin:.2em 0">${eurEn(p.price_cents)}<span class="hint"> + VAT / month</span></p><p class="hint">${eurEn(gross)} with ${fmtRate(d.rate)}% VAT</p>`;
    };
    // O botão diz que há obrigação de pagar (DL 24/2014, art. 5.º, n.º 3; TJUE C-249/21).
    const button = (p: any) => {
      const gross = d && d.ok ? withVat(p.price_cents, d.rate) : p.price_cents;
      if (live) return consumer ? `Mudar para ${esc(p.name)} e pagar a diferença já · Switch and pay the difference now` : `Switch to ${esc(p.name)} and pay the difference now`;
      if (consumer) return `Subscrever e pagar ${eurPt(gross)}/mês · Subscribe and pay ${eurEn(gross)}/month`;
      return d && d.ok && d.regime === 'reverse_charge' ? `Subscribe and pay ${eurEn(p.price_cents)} / month` : `Subscribe and pay ${eurEn(p.price_cents)} + VAT / month`;
    };
    const canBuy = stripeConfigured() && !block && !!d?.ok && !pendingVat;
    const planCard = (p: any) => {
      const current = active && sub.plan_id === p.id;
      const form = current ? `<p>${pill('Your current plan', 'ok')}</p>`
        : !profile ? '<p class="hint">Fill in your billing details first (below). · <span lang="pt-PT">Preencha primeiro os dados de faturação.</span></p>'
        : `<label class="check"><input type="checkbox" name="terms" value="1" required> <span>I accept the <a href="/termos">terms of sale</a> (<span lang="pt-PT">termos e condições</span>) and the <a href="/privacidade-pagamentos">payments privacy notice</a>.</span></label>
${consumer ? `<label class="check" lang="pt-PT"><input type="checkbox" name="start_now" value="1" required> <span>${esc(CONSENT_START_NOW)}</span></label>
<label class="check" lang="pt-PT"><input type="checkbox" name="waiver" value="1" required> <span>${esc(CONSENT_WAIVER)}</span></label>` : ''}
<button class="accent" ${canBuy ? '' : 'disabled'}>${button(p)}</button>`;
      return `<form method="post" action="/subscribe/${esc(p.id)}" class="card"><h3 style="margin-top:0">${esc(p.name)}</h3>${price(p)}
<p>Up to <strong>${p.interviews_per_month}</strong> interviews per month · up to ${p.max_questions} questions and ${Math.round(p.max_answer_total_sec / 60)} min of answers per interview · photos only.</p>${form}</form>`;
    };
    const v = (k: string) => esc(profile?.[k] ?? '');
    const country = profile?.country ?? 'PT';
    const profileForm = `<form method="post" action="/billing/profile">
<fieldset style="border:0;padding:0;margin:0"><legend style="font-weight:600">Customer type · <span lang="pt-PT">Tipo de cliente</span></legend>
<label class="check"><input type="radio" name="kind" value="business" required ${profile?.kind === 'business' ? 'checked' : ''}> <span>Business or sole trader · <span lang="pt-PT">Empresa ou empresário em nome individual</span></span></label>
<label class="check"><input type="radio" name="kind" value="consumer" ${consumer ? 'checked' : ''}> <span>Private individual (consumer) · <span lang="pt-PT">Particular (consumidor)</span></span></label></fieldset>
<label for="b_name">Name or company name · <span lang="pt-PT">Nome ou firma</span></label><input id="b_name" name="name" type="text" required maxlength="120" value="${v('name')}" autocomplete="organization">
<label for="b_country">Billing country · <span lang="pt-PT">País de faturação</span></label><select id="b_country" name="country">${['PT', ...EU_COUNTRIES.filter(c => c !== 'PT').sort((a, b) => countryName(a, 'en').localeCompare(countryName(b, 'en')))].map(c => `<option value="${c}" ${country === c ? 'selected' : ''}>${esc(countryName(c, 'en'))}</option>`).join('')}<option value="other">Other country (outside the EU) · Outro país</option></select>
<label for="b_tax">NIF (Portugal) or EU VAT number <span class="hint">(required for Portuguese businesses; optional for private customers · obrigatório para empresas portuguesas)</span></label><input id="b_tax" name="tax_id" type="text" maxlength="20" value="${esc(profile?.nif ?? profile?.vat_number ?? '')}">
<label for="b_addr">Address · <span lang="pt-PT">Morada</span></label><input id="b_addr" name="address" type="text" required maxlength="200" value="${v('address')}" autocomplete="street-address">
<div class="row"><div class="grow"><label for="b_cp">Postal code · <span lang="pt-PT">Código postal</span></label><input id="b_cp" name="postal_code" type="text" required maxlength="12" placeholder="1000-001" value="${v('postal_code')}" autocomplete="postal-code"></div>
<div class="grow"><label for="b_city">City · <span lang="pt-PT">Localidade</span></label><input id="b_city" name="city" type="text" required maxlength="80" value="${v('city')}"></div></div>
<p class="hint">VAT follows the billing address: in Portugal 23% (mainland), 22% (Madeira) or 16% (Azores); businesses in other EU countries with a VAT number verified in VIES pay no VAT (reverse charge). Outside the EU, please contact us. · <span lang="pt-PT">O IVA segue a morada de faturação.</span></p>
<button class="accent">Save billing details</button></form>`;
    const profileCard = `<div class="card sans" id="billing"><h2 style="margin-top:0">Billing details <span class="hint" lang="pt-PT">· Dados de faturação</span></h2>
${profile ? `<p>${pill(consumer ? 'Private individual · Particular' : 'Business · Empresa')} <strong>${esc(profile.name)}</strong>${profile.nif ? ` · NIF ${esc(profile.nif)}` : ''}${profile.vat_number ? ` · VAT ${esc(profile.vat_number)} ${pill(VAT_STATUS[profile.vat_status] ?? 'not checked', profile.vat_status === 'verified' ? 'ok' : 'warn')}` : ''}<br>
${esc(profile.address)}, ${esc(profile.postal_code)} ${esc(profile.city)}, ${esc(countryName(profile.country, 'en'))}${d?.ok ? ` · ${esc(d.note.en)}` : ''}</p><details><summary>Edit · Alterar</summary>${profileForm}</details>` : profileForm}</div>`;
    const withdrawCard = withdrawal?.status === 'requested' && withdrawal.stripe_ref === sub?.stripe_subscription_id
      ? `<div class="card sans" lang="pt-PT"><h2 style="margin-top:0">Livre resolução</h2><p>Pedido de desistência recebido em ${fmtDate(withdrawal.requested_at)}. O reembolso é tratado no prazo de 14 dias.</p></div>`
      : withdrawable(profile, sub) ? `<div class="card sans" lang="pt-PT"><h2 style="margin-top:0">Direito de livre resolução</h2><p>Pode desistir deste contrato até ${fmtDate(new Date(new Date(sub.contract_started_at).getTime() + WITHDRAWAL_DAYS * 86400_000))}, sem indicar o motivo.</p><a class="btn ghost" href="/billing/livre-resolucao">Desistir do contrato aqui</a></div>` : '';
    const problem = block ? both(block) : d && !d.ok ? both(d.message) : pendingVat ? (profile.vat_status === 'unverified'
      ? 'VIES did not confirm your VAT number: correct it, or remove it to pay with VAT. · O VIES não confirmou o número de IVA.'
      : 'We are still checking your VAT number in VIES: try again in a few minutes, or remove it to pay with VAT. · A verificação do número de IVA no VIES ainda não terminou.') : '';

    const body = `<div class="narrow" style="padding-top:36px"><h1>Your account</h1>
${q.checkout === 'success' ? flash('Thank you! Your subscription will be active in a few seconds. Refresh this page if it still shows as inactive.') : ''}${q.checkout === 'cancelled' ? flash('Checkout cancelled — nothing was charged.', 'bad') : ''}${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card sans"><strong>${esc(req.user.name)}</strong> · ${esc(req.user.email)}<br>
${isAdmin ? 'Administrator — no interview limit.' : manager ? `Entity manager — no subscription needed and no monthly interview limit (${quota.used} invited this month). · <span lang="pt-PT">Gestor de entidade: sem subscrição necessária.</span>${active ? `<br>You still have the ${esc(sub.plan_name ?? '—')} plan ${pill(sub.status, 'ok')}: you do not need it${customerId ? ' and can cancel it below (Manage card, Stripe receipts &amp; cancellation)' : ''}.` : ''}` : active ? `Plan: <strong>${esc(sub.plan_name ?? '—')}</strong> ${pill(sub.status, 'ok')}<br>Interviews this period: <strong>${quota.used} / ${quota.limit}</strong>${sub.current_period_end ? `<br>Renews / ends: ${fmtDate(sub.current_period_end)}${sub.cancel_at_period_end ? ' (cancels at period end)' : ''}` : ''}` : `No active subscription ${sub ? pill(sub.status, 'bad') : ''}`}
${legacy ? '<br><span class="hint">This plan is no longer offered to new customers; it continues as it is until you change it.</span>' : ''}
${isAdmin ? '' : `<br>Credits: <strong>${crEn(wallet?.available_cents ?? 0)}</strong> available${wallet?.reserved_cents ? ` · ${crEn(wallet.reserved_cents)} on hold` : ''} · <a href="/conta/creditos">Top up and statement · Créditos</a>`}</div>
${freeBox}${isAdmin ? '' : `${withdrawCard}
${manager ? '' : `<h2>${active ? 'Change plan' : 'Choose a plan'}</h2>
<p class="hint">Plans include photos, narration, subtitles and the video with photos. AI animation is never included in a plan: each animated production is quoted before anything is generated and paid with prepaid credits. Card payments only, through Stripe. · <span lang="pt-PT">A animação por IA não está incluída em nenhum plano: é orçamentada antes de gerar e paga com créditos.</span></p>
${problem ? flash(problem, 'bad') : ''}
<div class="grid3">${plans.map(planCard).join('')}</div>`}
${stripeConfigured() ? '' : `<p class="hint">Online payments are not enabled yet. Please contact us at ${esc(contactEmail(s))} to activate your plan.</p>`}
${profileCard}
${customerId ? '<form method="post" action="/billing/portal"><button class="ghost">Manage card, Stripe receipts &amp; cancellation</button></form><p class="hint">Stripe receipts are proof of payment only. Your invoice (<span lang="pt-PT">fatura-recibo</span>) is issued separately by the seller and sent by email.</p>' : ''}
<p class="hint">Seller · <span lang="pt-PT">Vendedora</span>: ${sellerId(s)} · <a href="/termos">Terms of sale · Termos e condições</a> · <a href="/privacidade-pagamentos">Payments privacy · Privacidade nos pagamentos</a> · ${complaintsLink(s)}</p>`}
</div>`;
    return send(reply, page({ lang: 'en', title: 'Account', body, nav: nav(req.user), noindex: true }));
  };

  app.post('/billing/profile', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const user = req.user!, b = (req.body ?? {}) as any;
      const txt = (k: string, max: number) => String(b?.[k] ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
      const country = String(b.country ?? '');
      if (!isEuCountry(country)) return back(reply, both(withContact(OUTSIDE_EU)), '#billing');
      const kind = b.kind === 'business' || b.kind === 'consumer' ? b.kind : null;
      const name = txt('name', 120), address = txt('address', 200), city = txt('city', 80);
      if (!kind || !name || !address || !city) return back(reply, 'Please complete all billing fields. · Preencha todos os dados de faturação.', '#billing');
      const cp = normPostal(country, b.postal_code);
      if (!cp) return back(reply, country === 'PT' ? 'Invalid Portuguese postal code (NNNN-NNN). · Código postal inválido (NNNN-NNN).' : 'Invalid postal code. · Código postal inválido.', '#billing');
      const territory = outsideVatTerritory(country, cp);
      if (territory) return back(reply, `${territory} is outside the EU VAT area: please contact us at ${contactEmail()}. · ${territory} fica fora do território de IVA da UE: contacte-nos.`, '#billing');
      const rawTax = txt('tax_id', 30);
      let nif: string | null = null, vat: string | null = null;
      if (country === 'PT') {
        nif = rawTax ? normNif(rawTax) : null;
        if (rawTax && !nif) return back(reply, 'Invalid Portuguese NIF. · NIF inválido.', '#billing');
        if (kind === 'business' && !nif) return back(reply, 'Portuguese businesses must give their NIF. · As empresas têm de indicar o NIF.', '#billing');
      } else if (kind === 'business' && rawTax) {
        vat = normVatNumber(country, rawTax);
        if (!vat) return back(reply, `Invalid ${countryName(country, 'en')} VAT number. · Número de IVA inválido.`, '#billing');
      }
      // O estado da verificação no VIES só se mantém se o número de IVA não mudou.
      await db.query(
        `INSERT INTO billing_profiles(user_id, kind, name, country, address, postal_code, city, nif, vat_number, vat_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (user_id) DO UPDATE SET kind=$2, name=$3, country=$4, address=$5, postal_code=$6, city=$7, nif=$8, vat_number=$9,
           vat_status=CASE WHEN billing_profiles.vat_number IS NOT DISTINCT FROM $9 THEN billing_profiles.vat_status ELSE $10 END,
           vat_verified_name=CASE WHEN billing_profiles.vat_number IS NOT DISTINCT FROM $9 THEN billing_profiles.vat_verified_name ELSE NULL END,
           updated_at=now()`,
        [user.id, kind, name, country, address, cp, city, nif, vat, vat ? 'pending' : null]);
      const profile = await profileOf(user.id);
      let note = '';
      if (vatUnconfirmed(profile, seller()) && stripeConfigured()) {
        try { note = ` VAT number: ${VAT_STATUS[await verifyVatNumber(db, user, profile)] ?? 'checking'}.`; }
        catch (e: any) { req.log.warn({ err: e.message }, 'verificação do número de IVA falhou'); note = ' The VAT number could not be checked now; we will try again when you subscribe.'; }
      }
      await audit(db, user.email, 'billing.profile_saved', null, { kind, country, vat: !!vat });
      return okBack(reply, `Billing details saved.${note} · Dados de faturação guardados.`);
    });
  });

  app.post('/subscribe/:plan', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const user = req.user!, b = (req.body ?? {}) as any;
      const plan = await db.one('SELECT * FROM plans WHERE id=$1 AND active', [(req.params as any).plan]);
      if (!plan) return reply.code(404).send('Plan not found');
      if (noSubscriptionNeeded(user.role)) return back(reply, user.role === 'admin' ? 'Administrators have no interview limit and do not subscribe.' : 'Entity managers invite without a subscription and have no monthly interview limit. · O gestor de entidade não precisa de subscrição.');
      let profile = await profileOf(user.id);
      if (!profile) return back(reply, 'Fill in your billing details first. · Preencha primeiro os dados de faturação.', '#billing');
      const s = seller(), consumer = profile.kind === 'consumer';
      const block = checkoutBlock(s, consumer);
      if (block) return back(reply, both(block));
      if (b.terms !== '1') return back(reply, 'Please accept the terms of sale. · Aceite os termos e condições.');
      if (consumer && (b.start_now !== '1' || b.waiver !== '1')) return back(reply, 'Para começar já, confirme o pedido de início imediato do serviço e o reconhecimento sobre a livre resolução.');
      // Empresa de outro país da UE: a autoliquidação só com o número de IVA confirmado no VIES (consulta-se de novo).
      if (vatUnconfirmed(profile, s) && stripeConfigured()) {
        try { await verifyVatNumber(db, user, profile); } catch (e: any) { req.log.warn({ err: e.message }, 'verificação do número de IVA falhou'); }
        profile = await profileOf(user.id);
      }
      if (vatUnconfirmed(profile, s)) return back(reply, profile.vat_status === 'unverified'
        ? 'VIES did not confirm your VAT number: correct it, or remove it to pay with VAT. · O VIES não confirmou o número de IVA.'
        : 'We are still checking your VAT number in VIES: try again in a few minutes, or remove it to pay with VAT. · A verificação do número de IVA no VIES ainda não terminou.', '#billing');
      const d = vatForProfile(profile, s);
      if (!d.ok) return back(reply, both(d.reason === 'outside_eu' ? withContact(d.message, s) : d.message));
      await db.query('UPDATE billing_profiles SET last_checkout_ip=$2, last_checkout_at=now() WHERE user_id=$1', [user.id, req.ip]);
      const consents = { terms: TERMS_VERSION, startNow: consumer, waiver: consumer, ip: req.ip, kind: profile.kind, regime: d.regime, rate: d.rate, country: d.country };
      const sub = await db.one('SELECT * FROM subscriptions WHERE user_id=$1', [user.id]);
      try {
        // Já tem subscrição paga: muda essa (nunca abre uma segunda).
        if (liveStripe(sub)) {
          if (sub.plan_id === plan.id) return back(reply, 'You are already on this plan.');
          const r = await changePlan(db, user, sub, plan, profile, d, s);
          if (r === 'past_due') return back(reply, 'Your last payment failed: update your card in “Manage card” before changing plan.');
          if (r === 'switched') {
            await audit(db, user.email, 'billing.plan_switched', null, { from: sub.plan_id, to: plan.id, ...consents });
            return okBack(reply, `Plan changed to ${plan.name}. The prorated difference was charged now; your invoice follows by email.`);
          }
          // 'gone': a subscrição já não existe na Stripe; segue para uma nova.
        }
        const url = await createCheckout(db, user, plan, profile, d, s);
        await audit(db, user.email, 'billing.checkout_started', null, { plan: plan.id, ...consents });
        return reply.redirect(url, 303);
      } catch (e: any) { return back(reply, String(e.message).slice(0, 200)); }
    });
  });

  app.post('/billing/portal', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    const customer = await inEntity(req.user.entity_id, () => customerFor(db, req.user!.id));
    if (!customer) return reply.redirect('/account');
    try { return reply.redirect(await inEntity(req.user.entity_id, () => createPortal(customer)), 303); }
    catch (e: any) { return back(reply, String(e.message).slice(0, 160)); }
  });

  // ---- Livre resolução (consumidores, 14 dias): botão na conta → confirmação → pedido registado ----
  app.get('/billing/livre-resolucao', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    const sub = (await quotaFor(db, req.user)).sub, profile = await profileOf(req.user.id);
    if (!withdrawable(profile, sub)) return reply.redirect('/account');
    const body = `<div class="narrow" style="padding-top:36px"><h1>Desistir do contrato</h1>
<div class="card sans"><p>Contrato: subscrição <strong>${esc(sub.plan_name ?? sub.plan_id ?? '')}</strong> de ${esc(config.brand)}, iniciada em ${fmtDate(sub.contract_started_at)}.<br>Cliente: ${esc(profile.name)} · ${esc(req.user.email)}</p>
<p>Ao confirmar, a subscrição é cancelada de imediato. Devolvemos o valor pago, descontada a parte do serviço já prestada, no prazo de 14 dias e pelo mesmo meio de pagamento. Enviamos a confirmação deste pedido para ${esc(req.user.email)}.</p>
<form method="post" action="/billing/livre-resolucao"><button class="danger">Confirmar a desistência</button> <a href="/account">Voltar</a></form></div></div>`;
    return send(reply, page({ title: 'Desistir do contrato', body, nav: nav(req.user), noindex: true }));
  });

  app.post('/billing/livre-resolucao', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const user = req.user!;
      const sub = (await quotaFor(db, user)).sub, profile = await profileOf(user.id);
      if (!withdrawable(profile, sub)) return reply.redirect('/account');
      const w = await db.one(`INSERT INTO withdrawals(user_id, kind, stripe_ref, plan_id, contract_started_at, ip) VALUES ($1,'subscription',$2,$3,$4,$5) ON CONFLICT (user_id, stripe_ref) DO NOTHING RETURNING *`,
        [user.id, sub.stripe_subscription_id, sub.plan_id, sub.contract_started_at, req.ip]);
      if (!w) return reply.redirect('/account');
      // Cancela já na Stripe; se falhar, o pedido fica registado e o administrador cancela no painel.
      let cancelled = false;
      try { await cancelNow(sub.stripe_subscription_id); cancelled = true; } catch (e: any) { req.log.warn({ err: e.message }, 'livre resolução: cancelamento na Stripe falhou'); }
      if (cancelled) {
        await db.query(`UPDATE withdrawals SET stripe_cancelled=true WHERE id=$1`, [w.id]);
        await db.query(`UPDATE subscriptions SET status='canceled', updated_at=now() WHERE user_id=$1 AND stripe_subscription_id=$2`, [user.id, sub.stripe_subscription_id]);
      }
      // Aviso de receção em suporte duradouro (DL 24/2014, art. 11.º, n.º 4).
      const s = seller();
      const text = `Recebemos em ${fmtDate(w.requested_at)} o seu pedido de livre resolução do contrato de subscrição ${sub.plan_name ?? sub.plan_id} de ${config.brand}. ${cancelled ? 'A subscrição foi cancelada.' : 'A subscrição vai ser cancelada.'} Devolvemos o valor pago, descontada a parte do serviço já prestada, no prazo de 14 dias e pelo mesmo meio de pagamento.${s.name ? ` ${s.name}${s.nif ? `, NIF ${s.nif}` : ''}.` : ''}`;
      await queueEmail(db, { key: `withdrawal:${w.id}`, to: user.email, subject: 'Recebemos o seu pedido de livre resolução', html: emailShell('Pedido de livre resolução recebido', `<p>${esc(text)}</p>`), text });
      await audit(db, user.email, 'billing.withdrawal_requested', null, { withdrawal: w.id, cancelled });
      return okBack(reply, 'Pedido de desistência registado. Enviámos a confirmação por email.');
    });
  });

  // ---- Termos e privacidade dos pagamentos (em português); o vendedor é o dono da conta Stripe de quem está a ver ----
  app.get('/termos', async (req, reply) => {
    const plans = await db.query('SELECT * FROM plans WHERE active ORDER BY sort');
    // Só a tarifa que os orçamentos usam hoje (o nível do Veo das Definições globais), ativa e dentro da validade.
    const rate = await premiumRate(db);
    const rates = rate ? [rate] : [];
    return send(reply, page({ title: 'Termos e condições de venda', body: termsBody(plans, inEntity(req.user?.entity_id, seller), rates) }));
  });
  app.get('/privacidade-pagamentos', async (req, reply) => send(reply, page({ title: 'Privacidade nos pagamentos', body: paymentsPrivacyBody(inEntity(req.user?.entity_id, seller)) })));

  // Webhook: o corpo tem de chegar em bruto para verificar a assinatura.
  // /webhooks/stripe (chaves globais) e /webhooks/stripe/:slug (chaves da entidade).
  const webhook = async (req: any, reply: any, entityId: string | null) => inEntity(entityId, async () => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyStripeSignature(raw, req.headers['stripe-signature'] as string, S('STRIPE_WEBHOOK_SECRET'))) return reply.code(400).send({ error: 'invalid signature' });
    let ev: any;
    try { ev = JSON.parse(raw.toString('utf8')); } catch { return reply.code(400).send({ error: 'bad json' }); }
    if (typeof ev?.id !== 'string' || typeof ev?.type !== 'string') return reply.code(400).send({ error: 'bad event' });
    const r = await applyStripeEvent(db, ev, entityId);
    return { received: true, result: r };
  });
  app.post('/webhooks/stripe', (req, reply) => webhook(req, reply, null));
  app.post('/webhooks/stripe/:slug', async (req, reply) => {
    const e = await db.one('SELECT id FROM entities WHERE slug=$1', [(req.params as any).slug]);
    if (!e) return reply.code(404).send({ error: 'unknown entity' });
    return webhook(req, reply, e.id);
  });
}
