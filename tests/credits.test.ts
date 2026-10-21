import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { saveSetting } = await import('../src/settings.ts');
const { runOne } = await import('../src/jobs.ts');
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const W = await import('../src/wallet.ts');
const { parseTopupEuros } = await import('../src/routes/credits.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie = '') => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const audio = (url: string, wav: Buffer, cookie: string) => app.inject({ method: 'POST', url, payload: wav, headers: { 'content-type': 'audio/wav', cookie } });
const msg = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const PW = 'uma-palavra-passe-longa';
/** NIF fictício com o dígito de controlo certo (só para testes). */
const nifOf = (p8: string) => { const sum = [...p8].reduce((s, d, i) => s + Number(d) * (9 - i), 0); return p8 + (sum % 11 < 2 ? 0 : 11 - (sum % 11)); };
const register = async (name: string, email: string) => {
  const r = await post('/registar', { name, email, password: PW, terms: 1 });
  return { cookie: `sid=${cookies(r).sid}`, id: (await db.one('SELECT id FROM users WHERE email=$1', [email])).id as string };
};
const walletOf = (userId: string) => db.one('SELECT * FROM wallets WHERE user_id=$1 AND entity_id IS NULL', [userId]);
const check = async () => assert.deepEqual(await W.ledgerCheck(db), [], 'livro-razão: soma das entradas = saldos; disponível = lotes');

// ---------- Stripe falsa (sem rede): qualquer pedido que não seja à Stripe falsa ativa faz falhar o teste ----------
const realFetch = globalThis.fetch;
let activeFake: ((u: any, init: any) => Promise<Response>) | null = null;
globalThis.fetch = ((u: any, init: any) => (activeFake ? activeFake(u, init) : Promise.reject(new Error(`rede proibida nos testes: ${String(u)}`)))) as any;
after(() => { globalThis.fetch = realFetch; });
type Call = { method: string; path: string; params: URLSearchParams; idem?: string };
const fake = { calls: [] as Call[], sessions: {} as Record<string, any>, refundStatus: 'succeeded', refunds: [] as any[], n: 0, refundFail: 0 };
activeFake = (async (u: any, init: any = {}) => {
  const url = new URL(String(u));
  if (url.hostname !== 'api.stripe.com') throw new Error(`rede proibida nos testes: ${url.hostname}`);
  const method = init.method ?? 'GET';
  const c: Call = { method, path: url.pathname.replace(/^\/v1\//, ''), params: new URLSearchParams(method === 'GET' ? url.search : String(init.body ?? '')), idem: init.headers?.['Idempotency-Key'] };
  fake.calls.push(c);
  const reply = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const p = c.path, id = () => `${++fake.n}`;
  if (p === 'tax_rates') return reply({ id: `txr_${c.params.get('country')}${c.params.get('percentage')}_${id()}` });
  if (p === 'customers') return reply({ id: `cus_${id()}` });
  if (p.startsWith('customers/')) return reply({ id: p.slice(10) });
  if (p === 'checkout/sessions') return reply({ id: `cs_${id()}`, url: `https://checkout.stripe.com/c/pay/cs_${fake.n}` });
  if (p.startsWith('checkout/sessions/')) return fake.sessions[p.slice(18)] ? reply(fake.sessions[p.slice(18)]) : reply({ error: { message: 'No such session', code: 'resource_missing' } }, 404);
  if (p.startsWith('payment_intents/')) return reply({ id: p.slice(16), payment_method: { card: { country: 'PT' } }, latest_charge: { id: `ch_${p.slice(19)}` } });
  if (p === 'refunds' && method === 'POST') {
    if (fake.refundFail) { fake.refundFail--; return reply({ error: { message: 'Charge already refunded', code: 'charge_already_refunded' } }, 400); }
    const r = { id: `re_${id()}`, status: fake.refundStatus, amount: Number(c.params.get('amount')), payment_intent: c.params.get('payment_intent'), metadata: { refund_id: c.params.get('metadata[refund_id]') } };
    fake.refunds.push(r);
    return reply(r);
  }
  if (p === 'refunds') return reply({ data: fake.refunds.filter(r => r.payment_intent === c.params.get('payment_intent')) });
  return reply({ error: { message: `rota não simulada: ${method} ${p}` } }, 400);
});
const find = (m: string, p: string | RegExp) => fake.calls.filter(c => c.method === m && (typeof p === 'string' ? c.path === p : p.test(c.path)));
/** Evento assinado como a Stripe o envia. */
const sendEvent = (ev: any) => {
  const raw = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  return app.inject({ method: 'POST', url: '/webhooks/stripe', payload: raw, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}` } });
};
/** Sessão de Checkout paga de um carregamento (como a Stripe a envia). */
const paidSession = (tp: any, extra: any = {}) => ({ id: tp.stripe_session_id, object: 'checkout.session', mode: 'payment', payment_status: 'paid', amount_total: tp.gross_cents, currency: 'eur',
  payment_intent: `pi_${tp.id.slice(0, 8)}`, customer: tp.stripe_customer_id, customer_details: { name: 'Cliente Créditos, Lda.', email: 'cc@example.com', address: { country: 'PT', postal_code: '1000-001' }, tax_ids: [] },
  metadata: { app: 'quietinterview', kind: 'topup', topup_id: tp.id }, ...extra });
let evN = 0;
const completed = (o: any, type = 'checkout.session.completed') => sendEvent({ id: `evt_c${++evN}`, type, data: { object: o } });
/** Pede um carregamento pela página (resumo → Checkout) e devolve o lote criado. */
const topup = async (cookie: string, euros: number, userId: string) => {
  const r = await post('/conta/creditos/carregar', { valor: euros, terms: '1' }, cookie);
  assert.equal(r.statusCode, 303, msg(r));
  return db.one('SELECT * FROM credit_topups WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [userId]);
};

const SELLER_NIF = nifOf('50000000');
let admin = '', biz = { cookie: '', id: '' };

test('carteira (unidade): lotes FIFO, cativo e liquidação, dívida, caducidade e livro-razão imutável', async () => {
  // a primeira conta registada é a do administrador
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  const u = await db.one(`INSERT INTO users(email, name, password_hash, role) VALUES ('unidade@example.com','U','x','interviewer') RETURNING id`);
  const w = await W.walletFor(db, u.id, null);
  assert.deepEqual([w.available_cents, w.reserved_cents, w.debt_cents, w.frozen], [0, 0, 0, false]);
  assert.equal((await W.walletFor(db, u.id, null)).id, w.id, 'uma carteira por (utilizador, entidade)');
  const lot = async (net: number) => {
    const tp = await db.one(`INSERT INTO credit_topups(wallet_id, user_id, net_cents, vat_cents, gross_cents, vat_rate, vat_regime, customer_kind, customer_country) VALUES ($1,$2,$3,$4,$5,23,'domestic','business','PT') RETURNING id`,
      [w.id, u.id, net, Math.round(net * 0.23), net + Math.round(net * 0.23)]);
    assert.equal(await db.tx((t: any) => W.creditTopup(t, tp.id, { paymentIntent: `pi_u_${tp.id}` })), true);
    assert.equal(await db.tx((t: any) => W.creditTopup(t, tp.id, { paymentIntent: `pi_u_${tp.id}` })), false, 'um lote paga-se uma vez');
    return tp.id as string;
  };
  const A = await lot(2500); await db.query(`UPDATE credit_topups SET expires_at=now() + interval '10 days' WHERE id=$1`, [A]);
  const B = await lot(5000);
  const rem = async (id: string) => (await db.one('SELECT remaining_cents r FROM credit_topups WHERE id=$1', [id])).r;
  // gasto pela ordem de validade: o lote A (o que caduca primeiro) primeiro
  const d = await db.tx((t: any) => W.spend(t, w.id, 3000, { ref: 'u:1', note: 'teste' }));
  assert.deepEqual(d.lots, [{ t: A, c: 2500, b: 'used' }, { t: B, c: 500, b: 'used' }]);
  assert.deepEqual([await rem(A), await rem(B)], [0, 4500]);
  assert.equal((await db.tx((t: any) => W.spend(t, w.id, 3000, { ref: 'u:1', note: 'repetido' }))).id, d.id, 'a mesma cobrança não se repete');
  assert.equal(await db.tx((t: any) => W.spend(t, w.id, 999999, { ref: 'u:2', note: 'sem saldo' })), null);
  // cativo, liquidação parcial e libertação para os mesmos lotes
  await db.tx((t: any) => W.reserve(t, w.id, 2000, { ref: 'q:1' }));
  let cur = await W.walletFor(db, u.id, null);
  assert.deepEqual([cur.available_cents, cur.reserved_cents], [2500, 2000]);
  assert.deepEqual(await db.tx((t: any) => W.settle(t, 'q:1', 1250)), { captured: 1250, released: 750 });
  assert.equal(await db.tx((t: any) => W.settle(t, 'q:1', 2000)), null, 'liquida-se uma vez');
  cur = await W.walletFor(db, u.id, null);
  assert.deepEqual([cur.available_cents, cur.reserved_cents, await rem(B)], [3250, 0, 3250]);
  await db.tx((t: any) => W.reserve(t, w.id, 500, { ref: 'q:2' }));
  await db.tx((t: any) => W.release(t, 'q:2'));
  assert.equal((await W.walletFor(db, u.id, null)).available_cents, 3250);
  // anulação de uma cobrança: os créditos voltam aos lotes de onde saíram
  await db.tx((t: any) => W.reverseDebit(t, 'u:1', 'falhou'));
  await db.tx((t: any) => W.reverseDebit(t, 'u:1', 'falhou outra vez'));
  assert.deepEqual([await rem(A), await rem(B), (await W.walletFor(db, u.id, null)).available_cents], [2500, 3750, 6250]);
  await check();
  // a CHECK ≥ 0 é a última barreira; o livro-razão não se altera
  await assert.rejects(db.query('UPDATE wallets SET available_cents=-1 WHERE id=$1', [w.id]));
  await assert.rejects(db.query(`UPDATE wallet_entries SET available_delta=0 WHERE wallet_id=$1`, [w.id]), /imutável/);
  await assert.rejects(db.query(`DELETE FROM wallet_entries WHERE wallet_id=$1`, [w.id]), /imutável/);
  // aviso 30 dias antes (um por lote) e caducidade só do que resta no lote
  assert.equal(await W.warnExpiring(db), 1);
  assert.equal(await W.warnExpiring(db), 0);
  const mail = await db.one(`SELECT subject, text_body FROM emails WHERE dedupe_key=$1`, [`credits-expiry:${A}`]);
  assert.match(mail.text_body, /25 créditos do seu carregamento caducam a/);
  await db.tx((t: any) => W.spend(t, w.id, 1000, { ref: 'u:3', note: 'antes de caducar' }));
  assert.equal(await W.expireLots(db, new Date(Date.now() + 11 * 86400_000)), 1);
  assert.deepEqual([await rem(A), (await db.one('SELECT expired_cents e FROM credit_topups WHERE id=$1', [A])).e], [0, 1500]);
  assert.equal((await W.walletFor(db, u.id, null)).available_cents, 3750);
  await check();
  // carteira congelada ou com dívida não gasta; o carregamento seguinte paga a dívida primeiro
  await db.tx(async (t: any) => {
    await t.query(`UPDATE wallets SET available_cents=0, debt_cents=1000, frozen=true WHERE id=$1`, [w.id]);
    assert.equal(await W.spend(t, w.id, 100, { ref: 'u:4', note: 'congelada' }), null);
    assert.ok(W.spendBlock(await t.one('SELECT * FROM wallets WHERE id=$1', [w.id])));
    throw new Error('desfazer');
  }).catch((e: any) => assert.equal(e.message, 'desfazer'));
  assert.deepEqual([W.packFor(1), W.packFor(2500), W.packFor(2501), W.packFor(60001), W.packFor(150000)], [2500, 2500, 5000, 60100, 100000]);
  assert.deepEqual([parseTopupEuros('25'), parseTopupEuros('25,00'), parseTopupEuros('24'), parseTopupEuros('1001'), parseTopupEuros('30.5'), parseTopupEuros('1000')], [2500, 2500, null, null, null, 100000]);
});

test('carregamento: vendedora em falta bloqueia; resumo com IVA; Checkout mode=payment só cartão com Idempotency-Key (Stripe falsa)', async () => {
  await saveSetting(db, 'SIGNUPS_OPEN', '1');
  await saveSetting(db, 'STRIPE_SECRET_KEY', 'sk_test_falsa_123');
  await saveSetting(db, 'STRIPE_WEBHOOK_SECRET', 'whsec_test');
  biz = await register('Cliente Créditos', 'cc@example.com');
  assert.match(msg(await post('/billing/profile', { kind: 'business', name: 'Cliente Créditos, Lda.', country: 'PT', tax_id: nifOf('51234567'), address: 'Rua C', postal_code: '1000-001', city: 'Lisboa' }, biz.cookie)), /Billing details saved/);
  // sem denominação, NIF e morada da vendedora: nenhum carregamento, nenhum pedido à Stripe
  const n0 = fake.calls.length;
  assert.match(msg(await post('/conta/creditos/carregar', { valor: 25, terms: '1' }, biz.cookie)), /Online payments are paused until the seller’s details are complete/);
  assert.equal(fake.calls.length, n0);
  assert.match((await get('/conta/creditos/carregar?valor=25', biz.cookie)).body, /Online payments are paused[\s\S]*<button class="accent" disabled>/);
  await saveSetting(db, 'SELLER_NAME', 'Empresa Vendedora de Teste, Lda.');
  await saveSetting(db, 'SELLER_NIF', SELLER_NIF);
  await saveSetting(db, 'SELLER_ADDRESS', 'Rua de Teste, 1, 1000-001 Lisboa');
  // página: saldo, pacotes com o preço «+ IVA» (empresa) e as regras dos créditos (também em português)
  const pg = await get('/conta/creditos', biz.cookie);
  assert.equal(pg.statusCode, 200);
  assert.match(pg.body, /<strong id="available">0<\/strong> credits available/);
  assert.match(pg.body, /<strong>25 credits<\/strong> — €25 \+ VAT \(€30\.75 with 23% VAT\)/);
  assert.match(pg.body, /<strong>500 credits<\/strong> — €500 \+ VAT \(€615 with 23% VAT\)/);
  assert.match(pg.body, /valid for 24 months/); assert.match(pg.body, /lang="pt-PT">1 crédito = 1 € sem IVA/);
  assert.match(pg.body, /Este extrato não é fatura nem recibo/);
  // valores fora do intervalo recusados; «outro valor» aceite em euros inteiros
  assert.match(msg(await get('/conta/creditos/carregar?valor=24', biz.cookie)), /Choose between 25 and 1000 credits/);
  assert.match(msg(await get('/conta/creditos/carregar?valor=outro&outro=1001', biz.cookie)), /Choose between 25 and 1000/);
  const sum = await get('/conta/creditos/carregar?valor=outro&outro=37', biz.cookie);
  assert.match(sum.body, /Top up 37 credits/); assert.match(sum.body, /€37 \+ VAT 23% €8\.51 = <strong>€45\.51<\/strong>/);
  assert.match(sum.body, /<button class="accent" >Pay €37 \+ VAT \(€45\.51\)<\/button>/);
  assert.match((await get('/conta/creditos/carregar?falta=730', biz.cookie)).body, /You need 7\.30 more credits; the next top-up option is 25/);
  // sem aceitar os termos: nada; o administrador não carrega créditos
  assert.match(msg(await post('/conta/creditos/carregar', { valor: 25 }, biz.cookie)), /accept the terms of sale/);
  assert.match(msg(await post('/conta/creditos/carregar', { valor: 25, terms: '1' }, admin)), /Administrators do not need credits/);
  assert.equal(fake.calls.length, n0);
  const r = await post('/conta/creditos/carregar', { valor: 25, terms: '1', voltar: '/entrevistas/x/../../admin' }, biz.cookie);
  assert.equal(r.statusCode, 303);
  assert.match(r.headers.location as string, /^https:\/\/checkout\.stripe\.com\//);
  const tp = await db.one('SELECT * FROM credit_topups WHERE user_id=$1', [biz.id]);
  assert.deepEqual([tp.status, tp.net_cents, tp.vat_cents, tp.gross_cents, Number(tp.vat_rate), tp.vat_regime, tp.customer_kind, tp.return_path], ['pending', 2500, 575, 3075, 23, 'domestic', 'business', null]);
  assert.ok(tp.evidence.ip && tp.evidence.nif, 'provas do país guardadas no lote');
  assert.equal(tp.seller.nif, SELLER_NIF);
  const [cs] = find('POST', 'checkout/sessions');
  const p = Object.fromEntries(cs.params);
  assert.equal(cs.idem, `quietinterview:topup:${tp.id}`);
  assert.equal(p.mode, 'payment'); assert.equal(p['payment_method_types[0]'], 'card'); assert.ok(!('payment_method_types[1]' in p), 'só cartão');
  assert.equal(p.billing_address_collection, 'required'); assert.equal(p['tax_id_collection[enabled]'], 'true');
  assert.equal(p['line_items[0][price_data][unit_amount]'], '2500'); assert.equal(p['line_items[0][price_data][currency]'], 'eur'); assert.equal(p['line_items[0][price_data][tax_behavior]'], 'exclusive');
  assert.match(p['line_items[0][tax_rates][0]'], /^txr_PT23_/);
  assert.deepEqual([p['metadata[app]'], p['metadata[kind]'], p['metadata[topup_id]'], p['payment_intent_data[metadata][topup_id]'], p['metadata[vat_rate]']], ['quietinterview', 'topup', tp.id, tp.id, '23']);
  assert.equal(p.success_url, 'http://test.local/conta/creditos?sessao={CHECKOUT_SESSION_ID}');
  assert.ok(Number(p.expires_at) > Date.now() / 1000 + 30 * 60, 'a sessão dura pelo menos 30 min');
  assert.equal(tp.stripe_session_id, `cs_${fake.n}`);
  assert.equal((await db.one('SELECT scope, customer_id FROM stripe_customers WHERE user_id=$1', [biz.id])).scope, 'global', 'cliente Stripe por (utilizador, conta Stripe)');
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='credits.checkout_started' AND meta->>'topup'=$1`, [tp.id]));
  // ainda nada creditado
  assert.equal((await walletOf(biz.id)).available_cents, 0);
});

test('webhook e regresso do Checkout: credita uma vez; valor errado não credita; expirado; assíncrono; outro portal ignorado', async () => {
  let tp = await db.one('SELECT * FROM credit_topups WHERE user_id=$1 ORDER BY created_at LIMIT 1', [biz.id]);
  const o = paidSession(tp);
  assert.equal((await completed(o)).json().result, 'applied');
  const again = await completed(o); // outro evento com a mesma sessão (a Stripe pode repetir)
  assert.equal(again.json().result, 'applied');
  tp = await db.one('SELECT * FROM credit_topups WHERE id=$1', [tp.id]);
  assert.deepEqual([tp.status, tp.remaining_cents, tp.stripe_payment_intent, tp.stripe_charge], ['paid', 2500, o.payment_intent, `ch_${o.payment_intent.slice(3)}`]);
  assert.ok(Math.abs(new Date(tp.expires_at).getTime() - new Date(tp.paid_at).getTime() - 730 * 86400_000) < 3 * 86400_000, 'válido 24 meses');
  assert.equal(tp.evidence.cardCountry, 'PT'); assert.equal(tp.evidence.billingCountry, 'PT');
  assert.equal((await walletOf(biz.id)).available_cents, 2500);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM wallet_entries WHERE kind='topup' AND topup_id=$1`, [tp.id])).n), 1);
  // lista «por faturar»: fatura-recibo do carregamento (vale de finalidade única), com o IVA e a vendedora
  const iq = await db.one(`SELECT * FROM invoice_queue WHERE topup_id=$1`, [tp.id]);
  assert.deepEqual([iq.kind, iq.net_cents, iq.vat_cents, iq.total_cents, iq.vat_regime, iq.stripe_ref], ['topup', 2500, 575, 3075, 'domestic', o.payment_intent]);
  assert.match(iq.description, /Créditos pré-pagos para serviços de produção de vídeo com IA — quietinterview \(vale de finalidade única\): 25 créditos, válidos até \d\d\/\d\d\/\d{4}/);
  assert.equal(iq.seller.name, 'Empresa Vendedora de Teste, Lda.');
  const fat = await get('/admin/faturacao', admin);
  assert.match(fat.body, /carregamento de créditos<\/span><br>Créditos pré-pagos/);
  assert.match(fat.body, /25,00 € \+ IVA 5,75 €<br><strong>30,75 €<\/strong>/);
  // confirmação por email (suporte duradouro)
  const mail = await db.one(`SELECT text_body FROM emails WHERE dedupe_key=$1`, [`topup:${tp.id}`]);
  assert.match(mail.text_body, /Carregámos 25 créditos[\s\S]*25,00 € \+ IVA 5,75 € = 30,75 €[\s\S]*reembolso do saldo ainda disponível deste carregamento até/);
  // o administrador regista a fatura do Moloni: o número fica também no lote (extrato do cliente)
  assert.match(msg(await post(`/admin/faturacao/${iq.id}/faturada`, { moloni_doc: 'FR 2026/40' }, admin)), /FR 2026\/40/);
  assert.equal((await db.one('SELECT moloni_doc FROM credit_topups WHERE id=$1', [tp.id])).moloni_doc, 'FR 2026/40');
  // regresso do Checkout de um lote já pago: só a mensagem
  const back = await get(`/conta/creditos?sessao=${tp.stripe_session_id}`, biz.cookie);
  assert.match(back.body, /Payment received: your credits are available/); assert.match(back.body, /<strong id="available">25<\/strong>/);
  assert.match(back.body, /FR 2026\/40/);

  // regresso do Checkout ANTES do webhook: credita logo (consulta a sessão na Stripe); o webhook depois não repete
  let t2 = await topup(biz.cookie, 50, biz.id);
  fake.sessions[t2.stripe_session_id] = paidSession(t2);
  assert.match((await get(`/conta/creditos?sessao=${t2.stripe_session_id}`, biz.cookie)).body, /Payment received/);
  assert.equal((await walletOf(biz.id)).available_cents, 7500);
  assert.equal((await completed(paidSession(t2))).json().result, 'applied');
  assert.equal((await walletOf(biz.id)).available_cents, 7500, 'o webhook atrasado não credita outra vez');
  // valor que não confere: não credita, alerta para o administrador
  const t3 = await topup(biz.cookie, 25, biz.id);
  await completed(paidSession(t3, { amount_total: 100 }));
  const t3b = await db.one('SELECT * FROM credit_topups WHERE id=$1', [t3.id]);
  assert.equal(t3b.status, 'pending'); assert.match(t3b.alert, /não confere com o carregamento \(30,75 €\): créditos NÃO aplicados/);
  assert.equal((await walletOf(biz.id)).available_cents, 7500);
  // sessão expirada (só a Stripe expira); um pagamento que chegue depois é aceite, com alerta
  const t4 = await topup(biz.cookie, 25, biz.id);
  await completed({ ...paidSession(t4), payment_status: 'unpaid' }, 'checkout.session.expired');
  assert.equal((await db.one('SELECT status FROM credit_topups WHERE id=$1', [t4.id])).status, 'expired');
  await completed(paidSession(t4), 'checkout.session.async_payment_succeeded');
  const t4b = await db.one('SELECT * FROM credit_topups WHERE id=$1', [t4.id]);
  assert.equal(t4b.status, 'paid'); assert.match(t4b.alert, /Pagamento recebido depois de o carregamento ter ficado «expirado»/);
  assert.equal((await walletOf(biz.id)).available_cents, 10000);
  // pagamento assíncrono: completed «unpaid» não credita; async_payment_failed falha; async_payment_succeeded credita
  const t5 = await topup(biz.cookie, 25, biz.id);
  await completed({ ...paidSession(t5), payment_status: 'unpaid' });
  assert.equal((await db.one('SELECT status FROM credit_topups WHERE id=$1', [t5.id])).status, 'pending');
  await completed({ ...paidSession(t5), payment_status: 'unpaid' }, 'checkout.session.async_payment_failed');
  assert.equal((await db.one('SELECT status FROM credit_topups WHERE id=$1', [t5.id])).status, 'failed');
  // sessões de outro portal da mesma conta Stripe: ignoradas
  assert.equal((await completed({ ...paidSession(t3), metadata: { app: 'outro-portal', kind: 'topup', topup_id: t3.id } })).json().result, 'ignored');
  assert.equal((await walletOf(biz.id)).available_cents, 10000);
  const pg = await get('/conta/creditos', biz.cookie);
  assert.match(pg.body, /<strong id="available">100<\/strong> credits available/);
  assert.match(pg.body, /Top-up <span class="hint" lang="pt-PT">· Carregamento<\/span>/);
  assert.match(pg.body, /refundable until \d{4}-\d\d-\d\d/);
  await check();
});

test('reembolsos: saldo disponível nos 14 dias pela Stripe (Idempotency-Key), encerramento, falha, painel da Stripe; disputa congela e cria dívida', async () => {
  const lots = await db.query('SELECT * FROM credit_topups WHERE user_id=$1 AND status=$2 ORDER BY paid_at', [biz.id, 'paid']);
  const [L1, L2] = lots;
  const w = await walletOf(biz.id);
  // 10 créditos gastos: saem do lote mais antigo (L1: 25 → 15)
  await db.tx((t: any) => W.spend(t, w.id, 1000, { ref: 'teste:gasto', note: 'teste' }));
  assert.equal((await db.one('SELECT remaining_cents r FROM credit_topups WHERE id=$1', [L1.id])).r, 1500);
  assert.equal((await post(`/admin/creditos/${L1.id}/reembolsar`, {}, biz.cookie)).statusCode, 403);
  const page = await get('/admin/creditos', admin);
  assert.match(page.body, /Livro-razão conferido/);
  assert.match(page.body, /Reembolsar saldo disponível \(15 cr = 18,45 €\)/);
  const r = await post(`/admin/creditos/${L1.id}/reembolsar`, {}, admin);
  assert.match(msg(r), /Reembolso de 18,45 € feito \(15 créditos\)/);
  const [rf] = find('POST', 'refunds');
  assert.deepEqual([rf.params.get('payment_intent'), rf.params.get('amount'), rf.params.get('metadata[app]')], [L1.stripe_payment_intent, '1845', 'quietinterview']);
  const cr0 = await db.one('SELECT * FROM credit_refunds WHERE topup_id=$1', [L1.id]);
  assert.equal(rf.idem, `quietinterview:refund:${cr0.id}`); assert.equal(rf.params.get('metadata[refund_id]'), cr0.id);
  assert.deepEqual([cr0.status, cr0.net_cents, cr0.gross_cents, cr0.source, cr0.reason], ['succeeded', 1500, 1845, 'app', 'withdrawal']);
  const L1b = await db.one('SELECT * FROM credit_topups WHERE id=$1', [L1.id]);
  assert.deepEqual([L1b.status, L1b.remaining_cents, L1b.refunded_cents, L1b.used_cents], ['partially_refunded', 0, 1500, 1000]);
  assert.equal((await walletOf(biz.id)).available_cents, 7500);
  const nc = await db.one(`SELECT * FROM invoice_queue WHERE kind='topup_refund' AND topup_id=$1`, [L1.id]);
  assert.deepEqual([nc.net_cents, nc.vat_cents, nc.total_cents], [-1500, -345, -1845]);
  assert.match(nc.description, /Nota de crédito: reembolso de 15 créditos do carregamento de .* \(fatura-recibo n\.º FR 2026\/40\)/);
  // o webhook do nosso reembolso (pela metadata) não debita outra vez
  assert.equal((await sendEvent({ id: 'evt_re1', type: 'refund.updated', data: { object: { id: fake.refunds[0].id, status: 'succeeded', amount: 1845, payment_intent: L1.stripe_payment_intent, metadata: { refund_id: cr0.id } } } })).json().result, 'applied');
  assert.equal((await walletOf(biz.id)).available_cents, 7500);
  // nada mais a reembolsar neste lote
  assert.match(msg(await post(`/admin/creditos/${L1.id}/reembolsar`, {}, admin)), /Só se reembolsam carregamentos pagos|já não tem saldo disponível/);
  // passados os 14 dias, só por encerramento do serviço (caixa assinalada)
  await db.query(`UPDATE credit_topups SET paid_at=now() - interval '20 days' WHERE id=$1`, [L2.id]);
  assert.match(msg(await post(`/admin/creditos/${L2.id}/reembolsar`, {}, admin)), /Passaram mais de 14 dias desde o carregamento: só se reembolsa por encerramento/);
  // a Stripe recusa: os créditos voltam à carteira
  fake.refundFail = 1;
  assert.match(msg(await post(`/admin/creditos/${L2.id}/reembolsar`, { encerramento: '1' }, admin)), /A Stripe recusou o reembolso: Stripe: Charge already refunded\. Os créditos voltaram à carteira/);
  assert.equal((await walletOf(biz.id)).available_cents, 7500);
  assert.equal((await db.one(`SELECT status FROM credit_refunds WHERE topup_id=$1`, [L2.id])).status, 'failed');
  assert.ok(await db.one(`SELECT 1 FROM wallet_entries WHERE kind='refund_reversal' AND topup_id=$1`, [L2.id]));
  // reembolso pendente na Stripe; termina pelo webhook
  fake.refundStatus = 'pending';
  assert.match(msg(await post(`/admin/creditos/${L2.id}/reembolsar`, { encerramento: '1' }, admin)), /a Stripe ainda o está a processar/);
  fake.refundStatus = 'succeeded';
  const pend = await db.one(`SELECT * FROM credit_refunds WHERE topup_id=$1 AND status='pending'`, [L2.id]);
  assert.deepEqual([pend.reason, pend.net_cents, pend.gross_cents], ['closure', 5000, 6150]);
  assert.equal((await walletOf(biz.id)).available_cents, 2500);
  await sendEvent({ id: 'evt_re2', type: 'refund.updated', data: { object: { id: pend.stripe_refund_id, status: 'succeeded', amount: 6150, payment_intent: L2.stripe_payment_intent, metadata: { refund_id: pend.id } } } });
  assert.equal((await db.one('SELECT status FROM credit_refunds WHERE id=$1', [pend.id])).status, 'succeeded');
  assert.equal((await db.one('SELECT status FROM credit_topups WHERE id=$1', [L2.id])).status, 'refunded');
  assert.ok(await db.one(`SELECT 1 FROM invoice_queue WHERE stripe_ref=$1 AND kind='topup_refund'`, [pend.stripe_refund_id]));
  await check();

  // reembolso feito no painel da Stripe (sem metadata): identificado pelo pagamento; o que falta no saldo fica em dívida
  const L3 = (await db.query('SELECT * FROM credit_topups WHERE user_id=$1 AND status=$2 ORDER BY paid_at', [biz.id, 'paid']))[0];
  await db.tx((t: any) => W.spend(t, w.id, 2000, { ref: 'teste:gasto2', note: 'teste' }));
  assert.equal((await walletOf(biz.id)).available_cents, 500);
  assert.equal((await sendEvent({ id: 'evt_ext1', type: 'refund.created', data: { object: { id: 're_painel', status: 'succeeded', amount: 3075, payment_intent: L3.stripe_payment_intent, metadata: {} } } })).json().result, 'applied');
  let wb = await walletOf(biz.id);
  assert.deepEqual([wb.available_cents, wb.debt_cents, wb.frozen], [0, 2000, true]);
  assert.match((await db.one('SELECT alert FROM credit_topups WHERE id=$1', [L3.id])).alert, /Reembolso de 30,75 € feito fora da aplicação \(painel da Stripe\): carteira debitada em 25 créditos, 20 em dívida e carteira congelada/);
  assert.equal((await sendEvent({ id: 'evt_ext1b', type: 'refund.updated', data: { object: { id: 're_painel', status: 'succeeded', amount: 3075, payment_intent: L3.stripe_payment_intent } } })).json().result, 'applied');
  assert.equal((await walletOf(biz.id)).debt_cents, 2000, 'o mesmo reembolso não debita duas vezes');
  assert.ok(await db.one(`SELECT 1 FROM invoice_queue WHERE stripe_ref='re_painel' AND total_cents=-3075`));
  // com dívida: nada se gasta; o carregamento seguinte paga a dívida primeiro e a carteira volta a funcionar
  const cpg = (await get('/conta/creditos', biz.cookie)).body;
  assert.match(cpg, /Owed: <strong>20<\/strong>/); assert.match(cpg, /Your credit wallet is on hold \(a payment was disputed or reversed\)/);
  assert.equal(await db.tx((t: any) => W.spend(t, w.id, 100, { ref: 'teste:divida', note: 'com dívida' })), null);
  const t6 = await topup(biz.cookie, 25, biz.id);
  await completed(paidSession(t6));
  wb = await walletOf(biz.id);
  assert.deepEqual([wb.available_cents, wb.debt_cents, wb.frozen], [500, 0, false]);
  assert.match((await db.one(`SELECT note FROM wallet_entries WHERE kind='topup' AND topup_id=$1`, [t6.id])).note, /20 créditos pagaram a dívida/);
  await check();

  // disputa: carteira congelada, débito e dívida; ganha, os créditos voltam e a carteira descongela
  const L6 = await db.one('SELECT * FROM credit_topups WHERE id=$1', [t6.id]);
  await sendEvent({ id: 'evt_dp1', type: 'charge.dispute.created', data: { object: { id: 'dp_1', amount: 3075, charge: L6.stripe_charge, payment_intent: L6.stripe_payment_intent, status: 'needs_response' } } });
  wb = await walletOf(biz.id);
  assert.deepEqual([wb.available_cents, wb.debt_cents, wb.frozen], [0, 2000, true]);
  assert.equal((await db.one('SELECT status FROM credit_topups WHERE id=$1', [L6.id])).status, 'disputed');
  assert.match((await get('/conta/creditos', biz.cookie)).body, /Your credit wallet is on hold/);
  assert.match((await get('/admin/creditos', admin)).body, /congelada \(disputa\)/);
  assert.equal((await sendEvent({ id: 'evt_dp1b', type: 'charge.dispute.created', data: { object: { id: 'dp_1', amount: 3075, charge: L6.stripe_charge } } })).json().result, 'applied');
  assert.equal((await walletOf(biz.id)).debt_cents, 2000, 'a mesma disputa não debita duas vezes');
  await sendEvent({ id: 'evt_dp2', type: 'charge.dispute.closed', data: { object: { id: 'dp_1', amount: 3075, charge: L6.stripe_charge, status: 'won' } } });
  wb = await walletOf(biz.id);
  assert.deepEqual([wb.available_cents, wb.debt_cents, wb.frozen], [500, 0, false]);
  assert.equal((await db.one('SELECT status FROM credit_topups WHERE id=$1', [L6.id])).status, 'paid');
  // disputa perdida: os créditos ficam debitados e a dívida mantém a carteira congelada até o carregamento seguinte a pagar
  await sendEvent({ id: 'evt_dp3', type: 'charge.dispute.created', data: { object: { id: 'dp_2', amount: 3075, charge: L6.stripe_charge, payment_intent: L6.stripe_payment_intent } } });
  await sendEvent({ id: 'evt_dp4', type: 'charge.dispute.closed', data: { object: { id: 'dp_2', charge: L6.stripe_charge, status: 'lost' } } });
  wb = await walletOf(biz.id);
  assert.deepEqual([wb.available_cents, wb.debt_cents, wb.frozen], [0, 2000, true]);
  assert.equal((await db.one('SELECT status FROM credit_topups WHERE id=$1', [L6.id])).status, 'disputed');
  assert.match((await db.one('SELECT alert FROM credit_topups WHERE id=$1', [L6.id])).alert, /Disputa dp_2 perdida: créditos debitados e 20 em dívida/);
  await completed(paidSession(await topup(biz.cookie, 25, biz.id)));
  wb = await walletOf(biz.id);
  assert.deepEqual([wb.available_cents, wb.debt_cents, wb.frozen], [500, 0, false]);
  // reembolsos e disputas de pagamentos que não são carregamentos: ignorados
  assert.equal((await sendEvent({ id: 'evt_x', type: 'refund.created', data: { object: { id: 're_x', status: 'succeeded', amount: 100, payment_intent: 'pi_outro' } } })).json().result, 'ignored');
  await check();
});

test('a entidade não muda com saldo; entrevista extra a 6 créditos; regeneração extra a 1 crédito (devolvido se falhar)', async () => {
  const ent = await db.one(`INSERT INTO entities(slug, name) VALUES ('outra','Outra') RETURNING id`);
  const m = msg(await post(`/admin/utilizadores/${biz.id}/perfil`, { role: 'interviewer', entity_id: ent.id }, admin));
  assert.match(m, /Não é possível mudar a entidade: o utilizador tem 5 créditos disponíveis, 0 cativos e 0 em dívida/);
  assert.equal((await db.one('SELECT entity_id FROM users WHERE id=$1', [biz.id])).entity_id, null);
  // subscrição com a quota do período esgotada (0 entrevistas)
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source, interviews_override) VALUES ($1,'start','active','manual',0)`, [biz.id]);
  const c = await post('/entrevistas', { title: 'Extra' }, biz.cookie);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Só uma?' }, biz.cookie);
  await post(`/entrevistas/${id}/guardar`, { title: 'Extra', objective_text: 'O', host_name: 'Zé', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en' }, biz.cookie);
  // saldo de 5: falta 1 crédito → «carregar o que falta»
  let pg = (await get(`/entrevistas/${id}/convidar`, biz.cookie)).body;
  assert.match(pg, /entrevista extra por 6 créditos<\/strong> \(saldo: 5 créditos\)/);
  assert.match(pg, /href="\/conta\/creditos\/carregar\?falta=100&amp;voltar=%2Fentrevistas%2F[0-9a-f-]{36}%2Fconvidar">Carregar o que falta/);
  assert.match(pg, /<button class="accent" disabled>Enviar convite e pagar 6 créditos<\/button>/);
  assert.match(msg(await post(`/entrevistas/${id}/convidar`, { extra: '1' }, biz.cookie)), /Saldo insuficiente: a entrevista extra custa 6 créditos e tem 5/);
  const t7 = await post('/conta/creditos/carregar', { valor: 25, terms: '1', voltar: `/entrevistas/${id}/convidar` }, biz.cookie);
  assert.equal(t7.statusCode, 303);
  const L7 = await db.one('SELECT * FROM credit_topups WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1', [biz.id]);
  assert.equal(L7.return_path, `/entrevistas/${id}/convidar`);
  await completed(paidSession(L7));
  assert.match((await get(`/conta/creditos?sessao=${L7.stripe_session_id}`, biz.cookie)).body, new RegExp(`href="/entrevistas/${id}/convidar">Back to your interview`));
  pg = (await get(`/entrevistas/${id}/convidar`, biz.cookie)).body;
  assert.match(pg, /<button class="accent" >Enviar convite e pagar 6 créditos<\/button>/);
  assert.match(msg(await post(`/entrevistas/${id}/convidar`, {}, biz.cookie)), /envie como entrevista extra por 6 créditos/);
  const ok = await post(`/entrevistas/${id}/convidar`, { extra: '1' }, biz.cookie);
  assert.match(msg(ok), /Convite enviado como entrevista extra \(6 créditos\)/);
  assert.deepEqual(Object.values(await db.one('SELECT collection_status, extra_cents, question_limit FROM interviews WHERE id=$1', [id])), ['invited', 600, 15]);
  assert.equal((await walletOf(biz.id)).available_cents, 2400);
  assert.equal((await post(`/entrevistas/${id}/convidar`, { extra: '1' }, biz.cookie)).headers.location, `/entrevistas/${id}`, 'duplo clique: uma só cobrança');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM wallet_entries WHERE ref=$1`, [`extra:${id}`])).n), 1);
  // as entrevistas extra não contam para a quota do plano
  assert.equal((await db.one(`SELECT count(*)::int n FROM interviews WHERE owner_id=$1 AND invited_at IS NOT NULL AND extra_cents IS NULL`, [biz.id])).n, 0);

  // o convidado responde; o processamento inicial não conta; 3 regenerações incluídas (simuladas); a seguinte custa 1 crédito
  await flushOutbox(db);
  const mail = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [id]);
  const g = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(mail.text_body)![1]}/abrir`, {}, '')).gs}`;
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, g);
  const q = (await db.one('SELECT id FROM questions WHERE interview_id=$1', [id])).id;
  assert.equal((await audio(`/api/g/respostas/${q}`, makeToneWav(2), g)).statusCode, 200);
  await post('/entrevista/submeter', {}, g);
  await post(`/entrevistas/${id}/processar`, {}, biz.cookie); await drain();
  for (let i = 0; i < 3; i++) await db.query(`INSERT INTO jobs(interview_id, kind, input, state) VALUES ($1,'prepare_script','{"regen":true}','done')`, [id]);
  pg = (await get(`/entrevistas/${id}/producao`, biz.cookie)).body;
  assert.match(pg, /<input type="hidden" name="pagar" value="1"><button class="ghost" >Regenerar guião a partir das transcrições — pagar 1 crédito<\/button>/);
  assert.match(pg, /Cada regeneração seguinte custa 1 crédito\. Saldo: 24 créditos/);
  // sem o pedido expresso de pagar, nada é cobrado nem gerado
  assert.match(msg(await post(`/entrevistas/${id}/guiao/regenerar`, {}, biz.cookie)), /Cada regeneração seguinte custa 1 crédito\. Saldo: 24 créditos/);
  assert.match(msg(await post(`/entrevistas/${id}/guiao/regenerar`, { pagar: '1' }, biz.cookie)), /Guião em regeneração \(1 crédito\)/);
  const job = await db.one(`SELECT * FROM jobs WHERE interview_id=$1 AND kind='prepare_script' AND state='queued'`, [id]);
  assert.deepEqual([job.input.regen, job.input.paidCents], [true, 100]);
  assert.equal((await walletOf(biz.id)).available_cents, 2300);
  assert.ok(await db.one(`SELECT 1 FROM wallet_entries WHERE kind='debit' AND ref=$1 AND job_id=$2 AND available_delta=-100`, [`regen:${job.id}`, job.id]), 'cobrança única por trabalho');
  await drain();
  // uma regeneração paga que falha devolve o crédito (e não conta para as regenerações)
  await post(`/entrevistas/${id}/guiao/regenerar`, { pagar: '1' }, biz.cookie);
  const job2 = await db.one(`SELECT * FROM jobs WHERE interview_id=$1 AND kind='prepare_script' AND state='queued'`, [id]);
  assert.equal((await walletOf(biz.id)).available_cents, 2200);
  await db.query(`UPDATE jobs SET state='failed', error='simulado' WHERE id=$1`, [job2.id]);
  assert.deepEqual(await W.walletHousekeeping(db), { warned: 0, expired: 0, reversed: 1 });
  assert.equal((await walletOf(biz.id)).available_cents, 2300);
  assert.equal((await W.walletHousekeeping(db)).reversed, 0, 'devolvido uma vez');
  // o extrato do cliente mostra as utilizações e a devolução (sem lhe chamar fatura)
  const st = (await get('/conta/creditos', biz.cookie)).body;
  assert.match(st, /Used <span class="hint" lang="pt-PT">· Utilização<\/span><br><span class="hint">Entrevista extra: Extra<\/span>/);
  assert.match(st, /Usage returned[\s\S]*a regeneração falhou: crédito devolvido/);
  await check();
});

test('consumidor: preço com IVA primeiro, botão «Pagar … €» e as duas caixas para usar créditos num serviço', async () => {
  await saveSetting(db, 'SELLER_EMAIL', 'vendas@exemplo.pt');
  await saveSetting(db, 'SELLER_COMPLAINTS_URL', 'https://www.livroreclamacoes.pt/Inicio/');
  const c = await register('Consumidora', 'consumidora@example.com');
  await post('/billing/profile', { kind: 'consumer', name: 'Maria Consumidora', country: 'PT', tax_id: '', address: 'Rua B', postal_code: '9500-001', city: 'Ponta Delgada' }, c.cookie);
  const pg = (await get('/conta/creditos', c.cookie)).body;
  assert.match(pg, /<strong>25 credits<\/strong> — €29 incl\. VAT · <span lang="pt-PT">29,00 € com IVA \(25,00 € \+ IVA 16%\)<\/span>/);
  const sum = (await get('/conta/creditos/carregar?valor=100', c.cookie)).body;
  assert.match(sum, /<button class="accent" >Pagar 116,00 € \(100 créditos\) · Pay €116<\/button>/);
  const r = await post('/conta/creditos/carregar', { valor: 25, terms: '1' }, c.cookie);
  assert.equal(r.statusCode, 303);
  const cs = find('POST', 'checkout/sessions').at(-1)!;
  assert.equal(cs.params.get('locale'), 'pt'); assert.match(cs.params.get('line_items[0][tax_rates][0]')!, /^txr_PT16_/);
  const L = await db.one('SELECT * FROM credit_topups WHERE user_id=$1', [c.id]);
  await completed(paidSession(L, { customer_details: { email: 'consumidora@example.com', address: { country: 'PT', postal_code: '9500-001' } } }));
  assert.match((await db.one(`SELECT text_body FROM emails WHERE dedupe_key=$1`, [`topup:${L.id}`])).text_body, /por 29,00 € com IVA \(25,00 € \+ IVA 16%\)/);
  // entrevista extra: o consumidor tem de pedir o início imediato e reconhecer a perda da livre resolução
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source, interviews_override) VALUES ($1,'start','active','manual',0)`, [c.id]);
  const n = await post('/entrevistas', { title: 'Extra consumidor' }, c.cookie);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(n.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Pergunta?' }, c.cookie);
  await post(`/entrevistas/${id}/guardar`, { title: 'Extra consumidor', objective_text: 'O', host_name: 'Maria', guest_name: 'Rui', guest_email: 'rui2@example.com', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en' }, c.cookie);
  const inv = (await get(`/entrevistas/${id}/convidar`, c.cookie)).body;
  assert.match(inv, /name="start_now" value="1" required> <span>Peço que o serviço comece já/);
  assert.match(inv, /name="waiver" value="1" required> <span>Reconheço que perco o direito de livre resolução/);
  assert.match(inv, /Enviar convite e pagar 6,96 € \(6 créditos\)/);
  assert.match(msg(await post(`/entrevistas/${id}/convidar`, { extra: '1', start_now: '1' }, c.cookie)), /confirme o pedido de início imediato/);
  assert.equal((await db.one('SELECT available_cents a FROM wallets WHERE user_id=$1', [c.id])).a, 2500);
  assert.match(msg(await post(`/entrevistas/${id}/convidar`, { extra: '1', start_now: '1', waiver: '1' }, c.cookie)), /Convite enviado como entrevista extra/);
  assert.equal((await db.one('SELECT available_cents a FROM wallets WHERE user_id=$1', [c.id])).a, 1900);
  const a = await db.one(`SELECT meta FROM audit_events WHERE action='invitation.sent' AND interview_id=$1`, [id]);
  assert.equal(a.meta.startNow, true); assert.equal(a.meta.waiver, true);
  // termos: regras dos créditos com os preços com IVA
  const t = (await get('/termos')).body;
  assert.match(t, /Créditos pré-pagos<\/h2>/);
  assert.match(t, /25 créditos custam 30,75 € \(continente, 23%\), 30,50 € \(Madeira, 22%\), 29,00 € \(Açores, 16%\)/);
  assert.match(t, /vale de finalidade única: o IVA é cobrado no carregamento/);
  assert.match(t, /válido durante 24 meses a contar do pagamento; avisamos por email 30 dias antes/);
  assert.match(t, /reembolsado por inteiro, a pedido, nos 14 dias seguintes a esse carregamento/);
  await check();
});
