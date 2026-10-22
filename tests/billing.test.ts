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
const { saveSetting, S, SETTING_DEFS } = await import('../src/settings.ts');
const { verifyStripeSignature } = await import('../src/billing.ts');
const { flushOutbox } = await import('../src/mail.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const post = (url: string, body: any, cookie = '', extra: any = {}) => app.inject({ method: 'POST', url, payload: typeof body === 'string' ? body : form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...extra } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const PW = 'uma-palavra-passe-longa';
let admin = '', user = '', userId = '';

test('primeira conta é admin; as seguintes são entrevistadores sem subscrição', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  const r = await post('/registar', { name: 'Zé', email: 'ze@example.com', password: PW, terms: 1 });
  assert.equal(r.headers.location, '/account');
  user = `sid=${cookies(r).sid}`;
  const u = await db.one(`SELECT id, role FROM users WHERE email='ze@example.com'`);
  userId = u.id; assert.equal(u.role, 'interviewer');
  assert.equal((await post('/registar', { name: 'X', email: 'x@example.com', password: PW })).statusCode, 302, 'sem aceitar termos volta ao formulário');
  assert.equal(await db.one(`SELECT 1 FROM users WHERE email='x@example.com'`), undefined);
});

test('sem subscrição não há convites; com plano há quota mensal', async () => {
  const c = await post('/entrevistas', { title: 'T' }, user);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Pergunta?' }, user);
  await post(`/entrevistas/${id}/guardar`, { title: 'T', objective_text: 'O', host_name: 'Zé', guest_name: 'Convidado', guest_email: 'c@example.com', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en' }, user);
  const no = await post(`/entrevistas/${id}/convidar`, {}, user);
  assert.match(decodeURIComponent(no.headers.location as string), /subscrição ativa/);
  assert.equal((await db.one('SELECT collection_status s FROM interviews WHERE id=$1', [id])).s, 'draft');

  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source, interviews_override) VALUES ($1,'starter','active','manual',1)`, [userId]);
  const ok = await post(`/entrevistas/${id}/convidar`, {}, user);
  assert.match(ok.headers.location as string, /ok=/);

  const c2 = await post('/entrevistas', { title: 'T2' }, user);
  const id2 = /entrevistas\/([0-9a-f-]{36})/.exec(c2.headers.location as string)![1];
  await post(`/entrevistas/${id2}/perguntas`, { text: 'Pergunta?' }, user);
  await post(`/entrevistas/${id2}/guardar`, { title: 'T2', objective_text: 'O', host_name: 'Zé', guest_name: 'Outro', guest_email: 'd@example.com', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en' }, user);
  const over = await post(`/entrevistas/${id2}/convidar`, {}, user);
  assert.match(decodeURIComponent(over.headers.location as string), /limite de 1 entrevistas/);
});

test('webhook Stripe: assinatura obrigatória, aplica checkout e é idempotente', async () => {
  await saveSetting(db, 'STRIPE_WEBHOOK_SECRET', 'whsec_test');
  const ev = { id: 'evt_1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: userId, customer: 'cus_1', subscription: 'sub_1', metadata: { plan_id: 'studio' } } } };
  const raw = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  const sig = (secret: string, ts = t) => `t=${ts},v1=${createHmac('sha256', secret).update(`${ts}.${raw}`).digest('hex')}`;
  const send = (h: string) => app.inject({ method: 'POST', url: '/webhooks/stripe', payload: raw, headers: { 'content-type': 'application/json', 'stripe-signature': h } });
  assert.equal((await send('')).statusCode, 400);
  assert.equal((await send(sig('outro-segredo'))).statusCode, 400);
  assert.equal((await send(sig('whsec_test', t - 4000))).statusCode, 400, 'timestamp antigo');
  const ok = await send(sig('whsec_test'));
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().result, 'applied');
  assert.equal((await send(sig('whsec_test'))).json().result, 'duplicate');
  const sub = await db.one('SELECT * FROM subscriptions WHERE user_id=$1', [userId]);
  assert.equal(sub.plan_id, 'studio'); assert.equal(sub.stripe_subscription_id, 'sub_1'); assert.equal(sub.status, 'active'); assert.equal(sub.source, 'stripe');
  const upd = { id: 'evt_2', type: 'customer.subscription.updated', data: { object: { id: 'sub_1', status: 'past_due', cancel_at_period_end: true, current_period_start: 1790000000, current_period_end: 1792600000, metadata: { user_id: userId } } } };
  const raw2 = JSON.stringify(upd);
  await app.inject({ method: 'POST', url: '/webhooks/stripe', payload: raw2, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${raw2}`).digest('hex')}` } });
  const after2 = await db.one('SELECT status, cancel_at_period_end c FROM subscriptions WHERE user_id=$1', [userId]);
  assert.equal(after2.status, 'past_due'); assert.equal(after2.c, true);
  assert.equal(verifyStripeSignature(Buffer.from(raw), undefined, 'x'), false);
});

test('definições: só admin; segredos cifrados em repouso e nunca devolvidos', async () => {
  assert.equal((await get('/admin/definicoes', user)).statusCode, 403);
  assert.equal((await get('/admin/utilizadores', user)).statusCode, 403);
  assert.equal((await get('/admin/definicoes')).statusCode, 302);
  assert.equal((await post('/admin/definicoes', { OPENAI_API_KEY: 'sk-SEGREDO-123456' }, user)).statusCode, 403);
  const secretOpenAi = 'sk-SEGREDO-123456';
  await post('/admin/definicoes', { OPENAI_API_KEY: secretOpenAi, MAILERSEND_API_KEY: 'mlsn.abcdef', MAIL_FROM: 'no-reply@exemplo.pt', MOLONI_CLIENT_ID: 'dev1', MOLONI_PASSWORD: 'pw-moloni-9999', STRIPE_SECRET_KEY: 'sk_test_zzzz1234', signups_open: '1' }, admin);
  assert.equal(S('OPENAI_API_KEY'), secretOpenAi);
  const row = await db.one(`SELECT value_enc FROM settings WHERE key='OPENAI_API_KEY'`);
  assert.ok(!row.value_enc.includes('SEGREDO'), 'cifrado em repouso');
  const pg = await get('/admin/definicoes', admin);
  assert.equal(pg.statusCode, 200);
  assert.ok(!pg.body.includes('SEGREDO-123456'), 'valor completo nunca volta ao browser');
  assert.match(pg.body, /3456/, 'só o fim, mascarado');
  assert.match(pg.body, /Moloni ON/); assert.match(pg.body, /Stripe/); assert.match(pg.body, /MailerSend/);
  assert.ok(!pg.body.includes('pw-moloni-9999'));
  // deixar em branco mantém; '-' apaga
  await post('/admin/definicoes', { OPENAI_API_KEY: '' }, admin);
  assert.equal(S('OPENAI_API_KEY'), secretOpenAi);
  await post('/admin/definicoes', { MOLONI_PASSWORD: '-' }, admin);
  assert.equal(S('MOLONI_PASSWORD'), '');
  assert.ok(SETTING_DEFS.some(d => d.key === 'MOLONI_CLIENT_SECRET'));
  // email usa a definição guardada
  await post('/admin/definicoes', { MAILERSEND_API_KEY: '-' }, admin);
  await flushOutbox(db);
});

test('gestão de utilizadores: criar, desativar (termina sessões), ativar, plano manual', async () => {
  const cr = await post('/admin/utilizadores', { name: 'Maria', email: 'maria@example.com', password: PW, role: 'interviewer', plan_id: 'studio' }, admin);
  assert.match(decodeURIComponent(cr.headers.location as string), /Utilizador criado/);
  const m = await db.one(`SELECT id FROM users WHERE email='maria@example.com'`);
  assert.equal((await db.one('SELECT plan_id, status, source FROM subscriptions WHERE user_id=$1', [m.id])).status, 'comped');
  const login = await post('/entrar', { email: 'maria@example.com', password: PW });
  const mc = `sid=${cookies(login).sid}`;
  assert.equal((await get('/account', mc)).statusCode, 200);
  await post(`/admin/utilizadores/${m.id}/estado`, { active: '0' }, admin);
  assert.equal((await get('/account', mc)).statusCode, 302, 'sessão terminada');
  const blocked = await post('/entrar', { email: 'maria@example.com', password: PW });
  assert.match(decodeURIComponent(blocked.headers.location as string), /deactivated/);
  await post(`/admin/utilizadores/${m.id}/estado`, { active: '1' }, admin);
  assert.ok(cookies(await post('/entrar', { email: 'maria@example.com', password: PW })).sid);
  // não se desativa o último admin nem a própria conta
  const me = await db.one(`SELECT id FROM users WHERE email='admin@example.com'`);
  assert.match(decodeURIComponent((await post(`/admin/utilizadores/${me.id}/estado`, { active: '0' }, admin)).headers.location as string), /própria conta/);
  // alterar subscrição e quota personalizada
  await post(`/admin/utilizadores/${m.id}/subscricao`, { plan_id: 'starter', status: 'active', override: '3', period_end: '2030-01-01' }, admin);
  const s = await db.one('SELECT * FROM subscriptions WHERE user_id=$1', [m.id]);
  assert.equal(s.plan_id, 'starter'); assert.equal(s.interviews_override, 3);
  // redefinir palavra-passe
  await post(`/admin/utilizadores/${m.id}/palavra-passe`, { password: 'nova-palavra-passe-9' }, admin);
  assert.ok(cookies(await post('/entrar', { email: 'maria@example.com', password: 'nova-palavra-passe-9' })).sid);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM audit_events WHERE action LIKE $1', ['admin.%'])).n) > 3, true, 'ações administrativas auditadas');
});

test('signups podem ser fechados pelo admin; planos editáveis', async () => {
  await post('/admin/definicoes', { signups_open: '' }, admin);
  assert.equal((await get('/registar')).statusCode, 404);
  await post('/admin/definicoes', { signups_open: '1' }, admin);
  assert.equal((await get('/registar')).statusCode, 200);
  await post('/admin/planos/starter', { name: 'Starter', price: '12,50', limit: '6', active: '1' }, admin);
  const p = await db.one(`SELECT price_cents, interviews_per_month n FROM plans WHERE id='starter'`);
  assert.equal(p.price_cents, 1250); assert.equal(p.n, 6);
  assert.match((await get('/')).body, /€12\.50/);
});

test('laboratório: só admin, corre a experiência (modo simulado) e mostra o vídeo', async () => {
  const { runOne } = await import('../src/jobs.ts');
  const { handlers } = await import('../src/pipeline.ts');
  assert.equal((await get('/admin/laboratorio', user)).statusCode, 403);
  assert.equal((await post('/admin/laboratorio/lipsync', { text: 'Hi' }, user)).statusCode, 403);
  await saveSetting(db, 'REPLICATE_API_TOKEN', 'r8_test_token_1234');
  const r = await post('/admin/laboratorio/lipsync', { text: 'Hello and welcome.' }, admin);
  assert.match(decodeURIComponent(r.headers.location as string), /iniciada/);
  assert.match(decodeURIComponent((await post('/admin/laboratorio/lipsync', { text: 'x' }, admin)).headers.location as string), /Já há uma experiência/);
  while (await runOne(db, handlers)) { /* */ }
  const job = await db.one(`SELECT * FROM jobs WHERE kind='lipsync_experiment' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(job.state, 'done', job.error ?? '');
  const pg = await get('/admin/laboratorio', admin);
  assert.match(pg.body, /<video/);
  assert.ok(!pg.body.includes('r8_test_token_1234'));
  const v = await get(`/admin/laboratorio/media/${job.result.videoAssetId}`, admin);
  assert.equal(v.statusCode, 200);
  assert.equal(v.rawPayload.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.equal((await get(`/admin/laboratorio/media/${job.result.videoAssetId}`, user)).statusCode, 403);
  assert.match((await get('/admin/definicoes', admin)).body, /Replicate/);
});

