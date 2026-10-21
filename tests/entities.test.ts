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
const { S, saveSetting, inEntity } = await import('../src/settings.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
const post = (url: string, body: any, cookie = '', extra: any = {}) => app.inject({ method: 'POST', url, payload: typeof body === 'string' ? body : form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...extra } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const PW = 'uma-palavra-passe-longa';
let admin = '', gestor = '', other = '', tcId = '', otherId = '';

test('a entidade Telecert Formação existe, com o URL do site', async () => {
  const e = await db.one(`SELECT * FROM entities WHERE slug='telecert-formacao'`);
  assert.equal(e.name, 'Telecert Formação');
  assert.equal(e.url, 'https://www.grupotelecert.com');
  tcId = e.id;
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  const pg = await get('/admin/entidades', admin);
  assert.equal(pg.statusCode, 200);
  assert.match(pg.body, /www\.grupotelecert\.com/);
  assert.match(pg.body, /registar\?entidade=telecert-formacao/);
  assert.match(pg.body, /webhooks\/stripe\/telecert-formacao/);
});

test('criar gestor de entidade; só vê e edita as chaves da sua entidade', async () => {
  const bad = await post('/admin/utilizadores', { name: 'G', email: 'g@example.com', password: PW, role: 'entity_admin' }, admin);
  assert.match(decodeURIComponent(bad.headers.location as string), /precisa de uma entidade/);
  await post('/admin/utilizadores', { name: 'Gestora', email: 'gestora@telecert.pt', password: PW, role: 'entity_admin', entity_id: tcId }, admin);
  gestor = `sid=${cookies(await post('/entrar', { email: 'gestora@telecert.pt', password: PW })).sid}`;
  const o = await post('/admin/entidades', { name: 'Outra Entidade', url: 'https://outra.example' }, admin);
  otherId = /entidades\/([0-9a-f-]{36})\//.exec(o.headers.location as string)![1];
  await post('/admin/utilizadores', { name: 'Outro', email: 'outro@outra.pt', password: PW, role: 'entity_admin', entity_id: otherId }, admin);
  other = `sid=${cookies(await post('/entrar', { email: 'outro@outra.pt', password: PW })).sid}`;

  assert.equal((await get('/entidade', gestor)).headers.location, `/entidades/${tcId}/chaves`);
  const pg = await get(`/entidades/${tcId}/chaves`, gestor);
  assert.equal(pg.statusCode, 200);
  for (const g of ['OpenAI', 'Stripe', 'MailerSend', 'Moloni ON']) assert.match(pg.body, new RegExp(g));
  assert.equal((await get(`/entidades/${otherId}/chaves`, gestor)).statusCode, 404, 'não vê outra entidade');
  assert.equal((await post(`/entidades/${otherId}/chaves`, { OPENAI_API_KEY: 'sk-x' }, gestor)).statusCode, 404);
  assert.equal((await get('/admin/entidades', gestor)).statusCode, 403);
  assert.equal((await get('/admin/definicoes', gestor)).statusCode, 403, 'sem acesso às chaves globais');
  assert.equal((await post(`/entidades/${tcId}`, { name: 'Hack' }, gestor)).statusCode, 403, 'não altera os dados da entidade');
});

test('chaves da entidade: cifradas, mascaradas, isoladas e com prioridade sobre as globais', async () => {
  await saveSetting(db, 'OPENAI_API_KEY', 'sk-GLOBAL-0000');
  await post(`/entidades/${tcId}/chaves`, { OPENAI_API_KEY: 'sk-TELECERT-1234', STRIPE_SECRET_KEY: 'sk_test_tele9999', MAIL_FROM: 'no-reply@grupotelecert.com', MOLONI_PASSWORD: 'moloni-pw-7777' }, gestor);
  const row = await db.one(`SELECT value_enc FROM entity_settings WHERE entity_id=$1 AND key='OPENAI_API_KEY'`, [tcId]);
  assert.ok(!row.value_enc.includes('TELECERT'), 'cifrado em repouso');
  const pg = await get(`/entidades/${tcId}/chaves`, gestor);
  assert.ok(!pg.body.includes('sk-TELECERT-1234') && !pg.body.includes('moloni-pw-7777'), 'valores completos nunca voltam');
  assert.match(pg.body, /1234/);
  assert.match(pg.body, /no-reply@grupotelecert\.com/, 'campos não secretos visíveis');
  assert.equal(inEntity(tcId, () => S('OPENAI_API_KEY')), 'sk-TELECERT-1234');
  assert.equal(inEntity(otherId, () => S('OPENAI_API_KEY')), 'sk-GLOBAL-0000', 'outra entidade usa a global');
  assert.equal(inEntity(null, () => S('OPENAI_API_KEY')), 'sk-GLOBAL-0000');
  assert.equal(inEntity(otherId, () => S('STRIPE_SECRET_KEY')), '', 'chaves não vazam entre entidades');
  assert.match((await get(`/entidades/${otherId}/chaves`, other)).body, /global \(reserva\)/);
  // apagar volta à global
  await post(`/entidades/${tcId}/chaves`, { OPENAI_API_KEY: '-' }, gestor);
  assert.equal(inEntity(tcId, () => S('OPENAI_API_KEY')), 'sk-GLOBAL-0000');
});

test('webhook Stripe por entidade usa o segredo da entidade', async () => {
  await post(`/entidades/${tcId}/chaves`, { STRIPE_WEBHOOK_SECRET: 'whsec_telecert' }, gestor);
  await post('/registar?entidade=telecert-formacao', { name: 'Ana', email: 'ana@exemplo.pt', password: PW, terms: 1, entidade: 'telecert-formacao' });
  const u = await db.one(`SELECT id, entity_id FROM users WHERE email='ana@exemplo.pt'`);
  assert.equal(u.entity_id, tcId, 'registo pela ligação da entidade associa o utilizador');
  const ev = JSON.stringify({ id: 'evt_t1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', client_reference_id: u.id, customer: 'cus_t', subscription: 'sub_t', metadata: { plan_id: 'starter' } } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = (sec: string) => `t=${t},v1=${createHmac('sha256', sec).update(`${t}.${ev}`).digest('hex')}`;
  const send = (url: string, sec: string) => app.inject({ method: 'POST', url, payload: ev, headers: { 'content-type': 'application/json', 'stripe-signature': sig(sec) } });
  assert.equal((await send('/webhooks/stripe/telecert-formacao', 'whsec_outro')).statusCode, 400);
  assert.equal((await send('/webhooks/stripe', 'whsec_telecert')).statusCode, 400, 'o endpoint global não aceita o segredo da entidade');
  assert.equal((await send('/webhooks/stripe/nao-existe', 'whsec_telecert')).statusCode, 404);
  assert.equal((await send('/webhooks/stripe/telecert-formacao', 'whsec_telecert')).statusCode, 200);
  assert.equal((await db.one('SELECT plan_id FROM subscriptions WHERE user_id=$1', [u.id])).plan_id, 'starter');
});

test('administrador edita a entidade e valida o URL', async () => {
  assert.match(decodeURIComponent((await post(`/entidades/${tcId}`, { name: 'Telecert Formação', url: 'javascript:alert(1)', active: '1' }, admin)).headers.location as string), /URL inválido/);
  await post(`/entidades/${tcId}`, { name: 'Telecert Formação', url: 'https://www.grupotelecert.com', active: '1' }, admin);
  assert.equal((await db.one('SELECT url FROM entities WHERE id=$1', [tcId])).url, 'https://www.grupotelecert.com');
  await post(`/entidades/${otherId}`, { name: 'Outra Entidade', url: 'https://outra.example' }, admin);
  assert.equal((await get('/registar?entidade=outra-entidade')).statusCode, 200);
});

test('Veo por entidade: conta de serviço e nível da entidade com prioridade sobre os globais', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { veoBackend, veoTier, veoModel } = await import('../src/talking.ts');
  const pk = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const sa = JSON.stringify({ type: 'service_account', project_id: 'telecert-veo', private_key: pk, client_email: 'veo@telecert-veo.iam.gserviceaccount.com' });
  await saveSetting(db, 'VEO_TIER', 'fast');
  let pg = await get(`/entidades/${tcId}/chaves`, gestor);
  assert.match(pg.body, /<select id="f_VEO_TIER" name="VEO_TIER"><option value="" selected>Como na definição global \(Veo 3\.1 Fast/);
  assert.match(decodeURIComponent((await post(`/entidades/${tcId}/chaves`, { VERTEX_SA_JSON: '{"type":"authorized_user"}' }, gestor)).headers.location as string), /Nada foi guardado/);
  await post(`/entidades/${tcId}/chaves`, { VERTEX_SA_JSON: sa, VEO_TIER: 'lite' }, gestor);
  assert.equal(inEntity(tcId, () => veoBackend()), 'vertex'); assert.equal(inEntity(tcId, () => veoTier()), 'lite');
  assert.equal(inEntity(tcId, () => veoModel()), 'veo-3.1-lite-generate-001');
  assert.equal(inEntity(otherId, () => veoBackend()), 'gemini', 'outra entidade não usa a conta de serviço desta');
  assert.equal(inEntity(otherId, () => veoTier()), 'fast');
  pg = await get(`/entidades/${tcId}/chaves`, gestor);
  assert.ok(!pg.body.includes(pk.split('\n')[2]), 'a chave nunca volta ao browser');
  assert.match(pg.body, /guardada: veo@telecert-veo\.iam\.gserviceaccount\.com · projeto telecert-veo/);
  await post(`/entidades/${tcId}/chaves`, { VERTEX_SA_JSON: '-', VEO_TIER: '' }, gestor);
  assert.equal(inEntity(tcId, () => veoBackend()), 'gemini'); assert.equal(inEntity(tcId, () => veoTier()), 'fast', 'volta ao nível global');
});

test('Veo por entidade: credenciais em conjunto — a conta de serviço global não passa à frente da chave Gemini da entidade', async () => {
  const { generateKeyPairSync } = await import('node:crypto');
  const t = await import('../src/talking.ts');
  const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  // chaves falsas, geradas aqui
  const saDono = JSON.stringify({ type: 'service_account', project_id: 'portal-dono-veo', private_key: key(), client_email: 'veo@portal-dono-veo.iam.gserviceaccount.com' });
  const saTc = JSON.stringify({ type: 'service_account', project_id: 'telecert-veo', private_key: key(), client_email: 'veo@telecert-veo.iam.gserviceaccount.com' });
  const geminiTc = ('AIza' + 'Test' + 'X'.repeat(29));
  await saveSetting(db, 'VERTEX_SA_JSON', saDono);
  await post(`/entidades/${tcId}/chaves`, { GEMINI_API_KEY: geminiTc }, gestor);

  // a entidade com chave Gemini própria usa só a dela; a outra (sem credenciais) usa a conta de serviço global
  assert.equal(inEntity(tcId, () => t.veoBackend()), 'gemini');
  assert.equal(inEntity(tcId, () => t.veoCredsScope()), 'entity');
  assert.equal(inEntity(otherId, () => t.veoBackend()), 'vertex');
  assert.equal(inEntity(otherId, () => t.veoCredsScope()), 'global');
  assert.equal(t.veoBackend(), 'vertex', 'fora de uma entidade: as globais');

  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const c = { url: String(u), headers: Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])), body: String(init.body ?? '') };
    calls.push(c);
    const ok = (b: any) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (c.url === 'https://oauth2.googleapis.com/token') return ok({ access_token: 'ya29.teste', expires_in: 3600 });
    if (c.url.includes(':predictLongRunning')) return ok({ name: c.url.includes('aiplatform') ? 'projects/x/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/1' : 'models/veo-3.1-fast-generate-preview/operations/1' });
    if (c.url.includes(':fetchPredictOperation')) return new Response(JSON.stringify({ error: { code: 404, message: 'Operation not found' } }), { status: 404 });
    return ok({ name: 'models/veo-3.1-fast-generate-preview' });
  }) as any;
  try {
    t.clearVertexTokens();
    const s = await inEntity(tcId, () => t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8 }));
    assert.equal(s.backend, 'gemini'); assert.equal(s.model, 'veo-3.1-fast-generate-preview');
    assert.equal(calls.length, 1, 'nenhum token pedido com a conta de serviço global');
    assert.match(calls[0].url, /^https:\/\/generativelanguage\.googleapis\.com\//);
    assert.equal(calls[0].headers['x-goog-api-key'], geminiTc, 'a chave da entidade');

    // «Guardar e testar» da entidade diz de quem são as credenciais
    calls.length = 0;
    let r = await post(`/entidades/${tcId}/testar/Google`, { VEO_TIER: '' }, gestor);
    let msg = decodeURIComponent(r.headers.location as string);
    assert.match(msg, /Gemini API/); assert.match(msg, /credenciais Google desta entidade/);
    assert.ok(calls.every(c => !c.url.includes('oauth2') && !c.url.includes('aiplatform')), 'o teste não usa a conta de serviço global');
    let pg = await get(`/entidades/${tcId}/chaves`, gestor);
    assert.match(pg.body, /Conta de serviço do Vertex AI \(JSON\) <span class="hint">· global, não usada: o Veo usa as credenciais Google desta entidade/);
    assert.match(pg.body, /Gemini API key[^<]*<span class="hint">· da entidade/);

    // a outra entidade (sem credenciais próprias) usa as globais e o teste avisa
    calls.length = 0;
    const s2 = await inEntity(otherId, () => t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8 }));
    assert.equal(s2.backend, 'vertex');
    assert.match(calls[1].url, /\/projects\/portal-dono-veo\/locations\/us-central1\//);
    r = await post(`/entidades/${otherId}/testar/Google`, { VEO_TIER: '' }, other);
    msg = decodeURIComponent(r.headers.location as string);
    assert.match(msg, /Vertex AI/); assert.match(msg, /não tem credenciais Google próprias/);
    pg = await get(`/entidades/${otherId}/chaves`, other);
    assert.match(pg.body, /Conta de serviço do Vertex AI \(JSON\) <span class="hint">· global \(reserva\)/);

    // com conta de serviço própria, a entidade paga no projeto dela
    await post(`/entidades/${tcId}/chaves`, { VERTEX_SA_JSON: saTc }, gestor);
    calls.length = 0; t.clearVertexTokens();
    const s3 = await inEntity(tcId, () => t.veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8 }));
    assert.equal(s3.backend, 'vertex');
    assert.equal(JSON.parse(Buffer.from(new URLSearchParams(calls[0].body).get('assertion')!.split('.')[1], 'base64url').toString()).iss, 'veo@telecert-veo.iam.gserviceaccount.com');
    assert.match(calls[1].url, /\/projects\/telecert-veo\//);

    // sem credenciais próprias, volta às globais
    await post(`/entidades/${tcId}/chaves`, { VERTEX_SA_JSON: '-', GEMINI_API_KEY: '-' }, gestor);
    assert.equal(inEntity(tcId, () => t.veoCredsScope()), 'global');
    assert.equal(inEntity(tcId, () => t.veoBackend()), 'vertex');
  } finally {
    globalThis.fetch = realFetch;
    await saveSetting(db, 'VERTEX_SA_JSON', '');
  }
});
