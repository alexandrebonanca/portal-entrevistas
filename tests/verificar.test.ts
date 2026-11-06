import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';
process.env.RESEND_COOLDOWN_SEC = '0'; // pedidos seguidos ao entrevistado nos testes

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { saveSetting } = await import('../src/settings.ts');
const J = await import('../src/jobs.ts');
const { runOne } = J;
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const { storage } = await import('../src/storage.ts');
const W = await import('../src/wallet.ts');
const Q = await import('../src/quotes.ts');
const V = await import('../src/veo-episode.ts');
const { eurPt, withVat } = await import('../src/vat.ts');
const sharp = (await import('sharp')).default;

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db);});
after(async () => { await app.close(); await db.close(); });
// Sem rede: nada vai à Google, à OpenAI nem à Stripe (o modo simulado gera os clipes localmente).
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any) => Promise.reject(new Error(`rede proibida nos testes: ${String(u)}`))) as any;
after(() => { globalThis.fetch = realFetch; });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie = '') => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const raw = (url: string, payload: Buffer, type: string, cookie: string) => app.inject({ method: 'POST', url, payload, headers: { 'content-type': type, cookie } });
const msg = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const PW = 'uma-palavra-passe-longa';
/** NIF fictício com o dígito de controlo certo (só para testes). */
const nifOf = (p8: string) => { const sum = [...p8].reduce((s, d, i) => s + Number(d) * (9 - i), 0); return p8 + (sum % 11 < 2 ? 0 : 11 - (sum % 11)); };
const check = async () => assert.deepEqual(await W.ledgerCheck(db), [], 'livro-razão: soma das entradas = saldos; disponível = lotes');
const walletOf = (userId: string) => db.one('SELECT * FROM wallets WHERE user_id=$1 AND entity_id IS NULL', [userId]);
/** Créditos num lote pago (o carregamento pela Stripe está testado em credits.test.ts). */
const credit = async (userId: string, cents: number) => {
  const w = await W.walletFor(db, userId, null);
  const tp = await db.one(`INSERT INTO credit_topups(wallet_id, user_id, net_cents, vat_cents, gross_cents, vat_rate, vat_regime, customer_kind, customer_country) VALUES ($1,$2,$3,$4,$5,23,'domestic','business','PT') RETURNING id`,
    [w.id, userId, cents, Math.round(cents * 0.23), cents + Math.round(cents * 0.23)]);
  assert.equal(await db.tx((t: any) => W.creditTopup(t, tp.id, { paymentIntent: `pi_q_${tp.id}` })), true);
};


let admin = '', guest = '', ivId = '';
const cli = { cookie: '', id: '' };
/** Gravação só com ruído muito baixo (como um microfone «mudo»): ~-70 dB. */
const quietWav = (seconds: number) => { const b = makeToneWav(seconds); for (let i = 44; i + 1 < b.length; i += 2) b.writeInt16LE(((i * 7919) % 21) - 10, i); return b; };

test('preparação: entrevista enviada, entrevistado responde (uma resposta sem voz) e ainda não submete', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  await saveSetting(db, 'SIGNUPS_OPEN', '1');
  const r = await post('/registar', { name: 'Cliente', email: 'cliente@example.com', password: PW, terms: 1 });
  cli.cookie = `sid=${cookies(r).sid}`;
  cli.id = (await db.one('SELECT id FROM users WHERE email=$1', ['cliente@example.com'])).id;
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [cli.id]);
  const c = await post('/entrevistas', { title: 'Hotelaria' }, cli.cookie);
  ivId = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  for (const t of ['Pergunta um?', 'Pergunta dois?', 'Pergunta três?']) await post(`/entrevistas/${ivId}/perguntas`, { text: t }, cli.cookie);
  await post(`/entrevistas/${ivId}/guardar`, { title: 'Hotelaria', objective_text: 'O', host_name: 'Zé', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'pt-PT', review_policy: 'guest_preview', subtitle_langs: 'en' }, cli.cookie);
  assert.match(msg(await post(`/entrevistas/${ivId}/convidar`, {}, cli.cookie)), /entrevistas\//);
  await flushOutbox(db);
  const mail = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  guest = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(mail.text_body)![1]}/abrir`, {})).gs}`;
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', host_edit: '1', processing: '1', publish: '1' }, guest);
  const qs = await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [ivId]);
  const up = async (i: number, wav: Buffer) => (await raw(`/api/g/respostas/${qs[i].id}`, wav, 'audio/wav', guest)).json();
  assert.equal((await up(0, makeToneWav(3))).silent, false);
  assert.equal((await up(1, quietWav(4))).silent, true, 'só ruído: o servidor avisa logo');
  // a resposta 3 foi gravada antes da deteção nova: sem a marca, a verificação mede-a
  assert.equal((await up(2, quietWav(3))).silent, true);
  const a3 = await db.one(`SELECT a.id FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets a ON a.id=t.asset_id WHERE an.question_id=$1`, [qs[2].id]);
  await db.query(`UPDATE assets SET meta = meta - 'silent' WHERE id=$1`, [a3.id]);
  assert.equal((await db.one('SELECT collection_status FROM interviews WHERE id=$1', [ivId])).collection_status, 'started');
});