test('laboratório comparativo: só modelos com chave, resultados lado a lado, URLs assinados', async () => {
  const { runOne } = await import('../src/jobs.ts');
  const { handlers } = await import('../src/pipeline.ts');
  const { signedAssetUrl } = await import('../src/talking.ts');
  assert.equal((await post('/admin/laboratorio/comparar', { p_omnihuman: '1' }, user)).statusCode, 403);
  const r = await post('/admin/laboratorio/comparar', { text: 'Hello.', p_omnihuman: '1', p_veo: '1', p_heygen: '1' }, admin);
  assert.match(decodeURIComponent(r.headers.location as string), /iniciada/);
  while (await runOne(db, handlers)) { /* */ }
  const job = await db.one(`SELECT * FROM jobs WHERE kind='talking_compare' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(job.state, 'done', job.error ?? '');
  assert.deepEqual(job.result.results.map((x: any) => x.provider), ['omnihuman', 'heygen', 'veo']);
  assert.ok(job.result.results.every((x: any) => x.videoAssetId));
  const pg = await get('/admin/laboratorio', admin);
  assert.match(pg.body, /OmniHuman 1\.5/); assert.match(pg.body, /voz do próprio modelo/);
  // URL assinado: válido para os ficheiros do laboratório; adulterado ou expirado é recusado
  const url = new URL(signedAssetUrl(job.result.portraitAssetId));
  assert.equal((await get(url.pathname)).statusCode, 200);
  assert.equal((await get(url.pathname.replace(/.$/, c => (c === 'A' ? 'B' : 'A')))).statusCode, 404);
  const parts = url.pathname.split('/');
  assert.equal((await get(`/m/${parts[2]}/1000/${parts[4]}`)).statusCode, 404, 'expirado');
  const other = await db.one(`SELECT id FROM assets WHERE kind='lab_video' LIMIT 1`);
  assert.equal((await get(new URL(signedAssetUrl(other.id)).pathname)).statusCode, 404, 'só retrato e áudio do laboratório');
});

test('definições Google: conta de serviço do Vertex validada, cifrada e nunca mostrada; nível Fast/Lite', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const pk = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const sa = JSON.stringify({ type: 'service_account', project_id: 'projeto-teste-123', private_key_id: 'kid1', private_key: pk, client_email: 'veo@projeto-teste-123.iam.gserviceaccount.com' }, null, 2);
  const body = pk.split('\n')[3];
  assert.equal((await post('/admin/definicoes', { VERTEX_SA_JSON: sa }, user)).statusCode, 403);
  // JSON inválido: nada é guardado e a mensagem não cita o texto colado
  const bad = await post('/admin/definicoes', { VERTEX_SA_JSON: sa.slice(0, -2), VEO_TIER: 'lite' }, admin);
  const msg = decodeURIComponent(bad.headers.location as string);
  assert.match(msg, /Nada foi guardado: A conta de serviço não é um JSON válido/); assert.ok(!msg.includes(body));
  assert.equal(S('VERTEX_SA_JSON'), ''); assert.equal(S('VEO_TIER'), '', 'nem o resto do formulário');
  assert.match(decodeURIComponent((await post('/admin/definicoes', { VEO_TIER: 'pro' }, admin)).headers.location as string), /Valor inválido em «Modelo do Google Veo»/);
  assert.match(decodeURIComponent((await post('/admin/definicoes', { VERTEX_LOCATION: 'evil.com/x' }, admin)).headers.location as string), /Região do Vertex AI inválida/);
  // válido
  await post('/admin/definicoes', { VERTEX_SA_JSON: sa, VEO_TIER: 'lite', VERTEX_LOCATION: '' }, admin);
  const row = await db.one(`SELECT value_enc FROM settings WHERE key='VERTEX_SA_JSON'`);
  assert.ok(!row.value_enc.includes('PRIVATE') && !row.value_enc.includes('veo@'), 'cifrada em repouso');
  assert.equal(JSON.parse(S('VERTEX_SA_JSON')).private_key, pk);
  assert.equal(S('VEO_TIER'), 'lite');
  const pg = await get('/admin/definicoes', admin);
  assert.ok(!pg.body.includes(body) && !pg.body.includes('PRIVATE KEY'), 'a chave nunca volta ao browser');
  assert.match(pg.body, /guardada: veo@projeto-teste-123\.iam\.gserviceaccount\.com · projeto projeto-teste-123/);
  assert.match(pg.body, /<select id="f_VEO_TIER" name="VEO_TIER"><option value="fast" >Veo 3\.1 Fast[^<]*<\/option><option value="lite" selected>/);
  assert.match(pg.body, /placeholder="us-central1"/);
  // «Guardar e testar»: token e consulta sem gerar vídeo (fetch falso: nada sai para a Google)
  const real = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (u: any) => { urls.push(String(u)); return String(u).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'ya29.t', expires_in: 3600 })) : new Response(JSON.stringify({ error: { code: 404, message: 'Operation not found.' } }), { status: 404 }); }) as any;
  try {
    const r = await post('/admin/definicoes/testar/Google', { VEO_TIER: 'lite' }, admin);
    assert.match(decodeURIComponent(r.headers.location as string), /Vertex AI.*Google Veo 3\.1 Lite \(veo-3\.1-lite-generate-001\) confirmado, sem gerar vídeo/);
  } finally { globalThis.fetch = real; }
  assert.deepEqual(urls.map(u => u.replace(/\/projects\/.*:/, '/…:')), ['https://oauth2.googleapis.com/token', 'https://us-central1-aiplatform.googleapis.com/v1/…:fetchPredictOperation']);
  // apagar: volta à Gemini API (ou a nada)
  await post('/admin/definicoes', { VERTEX_SA_JSON: '-', VEO_TIER: 'fast' }, admin);
  assert.equal(S('VERTEX_SA_JSON'), ''); assert.equal(S('VEO_TIER'), 'fast');
});

test('laboratório: só o Veo 3.1 Fast e o Lite vêm marcados; os outros ficam disponíveis, desmarcados', async () => {
  const pg = await get('/admin/laboratorio', admin);
  for (const id of ['veo', 'veo-lite']) assert.match(pg.body, new RegExp(`name="p_${id}" value="1" checked>`), id);
  for (const id of ['omnihuman', 'fabric', 'infinitalk', 'heygen']) assert.match(pg.body, new RegExp(`name="p_${id}" value="1" >`), `${id} desmarcado mas disponível`);
  assert.match(pg.body, /<strong>Google Veo 3\.1 Fast<\/strong> — Google \((Gemini API|Vertex AI): veo-3\.1-fast-generate-(preview|001)\) · ~\$0\.10\/s/);
  assert.match(pg.body, /<strong>Google Veo 3\.1 Lite<\/strong>[^·]*· ~\$0\.05\/s/);
  assert.doesNotMatch(pg.body, /Flow/);
});

// ---------- Subscrição só com imagens: IVA, empresa vendedora, Stripe (falsa, sem rede) e lista «por faturar» ----------
const { vatFor, normNif, withVat, EU_STANDARD_RATES } = await import('../src/vat.ts');
const { applyStripeEvent } = await import('../src/billing.ts');

/** NIF fictício com o dígito de controlo certo (só para testes). */
const nifOf = (p8: string) => { const sum = [...p8].reduce((s, d, i) => s + Number(d) * (9 - i), 0); return p8 + (sum % 11 < 2 ? 0 : 11 - (sum % 11)); };
const SELLER_NIF = nifOf('50000000'), CLIENT_NIF = nifOf('51234567');
const msg = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));

/**
 * Sem rede nesta secção: a partir do primeiro teste, qualquer pedido falha, a não ser à Stripe falsa ativa
 * (os webhooks invoice.paid consultam a Stripe antes da transação).
 */
const realFetch = globalThis.fetch;
let activeFake: ((u: any, init: any) => Promise<Response>) | null = null;
const guardNetwork = () => { globalThis.fetch = ((u: any, init: any) => (activeFake ? activeFake(u, init) : Promise.reject(new Error(`rede proibida nos testes: ${String(u)}`)))) as any; };
after(() => { globalThis.fetch = realFetch; });

/** Stripe falsa: guarda cada pedido e responde como a API; qualquer outro anfitrião faz falhar o teste. */
type Call = { method: string; path: string; params: URLSearchParams; idem?: string };
function fakeStripe(over: (c: Call) => any = () => undefined) {
  const calls: Call[] = [];
  const products = new Set<string>(), customers = new Set<string>();
  const state = { subStatus: 'active', taxIdStatus: 'pending', accountName: 'Empresa Vendedora de Teste', n: 0 };
  activeFake = (async (u: any, init: any = {}) => {
    const url = new URL(String(u));
    if (url.hostname !== 'api.stripe.com') throw new Error(`rede proibida nos testes: ${url.hostname}`);
    const method = init.method ?? 'GET';
    const c: Call = { method, path: url.pathname.replace(/^\/v1\//, ''), params: new URLSearchParams(method === 'GET' ? url.search : String(init.body ?? '')), idem: init.headers?.['Idempotency-Key'] };
    calls.push(c);
    const reply = (body: any, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const o = over(c);
    if (o !== undefined) return o instanceof Response ? o : reply(o);
    const p = c.path, id = () => `${++state.n}`;
    if (p === 'tax_rates') return reply({ id: `txr_${c.params.get('country')}${c.params.get('percentage')}_${id()}` });
    if (p === 'products') { products.add(c.params.get('id')!); return reply({ id: c.params.get('id') }); }
    if (p.startsWith('products/')) return products.has(p.slice(9)) ? reply({ id: p.slice(9) }) : reply({ error: { message: 'No such product', code: 'resource_missing' } }, 404);
    if (p === 'customers') { const cid = `cus_${id()}`; customers.add(cid); return reply({ id: cid }); }
    if (/^customers\/[^/]+\/tax_ids$/.test(p)) return reply({ id: 'txi_1', value: c.params.get('value'), verification: { status: state.taxIdStatus } });
    if (/^customers\/[^/]+\/tax_ids\/[^/]+$/.test(p)) return reply({ id: 'txi_1', value: 'ESB12345678', verification: { status: state.taxIdStatus } });
    if (p.startsWith('customers/')) return customers.has(p.slice(10)) || p.includes('?') ? reply({ id: p.slice(10) }) : reply({ error: { message: 'No such customer', code: 'resource_missing' } }, 404);
    if (p === 'checkout/sessions') return reply({ id: `cs_${id()}`, url: `https://checkout.stripe.com/c/pay/cs_${state.n}` });
    if (p.startsWith('subscriptions/')) return reply({ id: p.slice(14), status: method === 'DELETE' ? 'canceled' : state.subStatus, items: { data: [{ id: 'si_1' }] }, default_payment_method: { card: { country: 'PT' } } });
    if (p === 'balance') return reply({ livemode: false });
    if (p === 'account') return reply({ id: 'acct_1', settings: { dashboard: { display_name: state.accountName } } });
    return reply({ error: { message: `rota não simulada: ${method} ${p}` } }, 400);
  });
  return { calls, state, find: (m: string, p: string | RegExp) => calls.filter(c => c.method === m && (typeof p === 'string' ? c.path === p : p.test(c.path))), restore: () => { activeFake = null; } };
}
/** Evento assinado como a Stripe o envia (segredo do teste do webhook). */
const sendEvent = (ev: any) => {
  const raw = JSON.stringify(ev), t = Math.floor(Date.now() / 1000);
  return app.inject({ method: 'POST', url: '/webhooks/stripe', payload: raw, headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${raw}`).digest('hex')}` } });
};
const register = async (name: string, email: string) => {
  const r = await post('/registar', { name, email, password: PW, terms: 1 });
  return { cookie: `sid=${cookies(r).sid}`, id: (await db.one('SELECT id FROM users WHERE email=$1', [email])).id as string };
};
let biz = { cookie: '', id: '' };

