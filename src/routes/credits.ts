import type { FastifyInstance } from 'fastify';
import { config } from '../config.ts';
import { esc, fmtDate } from '../lib.ts';
import { page, flash, pill } from '../views.ts';
import { audit } from '../app.ts';
import { stripeConfigured, verifyVatNumber, vatForProfile, startTopup, confirmTopupSession } from '../billing.ts';
import { inEntity } from '../settings.ts';
import { seller, sellerId, checkoutBlock, contactEmail, complaintsLink, homeConsumerRate, withdrawalFormHtml, TERMS_VERSION, WITHDRAWAL_DAYS, type Seller } from '../legal.ts';
import { queueEmail, emailShell } from '../mail.ts';
import { withVat, vatOf, eurEn, eurPt, fmtRate, type VatDecision } from '../vat.ts';
import { findWallet, spendBlock, packFor, cr, crEn, ENTRY_LABEL, TOPUP_PACKS, TOPUP_MIN_CENTS, TOPUP_MAX_CENTS, CREDIT_VALID_MONTHS, REFUND_WINDOW_DAYS, EXTRA_INTERVIEW_CENTS, EXTRA_REGEN_CENTS } from '../wallet.ts';
import { helpNav } from '../support.ts';

/** Mensagem nas duas línguas (a área de faturação é em inglês; o português é obrigatório para os consumidores). */
const both = (m: { pt: string; en: string }) => `${m.en} · ${m.pt}`;
/** Regresso depois de pagar: só para páginas da própria entrevista (convite, produção e orçamento da animação). */
export const safeReturn = (v: unknown) => (typeof v === 'string' && /^\/entrevistas\/[0-9a-f-]{36}(\/producao|\/convidar|\/orcamentos\/[0-9a-f-]{36})?$/i.test(v) ? v : null);
/** Valor em euros inteiros (25 a 1000), como vem do formulário («25», «25,00»); null se não servir. */
export function parseTopupEuros(v: unknown): number | null {
  const m = /^\s*(\d{1,4})(?:[.,]0{1,2})?\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  const cents = Number(m[1]) * 100;
  return cents >= TOPUP_MIN_CENTS && cents <= TOPUP_MAX_CENTS ? cents : null;
}
/**
 * Consumidor que paga um serviço com créditos (entrevista extra, regeneração extra, animação): pedido de início imediato e
 * reconhecimento da perda da livre resolução (DL 24/2014, art. 15.º e art. 17.º, n.º 1, als. a) e l)), em caixas por assinalar.
 */
export const paidConsentHtml = (consumer: boolean) => (consumer ? `<label class="check" lang="pt-PT"><input type="checkbox" name="start_now" value="1" required> <span>Peço que o serviço comece já.</span></label>
<label class="check" lang="pt-PT"><input type="checkbox" name="waiver" value="1" required> <span>Reconheço que perco o direito de livre resolução quando o serviço estiver integralmente prestado e o resultado me for disponibilizado.</span></label>` : '');
export const paidConsentOk = (b: any, consumer: boolean) => !consumer || (b?.start_now === '1' && b?.waiver === '1');
/** O cliente compra como consumidor (dados de faturação)? */
export const isConsumer = async (db: { one: (sql: string, p?: any[]) => Promise<any> }, userId: string) => (await db.one('SELECT kind FROM billing_profiles WHERE user_id=$1', [userId]))?.kind === 'consumer';
const STATUS: Record<string, [string, '' | 'ok' | 'bad' | 'warn']> = {
  pending: ['awaiting payment', 'warn'], paid: ['paid', 'ok'], failed: ['not paid', 'bad'], expired: ['checkout expired', ''], refunded: ['refunded', ''],
  partially_refunded: ['partly refunded', ''], disputed: ['disputed', 'bad'],
};