test('verificar: antes da submissão, cada resposta mostra se tem voz e a transcrição (que o processamento reaproveita)', async () => {
  let pg = (await get(`/entrevistas/${ivId}`, cli.cookie)).body;
  assert.match(pg, /Verificar as respostas/);
  assert.match(pg, /Respondida, mas sem voz audível/);
  assert.match(msg(await post(`/entrevistas/${ivId}/verificar`, {}, cli.cookie)), /Verificação pedida/);
  await drain();
  const j = await db.one(`SELECT state, error FROM jobs WHERE interview_id=$1 AND kind='check_answers' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  assert.equal(j.state, 'done', j.error ?? '');
  pg = (await get(`/entrevistas/${ivId}`, cli.cookie)).body;
  assert.equal((pg.match(/Respondida, mas sem voz audível/g) ?? []).length, 2, 'a resposta antiga também ficou marcada');
  assert.equal((pg.match(/Transcrição de verificação/g) ?? []).length, 1, 'só a que tem voz é transcrita');
  assert.match(pg, /name="q" value="[^"]+" checked> <span>Pergunta 2/);
  assert.match(pg, /name="q" value="[^"]+" > <span>Pergunta 1/);
  // outro entrevistador não verifica nem pede nada
  const other = `sid=${cookies(await post('/registar', { name: 'Outro', email: 'outro@example.com', password: PW, terms: 1 })).sid}`;
  assert.equal((await post(`/entrevistas/${ivId}/verificar`, {}, other)).statusCode, 404);
  assert.equal((await post(`/entrevistas/${ivId}/gravar-de-novo`, { q: ['x'] }, other)).statusCode, 404);
});

test('fotografias: antes da submissão, o entrevistador acrescenta as que o entrevistado lhe mandou (por exemplo, pelo WhatsApp)', async () => {
  const pg = (await get(`/entrevistas/${ivId}`, cli.cookie)).body;
  assert.match(pg, /Acrescentar uma fotografia que o entrevistado lhe enviou \(por exemplo, pelo WhatsApp ou por email\)/);
  assert.match(pg, /que ainda não deu/, 'sem a autorização de publicação de fotografias do entrevistado');
  assert.match(pg, /src="\/static\/guest-photo\.js"/);
  const jpg = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#865' } }).jpeg().toBuffer();
  const up = (h: Record<string, string>) => app.inject({ method: 'POST', url: `/api/entrevistas/${ivId}/foto-convidado`, payload: jpg, headers: { 'content-type': 'image/jpeg', cookie: cli.cookie, ...h } });
  assert.equal((await up({})).statusCode, 422, 'sem confirmar os direitos');
  for (let i = 0; i < 3; i++) assert.equal((await up({ 'x-photo-rights': '1' })).statusCode, 200);
  assert.equal((await up({ 'x-photo-rights': '1' })).statusCode, 409, 'no máximo 3');
  const after = (await get(`/entrevistas/${ivId}`, cli.cookie)).body;
  assert.equal((after.match(/acrescentada por si/g) ?? []).length, 3);
  assert.match(after, /Já acrescentou 3 fotografias/);
});

test('gravar de novo: email com as perguntas e a nota, link novo, aviso ao entrevistado; uma resposta nova cumpre o pedido', async () => {
  const qs = await db.query('SELECT id, position FROM questions WHERE interview_id=$1 ORDER BY position', [ivId]);
  assert.match(msg(await post(`/entrevistas/${ivId}/gravar-de-novo`, { note: 'O microfone não captou a voz.' }, cli.cookie)), /Escolha as respostas/);
  assert.match(msg(await post(`/entrevistas/${ivId}/gravar-de-novo`, { q: [qs[1].id, qs[2].id], note: 'O microfone não captou a voz.' }, cli.cookie)), /Pedido enviado ao entrevistado \(perguntas 2, 3\)/);
  await flushOutbox(db);
  const em = await db.one(`SELECT subject, text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  assert.match(em.subject, /pede-lhe que grave de novo 2 respostas — Hotelaria/);
  assert.match(em.text_body, /O microfone não captou a voz\./);
  assert.match(em.text_body, /Grave de novo, por favor: Pergunta 2, Pergunta 3\./);
  assert.equal((await get('/entrevista', guest)).statusCode, 302, 'o link anterior foi revogado');
  const g2 = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(em.text_body)![1]}/abrir`, {})).gs}`;
  const ov = (await get('/entrevista', g2)).body;
  assert.match(ov, /O entrevistador pediu que grave de novo:<\/strong> <a href="\/entrevista\/p\/2">Pergunta 2<\/a>, <a href="\/entrevista\/p\/3">Pergunta 3<\/a>/);
  assert.match(ov, /O microfone não captou a voz\./);
  assert.match((await get('/entrevista/p/2', g2)).body, /O entrevistador pediu que grave de novo:<\/strong> Pergunta 2/);
  assert.equal((await raw(`/api/g/respostas/${qs[1].id}`, makeToneWav(4), 'audio/wav', g2)).statusCode, 200);
  const left = await db.query('SELECT q.position FROM answers a JOIN questions q ON q.id=a.question_id WHERE a.interview_id=$1 AND a.redo_requested_at IS NOT NULL ORDER BY q.position', [ivId]);
  assert.deepEqual(left.map((r: any) => r.position), [3]);
  assert.match((await get(`/entrevistas/${ivId}`, cli.cookie)).body, /pedido para gravar de novo/);
});