test('IVA (função pura): Portugal pela morada, autoliquidação na UE, OSS e recusa fora da UE', () => {
  guardNetwork();
  const pt = { country: 'PT', regime: 'registered', vatNumber: `PT${SELLER_NIF}`, ossActive: false };
  const r = (c: any, s: any = pt) => { const d = vatFor(s, c); return d.ok ? [d.regime, d.rate, d.country] : [d.reason]; };
  // consumidor português: continente 23%, Madeira 22% (Porto Santo incluído), Açores 16%
  assert.deepEqual(r({ country: 'PT', kind: 'consumer', postalCode: '1000-001' }), ['domestic', 23, 'PT']);
  assert.deepEqual(r({ country: 'PT', kind: 'consumer', postalCode: '8999-999' }), ['domestic', 23, 'PT']);
  assert.deepEqual(r({ country: 'PT', kind: 'consumer', postalCode: '9000-100' }), ['domestic', 22, 'PT']);
  assert.deepEqual(r({ country: 'PT', kind: 'consumer', postalCode: '9400-150' }), ['domestic', 22, 'PT']);
  assert.deepEqual(r({ country: 'PT', kind: 'consumer', postalCode: '9500 001' }), ['domestic', 16, 'PT']);
  assert.deepEqual(r({ country: 'PT', kind: 'consumer', postalCode: '9980-024' }), ['domestic', 16, 'PT']);
  // empresa portuguesa: pela sede
  assert.deepEqual(r({ country: 'PT', kind: 'business', postalCode: '9700-001' }), ['domestic', 16, 'PT']);
  assert.equal((vatFor(pt, { country: 'PT', kind: 'business', postalCode: '1000-001' }) as any).asConsumer, false);
  // empresa de outro país da UE com número de IVA verificado: 0%, autoliquidação, com a menção
  const rc: any = vatFor(pt, { country: 'ES', kind: 'business', vatNumber: 'ESB12345678', vatVerified: true, postalCode: '28001' });
  assert.deepEqual([rc.regime, rc.rate, rc.country], ['reverse_charge', 0, 'ES']);
  assert.match(rc.note.pt, /IVA – autoliquidação \(art\. 6\.º, n\.º 6, al\. a\) do CIVA e art\. 196\.º da Diretiva 2006\/112\/CE\)/);
  // sem verificação (ou com número de outro país) é tratada como consumidor
  assert.deepEqual(r({ country: 'ES', kind: 'business', vatNumber: 'ESB12345678', vatVerified: false, postalCode: '28001' }), ['eu_b2c_origin', 23, 'PT']);
  assert.deepEqual(r({ country: 'ES', kind: 'business', vatNumber: 'FR12345678901', vatVerified: true, postalCode: '28001' }), ['eu_b2c_origin', 23, 'PT']);
  // consumidor de outro país da UE: taxa portuguesa com o OSS desligado; a do país dele com o OSS ligado
  assert.deepEqual(r({ country: 'DE', kind: 'consumer', postalCode: '10115' }), ['eu_b2c_origin', 23, 'PT']);
  assert.match((vatFor(pt, { country: 'DE', kind: 'consumer', postalCode: '10115' }) as any).note.pt, /art\. 6\.º-A do CIVA/);
  assert.deepEqual(r({ country: 'DE', kind: 'consumer', postalCode: '10115' }, { ...pt, ossActive: true }), ['oss', 19, 'DE']);
  assert.deepEqual(r({ country: 'FI', kind: 'consumer', postalCode: '00100' }, { ...pt, ossActive: true }), ['oss', 25.5, 'FI']);
  // fora da UE (e fora do território de IVA da UE): recusa com «contacte-nos»
  const out: any = vatFor(pt, { country: 'US', kind: 'business', postalCode: '10001' });
  assert.equal(out.ok, false); assert.equal(out.reason, 'outside_eu'); assert.match(out.message.pt, /Contacte-nos/);
  assert.deepEqual(r({ country: 'ES', kind: 'consumer', postalCode: '35001' }), ['outside_eu'], 'Canárias');
  assert.deepEqual(r({ country: 'CH', kind: 'consumer', postalCode: '8001' }), ['outside_eu']);
  // vendedor sem NIF válido: não vende
  assert.deepEqual(r({ country: 'PT', kind: 'consumer', postalCode: '1000-001' }, { ...pt, vatNumber: '' }), ['seller_regime']);
  // taxas normais da UE (portal Your Europe), NIF e arredondamento
  assert.equal(Object.keys(EU_STANDARD_RATES).length, 27);
  assert.deepEqual([EU_STANDARD_RATES.PT, EU_STANDARD_RATES.EE, EU_STANDARD_RATES.RO, EU_STANDARD_RATES.SK, EU_STANDARD_RATES.LU], [23, 24, 21, 23, 17]);
  assert.equal(normNif(`PT ${SELLER_NIF}`), SELLER_NIF); assert.equal(normNif('123456780'), null); assert.equal(normNif(SELLER_NIF.slice(0, 8) + ((Number(SELLER_NIF[8]) + 1) % 10)), null);
  assert.deepEqual([withVat(1900, 23), withVat(4900, 23), withVat(1900, 22), withVat(1900, 16)], [2337, 6027, 2318, 2204]);
});