export async function creditRoutes(app: FastifyInstance) {
  const db = app.db;
  const send = (reply: any, html: string) => reply.type('text/html; charset=utf-8').send(html);
  const nav = (u: any) => `<a href="/painel">Dashboard</a><a href="/account">Account</a><a href="/conta/creditos">Credits</a>${helpNav(u, 'en')}<form method="post" action="/sair" style="display:inline"><button class="ghost" style="padding:6px 12px;min-height:0;margin-left:16px">Sign out</button></form>`;
  const profileOf = (userId: string) => db.one('SELECT * FROM billing_profiles WHERE user_id=$1', [userId]);
  const back = (reply: any, e: string, extra = '') => reply.redirect('/conta/creditos?e=' + encodeURIComponent(e.slice(0, 500)) + extra);

  /** Preço de um carregamento para este cliente: consumidores com IVA primeiro (também em português); empresas «+ IVA». */
  const priceOf = (net: number, d: VatDecision | null, consumer: boolean, home: number | null = null) => {
    if (!d) return `${eurEn(net)} + VAT${home ? ` (${eurEn(withVat(net, home))} incl. ${fmtRate(home)}% VAT · <span lang="pt-PT">consumidores: ${eurPt(withVat(net, home))} com IVA</span>)` : ''}`;
    if (!d.ok) return `${eurEn(net)} + VAT`;
    const gross = withVat(net, d.rate);
    if (consumer) return `${eurEn(gross)} incl. VAT · <span lang="pt-PT">${eurPt(gross)} com IVA (${eurPt(net)} + IVA ${fmtRate(d.rate)}%)</span>`;
    if (d.regime === 'reverse_charge') return `${eurEn(net)} (no VAT: reverse charge)`;
    return `${eurEn(net)} + VAT (${eurEn(gross)} with ${fmtRate(d.rate)}% VAT)`;
  };
  const RULES = `<p class="hint">1 credit = €1 excluding VAT. Credits pay for AI animation (quoted before anything is generated), extra interviews beyond your plan (${crEn(EXTRA_INTERVIEW_CENTS)} credits each) and extra regenerations of the script or episode (${crEn(EXTRA_REGEN_CENTS)} credit each). VAT is charged and invoiced when you top up, never again when you use the credits. Each top-up is valid for ${CREDIT_VALID_MONTHS} months (we email you 30 days before) and the oldest credits are used first. The unused balance of a top-up can be refunded within ${REFUND_WINDOW_DAYS} days of that top-up, and always if the service closes. Credits are personal and cannot be transferred. Card payments only, through Stripe.</p>
<p class="hint" lang="pt-PT">1 crédito = 1 € sem IVA. Os créditos pagam a animação por IA (orçamentada antes de gerar), entrevistas para além do plano (${cr(EXTRA_INTERVIEW_CENTS)} créditos cada) e regenerações extra do guião ou do episódio (${cr(EXTRA_REGEN_CENTS)} crédito cada). O IVA é cobrado e faturado no carregamento, nunca no consumo. Cada carregamento vale ${CREDIT_VALID_MONTHS} meses (avisamos por email 30 dias antes) e os créditos mais antigos gastam-se primeiro. O saldo não usado de um carregamento é reembolsável nos ${REFUND_WINDOW_DAYS} dias seguintes a esse carregamento e sempre que o serviço encerre. Os créditos são nominativos e intransmissíveis.</p>`;

  app.get('/conta/creditos', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const user = req.user!, q = req.query as any;
      const isAdmin = user.role === 'admin';
      // Regresso do Checkout: aplica já o pagamento (o webhook pode chegar depois; o efeito é o mesmo e só uma vez).
      let paidMsg = '', returnTo: string | null = null;
      if (typeof q.sessao === 'string' && /^cs_[A-Za-z0-9_]{1,200}$/.test(q.sessao)) {
        let r = 'pending';
        try { r = await confirmTopupSession(db, user.id, q.sessao); } catch (e: any) { req.log.warn({ err: e.message }, 'confirmação do carregamento falhou'); }
        paidMsg = r === 'credited' || r === 'already' ? 'Payment received: your credits are available. · Pagamento recebido: os créditos já estão disponíveis.'
          : r === 'mismatch' ? 'We received a payment that does not match this top-up; we will contact you. · Recebemos um pagamento que não confere com o carregamento; vamos contactá-lo.'
          : r === 'unknown' ? '' : 'Payment is being confirmed: your credits will appear in a few seconds. Refresh this page. · O pagamento está a ser confirmado.';
        returnTo = safeReturn((await db.one('SELECT return_path FROM credit_topups WHERE user_id=$1 AND stripe_session_id=$2', [user.id, q.sessao]))?.return_path);
      }
      const w = await findWallet(db, user.id, user.entity_id);
      const lots = w ? await db.query(`SELECT * FROM credit_topups WHERE wallet_id=$1 AND NOT (status='failed' AND stripe_session_id IS NULL) ORDER BY created_at DESC LIMIT 50`, [w.id]) : [];
      const entries = w ? await db.query(`SELECT * FROM wallet_entries WHERE wallet_id=$1 ORDER BY created_at DESC, id DESC LIMIT 100`, [w.id]) : [];
      const profile = await profileOf(user.id);
      const consumer = profile?.kind === 'consumer';
      const s = seller();
      const d: VatDecision | null = profile ? vatForProfile(profile, s) : null;
      const blocked = spendBlock(w);
      const avail = w?.available_cents ?? 0, held = w?.reserved_cents ?? 0, debt = w?.debt_cents ?? 0;
      const lotRow = (l: any) => {
        const [label, kind] = STATUS[l.status] ?? [l.status, ''];
        const refundUntil = l.paid_at ? new Date(new Date(l.paid_at).getTime() + REFUND_WINDOW_DAYS * 86400_000) : null;
        return `<tr><td>${fmtDate(l.created_at)}</td><td><strong>${crEn(l.net_cents)}</strong></td><td>${eurEn(l.gross_cents)}${l.vat_cents ? ` <span class="hint">(VAT ${fmtRate(Number(l.vat_rate))}%)</span>` : ''}</td>
<td>${l.paid_at ? crEn(l.remaining_cents) : '—'}</td><td>${l.expires_at ? new Date(l.expires_at).toISOString().slice(0, 10) : '—'}</td><td>${pill(label, kind)}${refundUntil && l.remaining_cents > 0 && Date.now() < refundUntil.getTime() && ['paid', 'partially_refunded'].includes(l.status) ? `<br><span class="hint">refundable until ${refundUntil.toISOString().slice(0, 10)}</span>` : ''}</td>
<td>${l.moloni_doc ? esc(l.moloni_doc) : l.paid_at ? '<span class="hint">to be issued</span>' : '—'}</td></tr>
${consumer && asked.has(`topup:${l.id}`) ? `<tr><td colspan="7" class="hint" lang="pt-PT">Pedido de livre resolução deste carregamento recebido: devolvemos o saldo ainda disponível no prazo de ${WITHDRAWAL_DAYS} dias.</td></tr>`
  : consumer && topupWithdrawable(l) ? `<tr><td colspan="7"><a class="btn ghost" href="/conta/creditos/${l.id}/livre-resolucao" lang="pt-PT">Desistir do contrato aqui</a> <span class="hint" lang="pt-PT">(livre resolução deste carregamento até ${fmtDate(new Date(new Date(l.paid_at).getTime() + WITHDRAWAL_DAYS * 86400_000))})</span></td></tr>` : ''}`;
      };
      const entryRow = (e: any) => {
        const lb = ENTRY_LABEL[e.kind] ?? { en: e.kind, pt: e.kind };
        const parts = [e.available_delta ? `${e.available_delta > 0 ? '+' : '−'}${crEn(Math.abs(e.available_delta))} available` : '', e.reserved_delta ? `${e.reserved_delta > 0 ? '+' : '−'}${crEn(Math.abs(e.reserved_delta))} on hold` : '', e.debt_delta ? `${e.debt_delta > 0 ? '+' : '−'}${crEn(Math.abs(e.debt_delta))} owed` : ''].filter(Boolean);
        return `<tr><td>${fmtDate(e.created_at)}</td><td>${esc(lb.en)} <span class="hint" lang="pt-PT">· ${esc(lb.pt)}</span>${e.note ? `<br><span class="hint">${esc(e.note)}</span>` : ''}</td><td>${parts.join('<br>') || '0'}</td></tr>`;
      };
      const home = homeConsumerRate(s);
      const radios = TOPUP_PACKS.map((p, i) => `<label class="check"><input type="radio" name="valor" value="${p / 100}" ${i === 0 ? 'checked' : ''}> <span><strong>${crEn(p)} credits</strong> — ${priceOf(p, d, consumer, home)}</span></label>`).join('');
      // Livre resolução de um carregamento (consumidores, nos 14 dias seguintes ao pagamento): botão por carregamento.
      const asked = new Set((await db.query(`SELECT stripe_ref FROM withdrawals WHERE user_id=$1 AND kind='topup'`, [user.id])).map((r: any) => String(r.stripe_ref)));
      const body = `<div class="narrow" style="padding-top:36px"><h1>Credits <span class="hint" lang="pt-PT">· Créditos</span></h1>
${flash(paidMsg)}${returnTo ? `<p><a class="btn ghost" href="${esc(returnTo)}">Back to your interview · Voltar à entrevista</a></p>` : ''}${q.carregamento === 'cancelado' ? flash('Top-up cancelled — nothing was charged. · Carregamento cancelado: nada foi cobrado.', 'bad') : ''}${flash(q.ok)}${flash(q.e, 'bad')}
<div class="card sans" id="saldo"><p style="font-size:1.6rem;margin:.2em 0"><strong id="available">${crEn(avail)}</strong> credits available <span class="hint" lang="pt-PT">· créditos disponíveis</span></p>
${held ? `<p>On hold for accepted quotes: <strong>${crEn(held)}</strong> <span class="hint" lang="pt-PT">· cativos</span></p>` : ''}${debt ? `<p style="color:var(--bad)">Owed: <strong>${crEn(debt)}</strong> <span class="hint" lang="pt-PT">· em dívida</span></p>` : ''}
${blocked ? flash(both(blocked), 'bad') : ''}${isAdmin ? '<p class="hint">Administrators do not need credits: animation and regenerations are not charged to them. · O administrador não precisa de créditos.</p>' : ''}</div>
${isAdmin ? '' : `<div class="card sans"><h2 style="margin-top:0">Top up <span class="hint" lang="pt-PT">· Carregar</span></h2>
${!profile ? '<p class="hint">Fill in your billing details first, in <a href="/account#billing">Account</a>. · Preencha primeiro os dados de faturação.</p>' : ''}
<form method="get" action="/conta/creditos/carregar">${radios}
<label class="check"><input type="radio" name="valor" value="outro"> <span>Other amount · <span lang="pt-PT">Outro valor</span></span></label>
<label for="c_custom">Credits (${TOPUP_MIN_CENTS / 100} to ${TOPUP_MAX_CENTS / 100}) · <span lang="pt-PT">Créditos (${TOPUP_MIN_CENTS / 100} a ${TOPUP_MAX_CENTS / 100})</span></label><input id="c_custom" name="outro" type="text" inputmode="numeric" maxlength="4" placeholder="${TOPUP_MIN_CENTS / 100}" style="max-width:160px">
<p><button class="accent" ${profile ? '' : 'disabled'}>Continue · Continuar</button></p></form>${RULES}</div>`}
${lots.length ? `<div class="card sans" style="overflow-x:auto"><h2 style="margin-top:0">Top-ups <span class="hint" lang="pt-PT">· Carregamentos</span></h2><table><thead><tr><th>Date</th><th>Credits</th><th>Paid</th><th>Left</th><th>Valid until</th><th>Status</th><th>Invoice</th></tr></thead><tbody>${lots.map(lotRow).join('')}</tbody></table>
<p class="hint">Refunds of an unused balance within ${REFUND_WINDOW_DAYS} days: ask through Help or email ${esc(contactEmail(s))}${consumer ? '; as a consumer you can also use «Desistir do contrato aqui» on each top-up' : ''}. · <span lang="pt-PT">Reembolsos nos ${REFUND_WINDOW_DAYS} dias: pela Ajuda ou por email${consumer ? '; como consumidor, também pelo botão «Desistir do contrato aqui» de cada carregamento' : ''}.</span></p></div>` : ''}
<div class="card sans" style="overflow-x:auto"><h2 style="margin-top:0">Statement <span class="hint" lang="pt-PT">· Extrato de créditos</span></h2><p class="hint">This statement is not an invoice or a receipt: the invoice is issued for each top-up. · Este extrato não é fatura nem recibo.</p>
${entries.length ? `<table><thead><tr><th>Date</th><th>Movement</th><th>Credits</th></tr></thead><tbody>${entries.map(entryRow).join('')}</tbody></table>` : '<p class="hint">No movements yet. · Sem movimentos.</p>'}</div>
<p class="hint">Seller · <span lang="pt-PT">Vendedora</span>: ${sellerId(s)} · <a href="/termos">Terms of sale · Termos e condições</a> · ${complaintsLink(s)}</p></div>`;
      return send(reply, page({ lang: 'en', title: 'Credits', body, nav: nav(req.user), noindex: true }));
    });
  });

  /** Valor pedido: um pacote, outro valor ou «carregar o que falta» (o pacote seguinte). */
  const requested = (q: any): { cents: number | null; missing: number | null } => {
    if (q.falta !== undefined) {
      const missing = Math.max(0, Math.round(Number(q.falta)));
      return { cents: Number.isFinite(missing) && missing > 0 ? packFor(missing) : null, missing: Number.isFinite(missing) ? missing : null };
    }
    // O valor escrito em «Outro valor» conta mesmo que o botão marcado seja um pacote (a página não tem JavaScript para o
    // marcar sozinho); o resumo antes de pagar mostra sempre o valor escolhido.
    const typed = typeof q.outro === 'string' && q.outro.trim() !== '';
    return { cents: parseTopupEuros(q.valor === 'outro' || typed ? q.outro : q.valor), missing: null };
  };

  /** Carregamento pago de um consumidor, ainda nos 14 dias da livre resolução. */
  const topupWithdrawable = (l: any) => !!l?.paid_at && ['paid', 'partially_refunded'].includes(l.status) && Date.now() - new Date(l.paid_at).getTime() <= WITHDRAWAL_DAYS * 86400_000;
  const myTopup = async (req: any) => {
    const id = String((req.params as any).id ?? '');
    return /^[0-9a-f-]{36}$/i.test(id) ? db.one('SELECT * FROM credit_topups WHERE id=$1 AND user_id=$2', [id, req.user.id]) : undefined;
  };

  // ---- Livre resolução de um carregamento (consumidores, 14 dias): botão → confirmação → pedido registado ----
  app.get('/conta/creditos/:id/livre-resolucao', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const tp = await myTopup(req), profile = await profileOf(req.user!.id);
      if (!tp || profile?.kind !== 'consumer' || !topupWithdrawable(tp)) return reply.redirect('/conta/creditos');
      const s = seller();
      const body = `<div class="narrow" style="padding-top:36px" lang="pt-PT"><h1>Desistir do contrato</h1>
<div class="card sans"><p>Contrato: carregamento de <strong>${cr(tp.net_cents)} créditos</strong> de ${esc(config.brand)}, pago em ${fmtDate(tp.paid_at)} (${eurPt(tp.gross_cents)}).<br>Cliente: ${esc(profile.name)} · ${esc(req.user!.email)}</p>
<p>Ao confirmar, regista o pedido de livre resolução deste carregamento. Devolvemos o saldo ainda disponível deste carregamento (hoje ${cr(tp.remaining_cents)} créditos) no prazo de ${WITHDRAWAL_DAYS} dias, pelo mesmo meio de pagamento; os créditos já usados num serviço que pediu para começar já não se devolvem. Enviamos a confirmação deste pedido para ${esc(req.user!.email)}.</p>
<form method="post" action="/conta/creditos/${tp.id}/livre-resolucao"><button class="danger">Confirmar a desistência</button> <a href="/conta/creditos">Voltar</a></form></div>
<p class="hint">Também pode enviar o modelo de formulário por email para ${esc(contactEmail(s))}.</p>${withdrawalFormHtml({ ...s, email: contactEmail(s) })}</div>`;
      return send(reply, page({ lang: 'pt-PT', title: 'Desistir do contrato', body, nav: nav(req.user), noindex: true }));
    });
  });

  app.post('/conta/creditos/:id/livre-resolucao', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const user = req.user!;
      const tp = await myTopup(req), profile = await profileOf(user.id);
      if (!tp || profile?.kind !== 'consumer' || !topupWithdrawable(tp)) return reply.redirect('/conta/creditos');
      const w = await db.one(`INSERT INTO withdrawals(user_id, kind, stripe_ref, contract_started_at, ip) VALUES ($1,'topup',$2,$3,$4) ON CONFLICT (user_id, stripe_ref) DO NOTHING RETURNING *`,
        [user.id, `topup:${tp.id}`, tp.paid_at, req.ip]);
      if (!w) return reply.redirect('/conta/creditos');
      // O administrador vê o pedido no carregamento (Créditos, com o botão do reembolso) e na lista da livre resolução (Faturação).
      await db.query('UPDATE credit_topups SET alert=$2, updated_at=now() WHERE id=$1', [tp.id, `Pedido de livre resolução do consumidor em ${fmtDate(w.requested_at)}: reembolsar o saldo disponível deste carregamento (${cr(tp.remaining_cents)} créditos nesse momento) no prazo de ${WITHDRAWAL_DAYS} dias.`]);
      // Aviso de receção em suporte duradouro (DL 24/2014, art. 11.º, n.º 4).
      const s = seller();
      const text = `Recebemos em ${fmtDate(w.requested_at)} o seu pedido de livre resolução do carregamento de ${cr(tp.net_cents)} créditos de ${config.brand}, pago em ${fmtDate(tp.paid_at)}. Devolvemos o saldo ainda disponível deste carregamento no prazo de ${WITHDRAWAL_DAYS} dias, pelo mesmo meio de pagamento.${s.name ? ` ${s.name}${s.nif ? `, NIF ${s.nif}` : ''}.` : ''}`;
      await queueEmail(db, { key: `withdrawal:${w.id}`, to: user.email, subject: 'Recebemos o seu pedido de livre resolução', html: emailShell('Pedido de livre resolução recebido', `<p>${esc(text)}</p>`), text });
      await audit(db, user.email, 'credits.withdrawal_requested', null, { withdrawal: w.id, topup: tp.id, remaining: tp.remaining_cents, ip: req.ip });
      return reply.redirect('/conta/creditos?ok=' + encodeURIComponent('Pedido de desistência registado: devolvemos o saldo disponível deste carregamento. Enviámos a confirmação por email.'));
    });
  });

  // Resumo antes de pagar (informação pré-contratual imediatamente antes da encomenda) e botão com a obrigação de pagar.
  app.get('/conta/creditos/carregar', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const user = req.user!, q = req.query as any;
      if (user.role === 'admin') return back(reply, 'Administrators do not need credits. · O administrador não precisa de créditos.');
      const { cents, missing } = requested(q);
      if (!cents) return back(reply, `Choose between ${TOPUP_MIN_CENTS / 100} and ${TOPUP_MAX_CENTS / 100} credits (whole numbers). · Escolha entre ${TOPUP_MIN_CENTS / 100} e ${TOPUP_MAX_CENTS / 100} créditos.`);
      const profile = await profileOf(user.id);
      if (!profile) return reply.redirect('/account?e=' + encodeURIComponent('Fill in your billing details first. · Preencha primeiro os dados de faturação.') + '#billing');
      const s = seller(), consumer = profile.kind === 'consumer';
      const d = vatForProfile(profile, s);
      const block = checkoutBlock(s, consumer) ?? (!d.ok ? d.message : null);
      const vat = d.ok ? vatOf(cents, d.rate) : 0, gross = cents + vat;
      const voltar = safeReturn(q.voltar);
      const button = !d.ok ? 'Pay' : consumer ? `Pagar ${eurPt(gross)} (${cr(cents)} créditos) · Pay ${eurEn(gross)}` : d.regime === 'reverse_charge' ? `Pay ${eurEn(cents)} (${crEn(cents)} credits)` : `Pay ${eurEn(cents)} + VAT (${eurEn(gross)})`;
      const until = new Date(Date.now() + CREDIT_VALID_MONTHS * 30.44 * 86400_000);
      const body = `<div class="narrow" style="padding-top:36px"><h1>Top up ${crEn(cents)} credits <span class="hint" lang="pt-PT">· Carregar ${cr(cents)} créditos</span></h1>
${missing ? flash(`You need ${crEn(missing)} more credits; the next top-up option is ${crEn(cents)}. · Faltam ${cr(missing)} créditos; o carregamento seguinte é de ${cr(cents)}.`) : ''}${block ? flash(both(block), 'bad') : ''}${stripeConfigured() ? '' : flash(`Online payments are not enabled yet. Please contact us at ${contactEmail(s)}.`, 'bad')}
<div class="card sans"><table><tbody>
<tr><th>Credits · Créditos</th><td><strong>${crEn(cents)}</strong> (1 credit = €1 excl. VAT)</td></tr>
<tr><th>Price · Preço</th><td>${consumer && d.ok ? `<strong>${eurEn(gross)} incl. VAT</strong> · <span lang="pt-PT"><strong>${eurPt(gross)} com IVA</strong> (${eurPt(cents)} + IVA ${fmtRate(d.rate)}% ${eurPt(vat)})</span>` : d.ok ? `${eurEn(cents)} + VAT ${fmtRate(d.rate)}% ${eurEn(vat)} = <strong>${eurEn(gross)}</strong>` : `${eurEn(cents)} + VAT`}${d.ok ? `<br><span class="hint">${esc(d.note.en)} · <span lang="pt-PT">${esc(d.note.pt)}</span></span>` : ''}</td></tr>
<tr><th>Valid until · Validade</th><td>${CREDIT_VALID_MONTHS} months from payment (about ${until.toISOString().slice(0, 10)}) · ${CREDIT_VALID_MONTHS} meses a contar do pagamento</td></tr>
<tr><th>Refund · Reembolso</th><td>Unused balance of this top-up refundable within ${REFUND_WINDOW_DAYS} days, to the same card · <span lang="pt-PT">saldo não usado reembolsável nos ${REFUND_WINDOW_DAYS} dias seguintes, para o mesmo cartão</span></td></tr>
<tr><th>Invoice · Fatura</th><td>Invoice-receipt (<span lang="pt-PT">fatura-recibo</span>) issued by the seller for the top-up and sent by email; no invoice when you use the credits.</td></tr>
<tr><th>Seller · Vendedor</th><td>${sellerId(s)} · ${complaintsLink(s)}</td></tr></tbody></table>
<form method="post" action="/conta/creditos/carregar"><input type="hidden" name="valor" value="${cents / 100}">${voltar ? `<input type="hidden" name="voltar" value="${esc(voltar)}">` : ''}
<label class="check"><input type="checkbox" name="terms" value="1" required> <span>I accept the <a href="/termos">terms of sale</a> (<span lang="pt-PT">termos e condições, incluindo as regras dos créditos</span>) and the <a href="/privacidade-pagamentos">payments privacy notice</a>.</span></label>
<button class="accent" ${block || !stripeConfigured() ? 'disabled' : ''}>${esc(button)}</button> <a href="/conta/creditos">Cancel · Cancelar</a></form></div>${RULES}</div>`;
      return send(reply, page({ lang: 'en', title: 'Top up credits', body, nav: nav(req.user), noindex: true }));
    });
  });

  app.post('/conta/creditos/carregar', async (req, reply) => {
    if (!req.user) return reply.redirect('/entrar');
    return inEntity(req.user.entity_id, async () => {
      const user = req.user!, b = (req.body ?? {}) as any;
      if (user.role === 'admin') return back(reply, 'Administrators do not need credits. · O administrador não precisa de créditos.');
      const cents = parseTopupEuros(b.valor);
      if (!cents) return back(reply, `Choose between ${TOPUP_MIN_CENTS / 100} and ${TOPUP_MAX_CENTS / 100} credits (whole numbers). · Escolha entre ${TOPUP_MIN_CENTS / 100} e ${TOPUP_MAX_CENTS / 100} créditos.`);
      let profile = await profileOf(user.id);
      if (!profile) return reply.redirect('/account?e=' + encodeURIComponent('Fill in your billing details first. · Preencha primeiro os dados de faturação.') + '#billing');
      const s: Seller = seller(), consumer = profile.kind === 'consumer';
      const block = checkoutBlock(s, consumer);
      if (block) return back(reply, both(block));
      if (b.terms !== '1') return back(reply, 'Please accept the terms of sale. · Aceite os termos e condições.');
      if (!stripeConfigured()) return back(reply, `Online payments are not enabled yet. Please contact us at ${contactEmail(s)}.`);
      // Empresa de outro país da UE: a autoliquidação só com o número de IVA confirmado no VIES (consulta-se de novo).
      const unconfirmed = (p: any) => p?.kind === 'business' && !!p.vat_number && p.country !== s.country && p.vat_status !== 'verified';
      if (unconfirmed(profile)) {
        try { await verifyVatNumber(db, user, profile); } catch (e: any) { req.log.warn({ err: e.message }, 'verificação do número de IVA falhou'); }
        profile = await profileOf(user.id);
        if (unconfirmed(profile)) return back(reply, 'Your VAT number is not confirmed in VIES yet: try again in a few minutes, or remove it in Account to pay with VAT. · O número de IVA ainda não está confirmado no VIES.');
      }
      const d = vatForProfile(profile, s);
      if (!d.ok) return back(reply, both(d.reason === 'outside_eu' ? { en: `${d.message.en} (${contactEmail(s)})`, pt: `${d.message.pt} (${contactEmail(s)})` } : d.message));
      await db.query('UPDATE billing_profiles SET last_checkout_ip=$2, last_checkout_at=now() WHERE user_id=$1', [user.id, req.ip]);
      try {
        const r = await startTopup(db, user, cents, profile, d, s, req.ip, safeReturn(b.voltar));
        await audit(db, user.email, 'credits.checkout_started', null, { topup: r.topup.id, credits: cents / 100, terms: TERMS_VERSION, ip: req.ip, kind: profile.kind, regime: d.regime, rate: d.rate, country: d.country });
        return reply.redirect(r.url, 303);
      } catch (e: any) { return back(reply, String(e.message).slice(0, 200)); }
    });
  });
}