test('gravar de novo depois da submissão: a entrevista é reaberta para o entrevistado gravar e submeter de novo', async () => {
  const qs = await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [ivId]);
  const em0 = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  const g = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(em0.text_body)![1]}/abrir`, {})).gs}`;
  assert.equal((await raw(`/api/g/respostas/${qs[2].id}`, makeToneWav(2), 'audio/wav', g)).statusCode, 200);
  await post('/entrevista/submeter', {}, g);
  assert.equal((await db.one('SELECT collection_status FROM interviews WHERE id=$1', [ivId])).collection_status, 'submitted');
  assert.equal((await raw(`/api/g/respostas/${qs[0].id}`, makeToneWav(2), 'audio/wav', g)).statusCode, 409, 'submetida: não grava');
  const r = await post(`/entrevistas/${ivId}/gravar-de-novo`, { q: [qs[0].id], note: 'Repita a primeira, por favor.' }, cli.cookie);
  assert.match(msg(r), /Pedido enviado/);
  assert.equal((await db.one('SELECT collection_status FROM interviews WHERE id=$1', [ivId])).collection_status, 'reopened');
});

test('avisos: o titular vê no portal o que o entrevistado fez (abriu, aceitou, respostas sem voz, submeteu), com o número por ler', async () => {
  const pd = (await get('/painel', cli.cookie)).body;
  assert.match(pd, /<a href="\/avisos">Avisos <span class="badge" aria-hidden="true">\d+<\/span>/);
  const pg = (await get('/avisos', cli.cookie)).body;
  for (const s of ['Rui abriu o convite', 'Rui aceitou participar', 'A resposta à pergunta 2 parece não ter voz', 'Rui respondeu a todas as perguntas', 'Rui submeteu a entrevista'])
    assert.ok(pg.includes(s), s);
  assert.match(pg, /Respostas: 3 de 3 \(3 gravadas/);
  assert.doesNotMatch((await get('/painel', cli.cookie)).body, /<a href="\/avisos">Avisos <span class="badge"/, 'abrir os avisos marca-os como lidos');
  // a atividade aparece na página da entrevista e não passa para outra conta
  assert.match((await get(`/entrevistas/${ivId}`, cli.cookie)).body, /Atividade do entrevistado e da produção/);
  const other = `sid=${cookies(await post('/entrar', { email: 'outro@example.com', password: PW })).sid}`;
  assert.doesNotMatch((await get('/avisos', other)).body, /Rui/);
});

test('autorizações das fotografias: uma escolha incompleta (capa, publicação ou vídeo sem a captação) não se grava como recusa', async () => {
  const em = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  const g = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(em.text_body)![1]}/abrir`, {})).gs}`;
  const before = Number((await db.one(`SELECT count(*)::int AS n FROM consents WHERE interview_id=$1`, [ivId])).n);
  const r = await post('/entrevista/fotos/autorizacoes', { cover_use: '1', publish_photo: '1', ai_video: '1', host_edit: '1' }, g);
  assert.equal(r.headers.location, '/entrevista/fotos?e=capture#autorizacoes');
  assert.match((await get('/entrevista/fotos?e=capture', g)).body, /assinale também a primeira caixa/);
  assert.equal(Number((await db.one(`SELECT count(*)::int AS n FROM consents WHERE interview_id=$1`, [ivId])).n), before, 'nada gravado');
  assert.equal((await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', ai_video: '1', host_edit: '1' }, g)).headers.location, '/entrevista/fotos?e=publish#autorizacoes');
  const ok = await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1', host_edit: '1' }, g);
  assert.equal(ok.headers.location, '/entrevista/fotos?ok=1#autorizacoes');
  const c = await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose='ai_video' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  assert.equal(c.granted, true);
  assert.match((await get('/avisos', cli.cookie)).body, /Rui atualizou as autorizações das fotografias/);
});