test('planos Start e Pro (só imagens) à venda; os antigos inativos, mas as subscrições antigas mantêm-se', async () => {
  const plans = await db.query('SELECT id, name, price_cents, interviews_per_month, active FROM plans ORDER BY sort');
  const by = Object.fromEntries(plans.map((p: any) => [p.id, p]));
  assert.deepEqual([by.start.price_cents, by.start.interviews_per_month, by.start.active], [1900, 3, true]);
  assert.deepEqual([by.pro.price_cents, by.pro.interviews_per_month, by.pro.active], [4900, 10, true]);
  assert.equal(by.studio.active, false);
  // o teste anterior reativou o starter pelas Definições; volta a ficar inativo
  await post('/admin/planos/starter', { name: 'Starter', price: '10', limit: '5' }, admin);
  const pg = await get('/admin/definicoes', admin);
  assert.match(pg.body, /value="19\.00" aria-label="Preço mensal sem IVA \(EUR\)" style="width:110px">€\/mês \+ IVA/);
  assert.match(pg.body, /Planos inativos deixam de ser vendidos, mas quem já os tem continua com eles/);
  const home = await get('/');
  // na apresentação comercial, o preço sem menção ao IVA (a taxa depende do país); o preço final aparece antes de pagar
  assert.match(home.body, /€19<span class="hint"> \/ month<\/span>/); assert.match(home.body, /€49<span class="hint"> \/ month/);
  assert.doesNotMatch(home.body, /\+ VAT|incl\. \d+% VAT|com IVA incluído|mainland Portugal/);
  assert.match(home.body, /Start from €19 \/ month/);
  assert.match(home.body, /VAT, where it applies, depends on your country; the final price is always shown before you pay\./);
  assert.match(home.body, /AI animation is never part of a plan: each animated production is quoted before anything is generated and paid with prepaid credits/);
  assert.match(home.body, /AI video \(optional, quoted separately\)/);
  // a landing mostra preços e a vendedora: com o acesso ao Livro de Reclamações Eletrónico (o rodapé fica só com a Certif)
  assert.match(home.body, /Sold by [^<]+\. <a href="\/termos">Terms of sale · Termos e condições<\/a> · (<a href="https:\/\/[^"]+" rel="noopener" target="_blank">)?Livro de Reclamações Eletrónico/);
  assert.doesNotMatch(home.body, /€12\.50|€10<|Starter/);
  // quem ainda tem o Studio (subscrição manual do teste anterior) continua com ele
  const m = await db.one(`SELECT s.plan_id, s.status FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE u.email='ze@example.com'`);
  assert.equal(m.plan_id, 'studio'); assert.equal(m.status, 'past_due');
});

test('empresa vendedora: por omissão a Telecert Consultoria Lda; sem denominação, NIF e morada o checkout fica bloqueado, com aviso no administrador', async () => {
  await saveSetting(db, 'SIGNUPS_OPEN', '1'); // o teste do Google gravou o formulário sem esta caixa
  biz = await register('Cliente Empresa', 'empresa@example.com');
  // dados de faturação: empresa portuguesa com NIF, sede na Madeira
  assert.match(msg(await post('/billing/profile', { kind: 'business', name: 'Cliente Empresa, Lda.', country: 'PT', tax_id: '', address: 'Rua A', postal_code: '9000-100', city: 'Funchal' }, biz.cookie)), /must give their NIF/);
  assert.match(msg(await post('/billing/profile', { kind: 'business', name: 'Cliente Empresa, Lda.', country: 'PT', tax_id: '123456780', address: 'Rua A', postal_code: '9000-100', city: 'Funchal' }, biz.cookie)), /Invalid Portuguese NIF/);
  assert.match(msg(await post('/billing/profile', { kind: 'business', name: 'Cliente Empresa, Lda.', country: 'PT', tax_id: `PT ${CLIENT_NIF}`, address: 'Rua A', postal_code: '9000100', city: 'Funchal' }, biz.cookie)), /Billing details saved/);
  const bp = await db.one('SELECT * FROM billing_profiles WHERE user_id=$1', [biz.id]);
  assert.deepEqual([bp.kind, bp.nif, bp.postal_code, bp.country], ['business', CLIENT_NIF, '9000-100', 'PT']);
  // por omissão, os dados da Telecert Consultoria Lda (o NIF sem o prefixo PT); o email de apoio dos testes é o de exemplo,
  // que nunca serve de contacto legal: falta só o email para vender a consumidores
  const { seller } = await import('../src/legal.ts');
  const s0 = seller();
  assert.deepEqual([s0.name, s0.nif, s0.address, s0.complaintsUrl, s0.email], ['Telecert Consultoria Lda', '514907274', 'Avenida 5 de Outubro, 38A, 8000-077 Faro', 'https://www.livroreclamacoes.pt/Inicio/', '']);
  assert.ok(s0.canSell); assert.deepEqual(s0.missingConsumer, ['email de contacto']);
  const pg0 = await get('/admin/definicoes', admin);
  assert.match(pg0.body, /<input id="f_SELLER_NAME" name="SELLER_NAME"[^>]+value="Telecert Consultoria Lda">/);
  assert.match(pg0.body, /<input id="f_SELLER_NIF" name="SELLER_NIF"[^>]+value="514907274">/);
  assert.match(pg0.body, /<input id="f_SELLER_ADDRESS" name="SELLER_ADDRESS"[^>]+value="Avenida 5 de Outubro, 38A, 8000-077 Faro">/);
  assert.match(pg0.body, /<input id="f_SELLER_COMPLAINTS_URL" name="SELLER_COMPLAINTS_URL"[^>]+value="https:\/\/www\.livroreclamacoes\.pt\/Inicio\/">/);
  assert.match(pg0.body, /Denominação social completa <span class="hint">· valor por omissão<\/span>/);
  assert.match(pg0.body, /venda a consumidores bloqueada — falta email de contacto\./);
  assert.doesNotMatch(pg0.body, /pagamentos em linha suspensos/);
  // nas páginas de compra (não no rodapé, que fica só com a entidade gestora)
  const acc0 = await get('/account', biz.cookie);
  assert.match(acc0.body, /Seller · <span lang="pt-PT">Vendedora<\/span>: Telecert Consultoria Lda · NIF 514907274 · Avenida 5 de Outubro, 38A, 8000-077 Faro · <a href="\/termos">/);
  assert.match(acc0.body, /<footer>[\s\S]*is owned and operated by Certif Int Association OÜ/);
  assert.doesNotMatch(acc0.body, /<footer>[\s\S]*(Telecert|Sold by|Comercializado)[\s\S]*<\/footer>/);
  assert.match((await get('/termos')).body, /Telecert Consultoria Lda \(Telecert\)<br>NIF 514907274 · Sede: Avenida 5 de Outubro, 38A, 8000-077 Faro, Portugal/);
  // sem denominação, NIF e morada (aqui, os valores por omissão tirados por variáveis de ambiente vazias): pagamentos
  // suspensos, nenhum pedido à Stripe
  const core = ['SELLER_NAME', 'SELLER_NIF', 'SELLER_ADDRESS'];
  for (const k of core) process.env[k] = '';
  try {
    const fs = fakeStripe();
    try {
      const r = await post('/subscribe/start', { terms: '1' }, biz.cookie);
      assert.match(msg(r), /Online payments are paused until the seller’s details are complete[\s\S]*Os pagamentos em linha estão suspensos/);
      assert.equal(fs.calls.length, 0);
    } finally { fs.restore(); }
    const acc = await get('/account', biz.cookie);
    assert.match(acc.body, /<button class="accent" disabled>Subscribe and pay €19 \+ VAT \/ month<\/button>/);
    assert.match(acc.body, /€23\.37 incl\. 23% VAT · <span lang="pt-PT">consumidores: 23,37 €\/mês com IVA incluído/, 'sem vendedora pronta, o preço genérico');
    const pg = await get('/admin/definicoes', admin);
    assert.match(pg.body, /Empresa vendedora \(definições globais\): pagamentos em linha suspensos para quem não é administrador — falta denominação social completa, NIF, morada da sede\./);
    assert.match((await get('/admin/faturacao', admin)).body, /pagamentos em linha suspensos/);
  } finally { for (const k of core) delete process.env[k]; }
  const pg = await get('/admin/definicoes', admin);
  assert.match(pg.body, /<input id="f_SELLER_TRADE_NAME" name="SELLER_TRADE_NAME"[^>]+value="Telecert">/);
  assert.match(pg.body, /<option value="PT" selected>Portugal \(PT\)<\/option>/);
  assert.match(pg.body, /<option value="registered" selected>Registada para IVA/);
  assert.match(pg.body, /A Certif Int Association OÜ é a entidade gestora da plataforma e não vende/);
  // validação: NIF com dígito de controlo e Livro de Reclamações por https
  assert.match(msg(await post('/admin/definicoes', { SELLER_NIF: '123456780' }, admin)), /Nada foi guardado: NIF da empresa vendedora inválido/);
  assert.match(msg(await post('/admin/definicoes', { SELLER_COMPLAINTS_URL: 'http://exemplo' }, admin)), /tem de começar por https/);
  await post('/admin/definicoes', { SELLER_NAME: 'Empresa Vendedora de Teste, Lda.', SELLER_NIF: `PT ${SELLER_NIF}`, SELLER_ADDRESS: 'Rua de Teste, 1, 1000-001 Lisboa', SELLER_COUNTRY: 'PT', SELLER_VAT_REGIME: 'registered', signups_open: '1' }, admin);
  assert.equal(S('SELLER_NIF'), SELLER_NIF);
  // empresas já podem pagar; consumidores não (falta o email)
  const pg2 = await get('/admin/definicoes', admin);
  assert.match(pg2.body, /venda a consumidores bloqueada — falta email de contacto\./);
  assert.doesNotMatch(pg2.body, /pagamentos em linha suspensos/);
  const acc2 = await get('/account', biz.cookie);
  assert.match(acc2.body, /<button class="accent" >Subscribe and pay €19 \+ VAT \/ month<\/button>/);
  assert.match(acc2.body, /€23\.18 with 22% VAT/, 'sede na Madeira');
});

test('checkout: só cartão, morada obrigatória, NIF e taxa de IVA manual criada uma vez e reutilizada (Stripe falsa)', async () => {
  const fs = fakeStripe();
  try {
    assert.match(msg(await post('/subscribe/start', {}, biz.cookie)), /accept the terms of sale/);
    assert.equal(fs.calls.length, 0);
    const r = await post('/subscribe/start', { terms: '1' }, biz.cookie);
    assert.equal(r.statusCode, 303);
    assert.match(r.headers.location as string, /^https:\/\/checkout\.stripe\.com\//);
    const [tr] = fs.find('POST', 'tax_rates');
    assert.deepEqual([tr.params.get('percentage'), tr.params.get('inclusive'), tr.params.get('country'), tr.params.get('tax_type'), tr.params.get('display_name')], ['22', 'false', 'PT', 'vat', 'IVA']);
    assert.match(tr.idem!, /^quietinterview:tax_rate:[0-9a-f]{16}:PT:22$/);
    assert.equal(fs.find('POST', 'products').length, 1, 'produto criado com id fixo');
    const [cs] = fs.find('POST', 'checkout/sessions');
    const p = Object.fromEntries(cs.params);
    assert.equal(p.mode, 'subscription'); assert.equal(p['payment_method_types[0]'], 'card');
    assert.equal(p.billing_address_collection, 'required'); assert.equal(p['tax_id_collection[enabled]'], 'true');
    assert.equal(p['customer_update[address]'], 'auto'); assert.equal(p['customer_update[name]'], 'auto');
    assert.equal(p['line_items[0][price_data][unit_amount]'], '1900'); assert.equal(p['line_items[0][price_data][tax_behavior]'], 'exclusive');
    assert.equal(p['line_items[0][price_data][recurring][interval]'], 'month');
    assert.match(p['line_items[0][tax_rates][0]'], /^txr_PT22_/);
    assert.equal(p['metadata[app]'], 'quietinterview'); assert.equal(p['metadata[vat_regime]'], 'domestic'); assert.equal(p['metadata[vat_rate]'], '22');
    assert.equal(p['metadata[seller_nif]'], SELLER_NIF); assert.equal(p['subscription_data[metadata][plan_id]'], 'start'); assert.equal(p['subscription_data[metadata][app]'], 'quietinterview');
    assert.equal(p.client_reference_id, biz.id);
    assert.ok(!('locale' in p), 'empresas: Checkout na língua do navegador');
    // a mesma taxa serve à segunda: nenhuma taxa nova na Stripe
    await post('/subscribe/start', { terms: '1' }, biz.cookie);
    assert.equal(fs.find('POST', 'tax_rates').length, 1);
    assert.equal(fs.find('POST', 'customers').length, 1, 'o mesmo cliente Stripe');
    assert.match(S('STRIPE_TAX_RATES'), /"PT:22":"txr_PT22_/);
    const a = await db.one(`SELECT meta FROM audit_events WHERE action='billing.checkout_started' ORDER BY created_at DESC LIMIT 1`);
    assert.equal(a.meta.terms, '2026-10-21'); assert.equal(a.meta.regime, 'domestic');
    assert.ok((await db.one('SELECT last_checkout_ip FROM billing_profiles WHERE user_id=$1', [biz.id])).last_checkout_ip, 'IP guardado como prova');
  } finally { fs.restore(); }
});

test('mudar de plano altera a subscrição que existe (nunca abre outra) e os eventos da antiga são ignorados', async () => {
  const done = await sendEvent({ id: 'evt_bz1', type: 'checkout.session.completed', data: { object: { id: 'cs_bz', mode: 'subscription', client_reference_id: biz.id, customer: 'cus_bz', subscription: 'sub_A', customer_details: { address: { country: 'PT', postal_code: '9000-100' } }, metadata: { app: 'quietinterview', user_id: biz.id, plan_id: 'start', customer_kind: 'business', customer_country: 'PT', vat_regime: 'domestic', vat_rate: '22', vat_country: 'PT' } } } });
  assert.equal(done.json().result, 'applied');
  let sub = await db.one('SELECT * FROM subscriptions WHERE user_id=$1', [biz.id]);
  assert.deepEqual([sub.plan_id, sub.status, sub.stripe_subscription_id, sub.vat.rate], ['start', 'active', 'sub_A', 22]);
  assert.ok(sub.contract_started_at);
  const fs = fakeStripe();
  try {
    assert.match(msg(await post('/subscribe/start', { terms: '1' }, biz.cookie)), /already on this plan/);
    const r = await post('/subscribe/pro', { terms: '1' }, biz.cookie);
    assert.match(msg(r), /Plan changed to Pro\. The prorated difference was charged now/);
    assert.equal(fs.find('POST', 'checkout/sessions').length, 0, 'nenhum Checkout novo');
    const [up] = fs.find('POST', 'subscriptions/sub_A');
    const p = Object.fromEntries(up.params);
    assert.equal(p['items[0][id]'], 'si_1'); assert.equal(p['items[0][price_data][unit_amount]'], '4900');
    assert.match(p['items[0][tax_rates][0]'], /^txr_PT22_/);
    assert.equal(p.proration_behavior, 'always_invoice'); assert.equal(p.payment_behavior, 'error_if_incomplete'); assert.equal(p['metadata[plan_id]'], 'pro');
    sub = await db.one('SELECT * FROM subscriptions WHERE user_id=$1', [biz.id]);
    assert.deepEqual([sub.plan_id, sub.stripe_subscription_id], ['pro', 'sub_A']);
    // pagamento em atraso na Stripe: não muda; pede para atualizar o cartão
    fs.state.subStatus = 'past_due';
    assert.match(msg(await post('/subscribe/start', { terms: '1' }, biz.cookie)), /last payment failed/);
    assert.equal(fs.find('POST', 'subscriptions/sub_A').length, 1);
  } finally { fs.restore(); }
  // eventos de uma subscrição antiga (ou duplicada) não cancelam nem substituem a atual
  assert.equal((await sendEvent({ id: 'evt_old1', type: 'customer.subscription.deleted', data: { object: { id: 'sub_OLD', status: 'canceled', metadata: { app: 'quietinterview', user_id: biz.id, plan_id: 'start' } } } })).json().result, 'ignored');
  assert.equal((await sendEvent({ id: 'evt_old2', type: 'customer.subscription.updated', data: { object: { id: 'sub_OLD', status: 'active', metadata: { app: 'quietinterview', user_id: biz.id, plan_id: 'start' } } } })).json().result, 'ignored');
  sub = await db.one('SELECT * FROM subscriptions WHERE user_id=$1', [biz.id]);
  assert.deepEqual([sub.plan_id, sub.status, sub.stripe_subscription_id], ['pro', 'active', 'sub_A']);
  // a atual continua a receber os seus eventos
  assert.equal((await sendEvent({ id: 'evt_cur1', type: 'customer.subscription.updated', data: { object: { id: 'sub_A', status: 'active', cancel_at_period_end: false, current_period_start: 1790000000, current_period_end: 1792600000, metadata: { app: 'quietinterview', user_id: biz.id, plan_id: 'pro' } } } })).json().result, 'applied');
});

test('webhook: payment_events na mesma transação do efeito; sessões de outro portal ignoradas', async () => {
  // o efeito falha: o evento não fica marcado e o reenvio da Stripe aplica-o
  const ev = { id: 'evt_atom', type: 'customer.subscription.updated', data: { object: { id: 'sub_A', status: 'active', cancel_at_period_end: true, metadata: { app: 'quietinterview', user_id: biz.id, plan_id: 'pro' } } } };
  const failing = { ...db, tx: (fn: any) => db.tx((t: any) => fn({ ...t, query: (sql: string, p?: any[]) => (/^UPDATE subscriptions/.test(sql.trim()) ? Promise.reject(new Error('falha simulada')) : t.query(sql, p)) })) };
  await assert.rejects(applyStripeEvent(failing, ev), /falha simulada/);
  assert.equal(await db.one(`SELECT 1 FROM payment_events WHERE id='evt_atom'`), undefined);
  assert.equal((await db.one('SELECT cancel_at_period_end c FROM subscriptions WHERE user_id=$1', [biz.id])).c, false);
  assert.equal(await applyStripeEvent(db, ev), 'applied');
  assert.equal((await db.one('SELECT cancel_at_period_end c FROM subscriptions WHERE user_id=$1', [biz.id])).c, true);
  assert.equal(await applyStripeEvent(db, ev), 'duplicate');
  // Checkout de outro portal da mesma conta Stripe (metadata.app diferente), ou sem app e com um plano que não é nosso
  const other = await sendEvent({ id: 'evt_other', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: biz.id, subscription: 'sub_X', metadata: { app: 'outro-portal', plan_id: 'start' } } } });
  assert.equal(other.json().result, 'ignored');
  assert.equal((await sendEvent({ id: 'evt_other2', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: biz.id, subscription: 'sub_Y', metadata: { plan_id: 'curso-de-gas' } } } })).json().result, 'ignored');
  assert.equal((await db.one('SELECT stripe_subscription_id s FROM subscriptions WHERE user_id=$1', [biz.id])).s, 'sub_A');
  await sendEvent({ id: 'evt_cur2', type: 'customer.subscription.updated', data: { object: { id: 'sub_A', status: 'active', cancel_at_period_end: false, metadata: { app: 'quietinterview', user_id: biz.id, plan_id: 'pro' } } } });
});

