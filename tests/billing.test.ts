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