test('invoice.paid entra na lista «por faturar» com o IVA e as provas; o administrador regista a fatura do Moloni', async () => {
  const inv = (id: string, extra: any = {}) => ({ id, type: 'invoice.paid', data: { object: {
    id: `in_${id}`, number: `QI-${id}`, customer: 'cus_bz', total: 5978, total_excluding_tax: 4900, currency: 'eur', billing_reason: 'subscription_cycle',
    customer_name: 'Cliente Empresa, Lda.', customer_address: { country: 'PT', postal_code: '9000-100', city: 'Funchal', line1: 'Rua A' }, customer_tax_ids: [{ type: 'eu_vat', value: `PT${CLIENT_NIF}` }],
    status_transitions: { paid_at: 1792600000 }, lines: { data: [{ period: { start: 1792600000, end: 1795200000 } }] },
    parent: { subscription_details: { subscription: 'sub_A', metadata: { app: 'quietinterview', user_id: biz.id, plan_id: 'pro', customer_kind: 'business', customer_country: 'PT', vat_regime: 'domestic', vat_rate: '22', vat_country: 'PT', seller_nif: SELLER_NIF, terms_version: '2026-10-21' } } },
    ...extra } } });
  const fs = fakeStripe();
  try {
  assert.equal((await sendEvent(inv('evt_inv1'))).json().result, 'applied');
  assert.equal((await sendEvent(inv('evt_inv1'))).json().result, 'duplicate');
  assert.ok(fs.find('GET', 'subscriptions/sub_A').length >= 1, 'país do cartão consultado antes da transação');
  const row = await db.one(`SELECT * FROM invoice_queue WHERE stripe_ref='in_evt_inv1'`);
  assert.deepEqual([row.status, row.net_cents, row.vat_cents, row.total_cents, Number(row.vat_rate), row.vat_regime, row.vat_country, row.customer_kind], ['pending', 4900, 1078, 5978, 22, 'domestic', 'PT', 'business']);
  assert.deepEqual([row.evidence.billingCountry, row.evidence.cardCountry, row.evidence.nif], ['PT', 'PT', CLIENT_NIF]);
  assert.ok(row.evidence.ip, 'IP do pedido de pagamento');
  assert.deepEqual([row.seller.name, row.seller.nif], ['Empresa Vendedora de Teste, Lda.', SELLER_NIF]);
  assert.match(row.description, /plano Pro/);
  // outra fatura com o código postal do continente mas cobrada a 22%: aviso na lista
  await sendEvent(inv('evt_inv2', { customer_address: { country: 'PT', postal_code: '1000-001' } }));
  // faturas de outro portal são ignoradas
  assert.equal((await sendEvent(inv('evt_inv3', { parent: { subscription_details: { subscription: 'sub_Z', metadata: { app: 'outro-portal' } } } }))).json().result, 'ignored');
  assert.equal((await get('/admin/faturacao', biz.cookie)).statusCode, 403);
  const pg = await get('/admin/faturacao', admin);
  assert.match(pg.body, /Por faturar \(2\)/);
  assert.match(pg.body, /49,00 € \+ IVA 10,78 €<br><strong>59,78 €<\/strong>/);
  assert.match(pg.body, /nacional · 22% \(PT\)/);
  assert.match(pg.body, /Empresa Vendedora de Teste, Lda\.<br><span class="hint">NIF \d{9}/);
  assert.match(pg.body, /o código postal da Stripe \(1000-001\) dá IVA de 23%, foi cobrado 22%/);
  assert.match(pg.body, /Fatura Moloni n\.º/);
  assert.match(msg(await post(`/admin/faturacao/${row.id}/faturada`, { moloni_doc: ' ' }, admin)), /Indique o número da fatura/);
  assert.equal((await post(`/admin/faturacao/${row.id}/faturada`, { moloni_doc: 'FR 2026/15' }, biz.cookie)).statusCode, 403);
  assert.match(msg(await post(`/admin/faturacao/${row.id}/faturada`, { moloni_doc: 'FR 2026/15' }, admin)), /faturado no Moloni n\.º FR 2026\/15/);
  assert.match(msg(await post(`/admin/faturacao/${row.id}/faturada`, { moloni_doc: 'FR 2026/16' }, admin)), /já estava marcado como faturado/);
  const after = await db.one('SELECT status, moloni_doc, issued_by FROM invoice_queue WHERE id=$1', [row.id]);
  assert.deepEqual([after.status, after.moloni_doc, after.issued_by], ['issued', 'FR 2026/15', 'admin@example.com']);
  const pg2 = await get('/admin/faturacao', admin);
  assert.match(pg2.body, /Por faturar \(1\)/); assert.match(pg2.body, /faturado no Moloni n\.º <strong>FR 2026\/15<\/strong>/);
  // pagamento falhado: «em atraso» e aviso; o pagamento seguinte volta a ativar
  assert.equal((await sendEvent({ id: 'evt_fail', type: 'invoice.payment_failed', data: { object: { id: 'in_fail', parent: { subscription_details: { subscription: 'sub_A', metadata: { app: 'quietinterview', user_id: biz.id } } } } } })).json().result, 'applied');
  assert.equal((await db.one('SELECT status FROM subscriptions WHERE user_id=$1', [biz.id])).status, 'past_due');
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='billing.payment_failed'`));
  await sendEvent(inv('evt_inv4'));
  assert.equal((await db.one('SELECT status FROM subscriptions WHERE user_id=$1', [biz.id])).status, 'active');
  } finally { fs.restore(); }
});

test('fora da UE recusado («contacte-nos»); empresa da UE com número de IVA verificado no VIES paga sem IVA', async () => {
  const eu = await register('Empresa ES', 'es@example.com');
  assert.match(msg(await post('/billing/profile', { kind: 'business', name: 'Empresa US', country: 'other', address: 'Main St', postal_code: '10001', city: 'NY' }, eu.cookie)), /only sell to customers with a billing address in the European Union[\s\S]*Contacte-nos/);
  assert.match(msg(await post('/billing/profile', { kind: 'consumer', name: 'X', country: 'ES', address: 'Calle', postal_code: '35001', city: 'Las Palmas' }, eu.cookie)), /Canárias is outside the EU VAT area/);
  assert.equal(await db.one('SELECT 1 FROM billing_profiles WHERE user_id=$1', [eu.id]), undefined);
  const fs = fakeStripe();
  try {
    assert.match(msg(await post('/billing/profile', { kind: 'business', name: 'Empresa ES SL', country: 'ES', tax_id: 'B12345678', address: 'Calle Mayor 1', postal_code: '28001', city: 'Madrid' }, eu.cookie)), /VAT number: checking in VIES/);
    const [tx] = fs.find('POST', /^customers\/[^/]+\/tax_ids$/);
    assert.deepEqual([tx.params.get('type'), tx.params.get('value')], ['eu_vat', 'ESB12345678']);
    assert.equal((await db.one('SELECT vat_status FROM billing_profiles WHERE user_id=$1', [eu.id])).vat_status, 'pending');
    // ainda por verificar: não paga (nem com IVA, sem o pedir) — volta a consultar a Stripe
    assert.match(msg(await post('/subscribe/start', { terms: '1' }, eu.cookie)), /still checking your VAT number in VIES/);
    assert.ok(fs.find('GET', /tax_ids\/txi_1$/).length >= 1);
    assert.equal(fs.find('POST', 'checkout/sessions').length, 0);
  } finally { fs.restore(); }
  // a verificação termina (webhook customer.tax_id.updated)
  assert.equal((await sendEvent({ id: 'evt_txi', type: 'customer.tax_id.updated', data: { object: { id: 'txi_1', value: 'ESB12345678', verification: { status: 'verified', verified_name: 'EMPRESA ES SL' } } } })).json().result, 'applied');
  assert.match((await get('/account', eu.cookie)).body, /€19<span class="hint"> \/ month<\/span><\/p><p class="hint">No VAT: reverse charge/);
  const fs2 = fakeStripe();
  try {
    assert.equal((await post('/subscribe/start', { terms: '1' }, eu.cookie)).statusCode, 303);
    const p = Object.fromEntries(fs2.find('POST', 'checkout/sessions')[0].params);
    assert.ok(!Object.keys(p).some(k => k.includes('tax_rates')), 'sem taxa de IVA');
    assert.deepEqual([p['metadata[vat_regime]'], p['metadata[vat_rate]'], p['metadata[vat_country]'], p['metadata[customer_country]']], ['reverse_charge', '0', 'ES', 'ES']);
    assert.equal(fs2.find('POST', 'tax_rates').length, 0);
  } finally { fs2.restore(); }
  // na lista «por faturar» a linha leva a menção da autoliquidação
  const fs3 = fakeStripe();
  try {
  await sendEvent({ id: 'evt_rc', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: eu.id, subscription: 'sub_ES', customer: 'cus_es', customer_details: { address: { country: 'ES', postal_code: '28001' } }, metadata: { app: 'quietinterview', plan_id: 'start', customer_kind: 'business', customer_country: 'ES', vat_regime: 'reverse_charge', vat_rate: '0', vat_country: 'ES' } } } });
  await sendEvent({ id: 'evt_rc_inv', type: 'invoice.paid', data: { object: { id: 'in_rc', customer: 'cus_es', total: 1900, total_excluding_tax: 1900, customer_address: { country: 'ES', postal_code: '28001' }, subscription: 'sub_ES', subscription_details: { metadata: { app: 'quietinterview', user_id: eu.id, plan_id: 'start', customer_kind: 'business', customer_country: 'ES', vat_regime: 'reverse_charge', vat_rate: '0', vat_country: 'ES' } } } } });
  } finally { fs3.restore(); }
  const rc = await db.one(`SELECT * FROM invoice_queue WHERE stripe_ref='in_rc'`);
  assert.deepEqual([rc.vat_cents, rc.vat_regime, rc.evidence.vatNumber, rc.evidence.vatStatus], [0, 'reverse_charge', 'ESB12345678', 'verified']);
  assert.match(rc.vat_note, /IVA – autoliquidação/);
  assert.match((await get('/admin/faturacao', admin)).body, /Menção: IVA – autoliquidação/);
});

test('consumidores: preço com IVA, pedido de início imediato, confirmação por email e botão de livre resolução', async () => {
  const c = await register('Consumidora', 'consumidora@example.com');
  await post('/billing/profile', { kind: 'consumer', name: 'Maria Consumidora', country: 'PT', tax_id: '', address: 'Rua B', postal_code: '1000-001', city: 'Lisboa' }, c.cookie);
  // sem o email e o Livro de Reclamações da vendedora, a venda a consumidores está bloqueada
  let acc = await get('/account', c.cookie);
  assert.match(acc.body, /Online sales to consumers are not open yet/);
  assert.match(msg(await post('/subscribe/start', { terms: '1', start_now: '1', waiver: '1' }, c.cookie)), /consumidores ainda não está disponível/);
  await post('/admin/definicoes', { SELLER_EMAIL: 'vendas@exemplo.pt', SELLER_COMPLAINTS_URL: 'https://www.livroreclamacoes.pt/Inicio/', signups_open: '1' }, admin);
  assert.doesNotMatch((await get('/admin/definicoes', admin)).body, /venda a consumidores bloqueada/);
  acc = await get('/account', c.cookie);
  assert.match(acc.body, /€23\.37<span class="hint"> \/ month incl\. VAT<\/span><\/p><p class="hint" lang="pt-PT">23,37 €\/mês com IVA incluído \(19,00 € \+ IVA 23%\)/);
  assert.match(acc.body, /<button class="accent" >Subscrever e pagar 23,37 €\/mês · Subscribe and pay €23\.37\/month<\/button>/);
  assert.match(acc.body, /name="start_now" value="1" required> <span>Peço que o serviço comece já/);
  assert.match(acc.body, /name="waiver" value="1" required> <span>Reconheço que perco o direito de livre resolução/);
  assert.doesNotMatch(acc.body, /checked> <span>Peço/, 'caixas não pré-assinaladas');
  const fs = fakeStripe();
  try {
    assert.match(msg(await post('/subscribe/start', { terms: '1', start_now: '1' }, c.cookie)), /confirme o pedido de início imediato/);
    assert.equal((await post('/subscribe/start', { terms: '1', start_now: '1', waiver: '1' }, c.cookie)).statusCode, 303);
    const p = Object.fromEntries(fs.find('POST', 'checkout/sessions')[0].params);
    assert.equal(p.locale, 'pt'); assert.match(p['line_items[0][tax_rates][0]'], /^txr_PT23_/); assert.equal(p['metadata[customer_kind]'], 'consumer');
    const a = await db.one(`SELECT meta FROM audit_events WHERE action='billing.checkout_started' AND actor='consumidora@example.com'`);
    assert.equal(a.meta.startNow, true); assert.equal(a.meta.waiver, true); assert.ok(a.meta.ip);
  } finally { fs.restore(); }
  // pago: confirmação do contrato em suporte duradouro
  await sendEvent({ id: 'evt_c1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: c.id, subscription: 'sub_C', customer: 'cus_c', customer_details: { email: 'consumidora@example.com', address: { country: 'PT', postal_code: '1000-001' } }, metadata: { app: 'quietinterview', plan_id: 'start', customer_kind: 'consumer', customer_country: 'PT', vat_regime: 'domestic', vat_rate: '23', vat_country: 'PT' } } } });
  const mail = await db.one(`SELECT to_email, text_body FROM emails WHERE dedupe_key='contract:sub_C'`);
  assert.equal(mail.to_email, 'consumidora@example.com');
  assert.match(mail.text_body, /23,37 €\/mês com IVA \(19,00 € \+ IVA 23%\)[\s\S]*Desistir do contrato aqui[\s\S]*Empresa Vendedora de Teste, Lda\., NIF/);
  // o email do contrato traz os dois consentimentos tal como foram assinalados e o modelo de formulário de livre resolução
  assert.match(mail.text_body, /Consentimentos assinalados na subscrição: «Peço que o serviço comece já\. Sei que posso desistir nos 14 dias seguintes[^»]*» e «Reconheço que perco o direito de livre resolução quando o serviço estiver integralmente prestado[^»]*»/);
  assert.match(mail.text_body, /Modelo de formulário de livre resolução\n\(só deve preencher e devolver o presente formulário se quiser resolver o contrato\)\n— Para: Empresa Vendedora de Teste, Lda\., Rua de Teste, 1, 1000-001 Lisboa, vendas@exemplo\.pt\n— Pela presente comunico\/comunicamos \(\*\)/);
  assert.match(mail.text_body, /— Assinatura do\(s\) consumidor\(es\) \(só no caso de o presente formulário ser notificado em papel\)\n— Data\n\(\*\) Riscar o que não interessa\./);
  // botão de livre resolução nos 14 dias
  acc = await get('/account', c.cookie);
  assert.match(acc.body, /<a class="btn ghost" href="\/billing\/livre-resolucao">Desistir do contrato aqui<\/a>/);
  assert.equal((await get('/billing/livre-resolucao', biz.cookie)).statusCode, 302, 'empresas não têm o botão');
  assert.match((await get('/billing/livre-resolucao', c.cookie)).body, /Confirmar a desistência/);
  const fs2 = fakeStripe();
  try {
    assert.match(msg(await post('/billing/livre-resolucao', {}, c.cookie)), /Pedido de desistência registado/);
    assert.equal(fs2.find('DELETE', 'subscriptions/sub_C').length, 1);
  } finally { fs2.restore(); }
  const w = await db.one('SELECT * FROM withdrawals WHERE user_id=$1', [c.id]);
  assert.deepEqual([w.status, w.stripe_cancelled, w.stripe_ref], ['requested', true, 'sub_C']);
  assert.equal((await db.one('SELECT status FROM subscriptions WHERE user_id=$1', [c.id])).status, 'canceled');
  assert.ok(await db.one(`SELECT 1 FROM emails WHERE dedupe_key=$1`, [`withdrawal:${w.id}`]));
  assert.equal((await post('/billing/livre-resolucao', {}, c.cookie)).headers.location, '/account', 'um só pedido');
  const pg = await get('/admin/faturacao', admin);
  assert.match(pg.body, /Maria|Consumidora/); assert.match(pg.body, /cancelada na Stripe/);
  await post(`/admin/faturacao/livre-resolucao/${w.id}`, { note: 'reembolso feito, NC 2026/1' }, admin);
  assert.equal((await db.one('SELECT status FROM withdrawals WHERE id=$1', [w.id])).status, 'processed');
});

test('termos e privacidade dos pagamentos: vendedora identificada, Livro de Reclamações e a Certif como entidade gestora', async () => {
  const t = await get('/termos');
  assert.equal(t.statusCode, 200);
  assert.match(t.body, /lang="pt-PT"/);
  assert.match(t.body, /Empresa Vendedora de Teste, Lda\. \(Telecert\)<br>NIF \d{9} · Sede: Rua de Teste, 1, 1000-001 Lisboa, Portugal/);
  assert.match(t.body, /<a href="https:\/\/www\.livroreclamacoes\.pt\/Inicio\/" rel="noopener" target="_blank">Livro de Reclamações Eletrónico<\/a>/);
  assert.match(t.body, /gerida pela Certif Int Association OÜ \(Estónia; <a href="https:\/\/www\.certifinternational\.com"[^>]*>www\.certifinternational\.com<\/a>; <a href="mailto:certifinternational@gmail\.com">/);
  assert.match(t.body, /entidade gestora, que não vende ao cliente final/);
  assert.match(t.body, /<td>Start<\/td><td>3<\/td><td>19,00 €\/mês \+ IVA<\/td><td>23,37 €\/mês<\/td><td>23,18 €\/mês<\/td><td>22,04 €\/mês<\/td>/);
  assert.match(t.body, /A animação por IA não está incluída em nenhum plano/);
  assert.match(t.body, /Desistir do contrato aqui/);
  assert.match(t.body, /art\. 17\.º, n\.º 1, als\. a\) e l\)/);
  // livre resolução também dos carregamentos e o modelo de formulário (DL 24/2014, anexo, parte B) com a vendedora preenchida
  assert.match(t.body, /de cada carregamento de créditos, nos 14 dias seguintes ao pagamento, pelo botão «Desistir do contrato aqui» desse carregamento, em «Créditos»/);
  assert.match(t.body, /<div id="formulario-livre-resolucao"[^>]*><p[^>]*><strong>Modelo de formulário de livre resolução<\/strong>/);
  assert.match(t.body, /— Para: Empresa Vendedora de Teste, Lda\., Rua de Teste, 1, 1000-001 Lisboa, [^<]+@[^<]+<br>— Pela presente comunico\/comunicamos/);
  // as regenerações incluídas vêm da configuração (as mesmas que a produção cobra)
  const { config } = await import('../src/config.ts');
  const before = config.limits.includedRegenerations;
  (config.limits as any).includedRegenerations = 2;
  try {
    const t2 = (await get('/termos')).body;
    assert.match(t2, /com 2 regenerações do guião ou do episódio incluídas/); assert.match(t2, /para além das 2 incluídas em cada entrevista/);
    assert.doesNotMatch(t2, /3 regenerações|das 3 incluídas/);
  } finally { (config.limits as any).includedRegenerations = before; }
  const pp = await get('/privacidade-pagamentos');
  assert.equal(pp.statusCode, 200);
  assert.match(pp.body, /Responsável pelo tratamento<\/h2><p>Empresa Vendedora de Teste, Lda\./);
  assert.match(pp.body, /CNPD/);
  // apagar um campo volta ao valor por omissão; sem nenhum valor, nunca se inventa: aparece «por preencher»
  await post('/admin/definicoes', { SELLER_ADDRESS: '-', signups_open: '1' }, admin);
  assert.match((await get('/termos')).body, /Sede: Avenida 5 de Outubro, 38A, 8000-077 Faro, Portugal/);
  process.env.SELLER_ADDRESS = '';
  try { assert.match((await get('/termos')).body, /Sede: <em>\(por preencher pelo administrador\)<\/em>/); } finally { delete process.env.SELLER_ADDRESS; }
  await post('/admin/definicoes', { SELLER_ADDRESS: 'Rua de Teste, 1, 1000-001 Lisboa', signups_open: '1' }, admin);
});

test('Stripe «Guardar e testar»: aviso se o nome da conta Stripe não for o da empresa vendedora', async () => {
  const fs = fakeStripe();
  try {
    fs.state.accountName = 'Outra Empresa SA';
    const bad = msg(await post('/admin/definicoes/testar/Stripe', {}, admin));
    assert.match(bad, /Stripe: ligação OK \(modo de teste\)\. Atenção: a conta Stripe chama-se «Outra Empresa SA» e a empresa vendedora é «Empresa Vendedora de Teste, Lda\.»/);
    assert.match((await get('/admin/definicoes', admin)).body, /a conta Stripe chama-se «Outra Empresa SA», que não coincide com a empresa vendedora/);
    fs.state.accountName = 'Empresa Vendedora de Teste';
    assert.match(msg(await post('/admin/definicoes/testar/Stripe', {}, admin)), /Conta «Empresa Vendedora de Teste», a da empresa vendedora\./);
    const pg = await get('/admin/definicoes', admin);
    assert.doesNotMatch(pg.body, /não coincide com a empresa vendedora/);
    assert.match(pg.body, /eventos: checkout\.session\.completed, checkout\.session\.async_payment_succeeded\/failed, checkout\.session\.expired, customer\.subscription\.created\/updated\/deleted, invoice\.paid, invoice\.payment_failed, customer\.tax_id\.created\/updated, refund\.created\/updated\/failed, charge\.refunded, charge\.dispute\.created\/closed/);
    assert.match(pg.body, /PT 22% \(txr_PT22_/);
  } finally { fs.restore(); }
});
