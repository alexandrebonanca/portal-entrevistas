import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { runOne } = await import('../src/jobs.ts');
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const { regenerationsUsed } = await import('../src/limits.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie = '') => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const audio = (url: string, wav: Buffer, cookie: string) => app.inject({ method: 'POST', url, payload: wav, headers: { 'content-type': 'audio/wav', cookie } });
const msgOf = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const PW = 'uma-palavra-passe-longa';
let admin = '', user = '', userId = '', ivId = '', guest = '';

/** Rascunho completo (perguntas, convidado em inglês) pronto a convidar. */
const draft = async (who: string, title: string, questions: string[]) => {
  const c = await post('/entrevistas', { title }, who);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  for (const text of questions) await post(`/entrevistas/${id}/perguntas`, { text }, who);
  await post(`/entrevistas/${id}/guardar`, { title, objective_text: 'Objetivo', host_name: 'Zé', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en' }, who);
  return id;
};
/** Abre o link mais recente enviado ao convidado e devolve a sessão dele. */
const openLatest = async (id: string) => {
  const m = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [id]);
  const tk = /\/i\/([A-Za-z0-9_-]{40,})/.exec(m.text_body)![1];
  return `gs=${cookies(await post(`/i/${tk}/abrir`, {}, '')).gs}`;
};
const qids = async (id: string) => (await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [id])).map((r: any) => r.id);

test('o convite fixa na entrevista os limites do plano; o administrador não tem limite', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  user = `sid=${cookies(await post('/registar', { name: 'Zé', email: 'ze@example.com', password: PW, terms: 1 })).sid}`;
  userId = (await db.one(`SELECT id FROM users WHERE email='ze@example.com'`)).id;
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'starter','active','manual')`, [userId]);
  // por omissão, cada plano tem 15 perguntas e 15 min de respostas por entrevista
  const p = await db.one(`SELECT max_questions, max_answer_total_sec FROM plans WHERE id='starter'`);
  assert.deepEqual([p.max_questions, p.max_answer_total_sec], [15, 900]);
  await db.query(`UPDATE plans SET max_answer_total_sec=60, max_questions=3 WHERE id='starter'`);

  ivId = await draft(user, 'Limites', ['Primeira?', 'Segunda?']);
  const page = await get(`/entrevistas/${ivId}/convidar`, user);
  assert.match(page.body, /até 3 perguntas, incluindo as adicionais; até 1:00 min de respostas do entrevistado no total/);
  assert.match((await post(`/entrevistas/${ivId}/convidar`, {}, user)).headers.location as string, /ok=/);
  let iv = await db.one('SELECT answer_limit_sec, question_limit FROM interviews WHERE id=$1', [ivId]);
  assert.deepEqual([iv.answer_limit_sec, iv.question_limit], [60, 3]);
  // mudar o plano depois do convite não altera o que foi prometido ao convidado
  await db.query(`UPDATE plans SET max_answer_total_sec=900, max_questions=15 WHERE id='starter'`);
  iv = await db.one('SELECT answer_limit_sec, question_limit FROM interviews WHERE id=$1', [ivId]);
  assert.deepEqual([iv.answer_limit_sec, iv.question_limit], [60, 3]);
  assert.match((await get(`/entrevistas/${ivId}`, user)).body, /Perguntas: 2 de 3 \(incluindo as adicionais\) · tempo de resposta que resta ao entrevistado: 1:00 de 1:00/);

  // o administrador muda os limites do plano nas Definições (minutos de respostas)
  await post('/admin/planos/starter', { name: 'Starter', price: '10', limit: '5', max_questions: '2', answer_min: '20', active: '1' }, admin);
  assert.deepEqual(Object.values(await db.one(`SELECT max_questions, max_answer_total_sec FROM plans WHERE id='starter'`)), [2, 1200]);
  assert.match((await get('/admin/definicoes', admin)).body, /name="max_questions"[^>]+value="2"[\s\S]*name="answer_min"[^>]+value="20"/);
  // sem os campos novos (formulário antigo), os limites mantêm-se
  await post('/admin/planos/starter', { name: 'Starter', price: '10', limit: '5', active: '1' }, admin);
  assert.equal((await db.one(`SELECT max_questions FROM plans WHERE id='starter'`)).max_questions, 2);
  assert.match(msgOf(await post('/admin/planos/starter', { name: 'Starter', price: '10', limit: '5', max_questions: '0', active: '1' }, admin)), /inválidos/);

  // no rascunho, o máximo de perguntas é o do plano (também ao duplicar); acima dele não se convida
  const d = await draft(user, 'Rascunho', ['A?', 'B?', 'C?']);
  assert.equal((await qids(d)).length, 2, 'a terceira pergunta é recusada');
  assert.match(msgOf(await post(`/entrevistas/${d}/perguntas`, { text: 'C?' }, user)), /Limite de 2 perguntas por entrevista/);
  assert.match(msgOf(await post(`/entrevistas/${d}/perguntas/${(await qids(d))[0]}/duplicar`, {}, user)), /Limite de 2 perguntas/);
  assert.equal((await qids(d)).length, 2);
  await db.query(`UPDATE plans SET max_questions=1 WHERE id='starter'`);
  assert.match((await get(`/entrevistas/${d}/convidar`, user)).body, /Tem 2 perguntas; o seu plano permite até 1 por entrevista/);
  await post(`/entrevistas/${d}/convidar`, {}, user);
  assert.equal((await db.one('SELECT collection_status s FROM interviews WHERE id=$1', [d])).s, 'draft');
  await db.query(`UPDATE plans SET max_answer_total_sec=900, max_questions=15 WHERE id='starter'`);

  // o administrador não tem limite: a entrevista fica sem limites
  const a = await draft(admin, 'Do administrador', ['Uma?']);
  assert.match((await get(`/entrevistas/${a}/convidar`, admin)).body, /sem limite de perguntas nem de tempo total \(administrador\)/);
  await post(`/entrevistas/${a}/convidar`, {}, admin);
  const ai = await db.one('SELECT collection_status, answer_limit_sec, question_limit FROM interviews WHERE id=$1', [a]);
  assert.deepEqual([ai.collection_status, ai.answer_limit_sec, ai.question_limit], ['invited', null, null]);
  for (let i = 0; i < 2; i++) assert.match((await post(`/entrevistas/${a}/adicional`, { text: `Extra ${i}?` }, admin)).headers.location as string, /ok=/);
});

test('respostas do convidado: tempo total de todas as perguntas, 2 s de tolerância, 422 com o tempo que resta', async () => {
  await flushOutbox(db);
  guest = await openLatest(ivId);
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, guest);
  const [q1, q2] = await qids(ivId);
  assert.match((await get('/entrevista', guest)).body, /Total time for your answers: 1:00 min \(1:00 left\)\./);
  let pg = await get('/entrevista/p/1', guest);
  assert.match(pg.body, /Time left <strong>1:00<\/strong>/);
  assert.match(pg.body, /&quot;maxSec&quot;:60,/, 'o gravador pára no tempo que resta');

  let r = await audio(`/api/g/respostas/${q1}`, makeToneWav(25), guest);
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().remainingSec, 35);
  pg = await get('/entrevista/p/2', guest);
  assert.match(pg.body, /Time left <strong>0:35<\/strong>/); assert.match(pg.body, /&quot;maxSec&quot;:35,/);

  // 25 + 40 s passa o limite (60 + 2 s): recusado, sem guardar o ficheiro
  const before = Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='answer_audio'`, [ivId])).n);
  r = await audio(`/api/g/respostas/${q2}`, makeToneWav(40), guest);
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, 'overTotal'); assert.equal(r.json().remainingSec, 35);
  assert.match(r.json().message, /goes over the total answer time for this interview\. Time available for this answer: 0:35\./, 'mensagem na língua do convidado');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='answer_audio'`, [ivId])).n), before);
  assert.equal(await db.one('SELECT 1 FROM answers WHERE question_id=$1', [q2]), undefined);

  // 25 + 36 s cabe na tolerância; não resta tempo
  r = await audio(`/api/g/respostas/${q2}`, makeToneWav(36), guest);
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().remainingSec, 0);
  // gravar de novo a 1.ª pergunta substitui a resposta anterior (não soma as duas)
  r = await audio(`/api/g/respostas/${q1}`, makeToneWav(10), guest);
  assert.equal(r.statusCode, 200, r.body); assert.equal(r.json().remainingSec, 14);
  pg = await get('/entrevista/p/1', guest);
  assert.match(pg.body, /Time left <strong>0:14<\/strong>/); assert.match(pg.body, /&quot;maxSec&quot;:24,/, 'uma nova gravação pode usar o tempo da resposta que substitui');
});

test('pergunta adicional: limite de perguntas, menos de 30 s de resposta, cancelada ou expirada', async () => {
  // restam 14 s ao convidado: não se acrescentam perguntas
  let r = await post(`/entrevistas/${ivId}/adicional`, { text: 'Terceira?' }, user);
  assert.match(msgOf(r), /Restam 0:14 de tempo de resposta ao entrevistado \(menos de 30 s\)/);
  assert.equal((await qids(ivId)).length, 2);
  const ed = (await get(`/entrevistas/${ivId}/editar`, user)).body;
  assert.match(ed, /Perguntas: 2 de 3/); assert.match(ed, /<button class="accent" disabled>Acrescentar e reenviar convite/);

  // o convidado recusa a 2.ª pergunta: volta a haver tempo
  const [, q2] = await qids(ivId);
  await post(`/api/g/respostas/${q2}/recusar-form`, {}, guest);
  r = await post(`/entrevistas/${ivId}/adicional`, { text: 'Terceira?' }, user);
  assert.match(r.headers.location as string, /ok=/);
  // 3 perguntas, incluindo a adicional: chegou ao limite do convite
  r = await post(`/entrevistas/${ivId}/adicional`, { text: 'Quarta?' }, user);
  assert.match(msgOf(r), /Atingiu o limite de 3 perguntas desta entrevista \(incluindo as adicionais\)/);
  assert.equal((await qids(ivId)).length, 3);

  // a adicional conta para o tempo total: com 10 + 52 s já não resta tempo e a gravação fica travada
  await flushOutbox(db);
  guest = await openLatest(ivId); // o link novo revoga o anterior
  const q3 = (await qids(ivId))[2];
  const up = await audio(`/api/g/respostas/${q3}`, makeToneWav(52), guest);
  assert.equal(up.statusCode, 200, up.body); assert.equal(up.json().remainingSec, 0);
  const p2 = (await get('/entrevista/p/2', guest)).body;
  assert.match(p2, /<button type="button" id="recBtn" class="recbtn" aria-label="Record answer" disabled>/);
  assert.match(p2, /You have used all the answer time for this interview/);
  const over = await audio(`/api/g/respostas/${q2}`, makeToneWav(3), guest);
  assert.equal(over.statusCode, 422); assert.equal(over.json().remainingSec, 0);

  // entrevista expirada ou cancelada: recusada mesmo abaixo dos limites
  await db.query(`UPDATE interviews SET question_limit=10, answer_limit_sec=900, collection_status='expired' WHERE id=$1`, [ivId]);
  assert.match(msgOf(await post(`/entrevistas/${ivId}/adicional`, { text: 'Quarta?' }, user)), /O convite expirou/);
  await db.query(`UPDATE interviews SET collection_status='started' WHERE id=$1`, [ivId]);
  await post(`/entrevistas/${ivId}/cancelar`, {}, user);
  assert.match(msgOf(await post(`/entrevistas/${ivId}/adicional`, { text: 'Quarta?' }, user)), /A entrevista foi cancelada/);
  assert.equal((await qids(ivId)).length, 3);
});

test('áudio do entrevistador: até 2 min por pergunta e 5 min no objetivo; o administrador não tem limite', async () => {
  const id = await draft(user, 'Áudio', ['Pergunta gravada?']);
  const [q] = await qids(id);
  const ed = (await get(`/entrevistas/${id}/editar`, user)).body;
  assert.match(ed, /objetivo-audio" data-max="300"/); assert.match(ed, /\/audio" data-max="120"/);
  let r = await audio(`/api/entrevistas/${id}/perguntas/${q}/audio`, makeToneWav(123), user);
  assert.equal(r.statusCode, 422); assert.match(r.json().error, /cada pergunta pode ter até 2:00 min/);
  assert.equal((await db.one('SELECT audio_asset_id FROM questions WHERE id=$1', [q])).audio_asset_id, null);
  r = await audio(`/api/entrevistas/${id}/perguntas/${q}/audio`, makeToneWav(121), user);
  assert.equal(r.statusCode, 200, r.body);
  r = await audio(`/api/entrevistas/${id}/objetivo-audio`, makeToneWav(303), user);
  assert.equal(r.statusCode, 422); assert.match(r.json().error, /o objetivo pode ter até 5:00 min/);
  r = await audio(`/api/entrevistas/${id}/objetivo-audio`, makeToneWav(301), user);
  assert.equal(r.statusCode, 200, r.body);

  const a = await draft(admin, 'Áudio do administrador', ['Pergunta?']);
  r = await audio(`/api/entrevistas/${a}/perguntas/${(await qids(a))[0]}/audio`, makeToneWav(123), admin);
  assert.equal(r.statusCode, 200, r.body);
});

test('regenerações do guião e do episódio: 3 incluídas, a 4.ª bloqueada (custa 1 crédito); o administrador não tem limite', async () => {
  const id = await draft(user, 'Regenerações', ['Só uma?']);
  await post(`/entrevistas/${id}/convidar`, {}, user);
  await flushOutbox(db);
  const g = await openLatest(id);
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, g);
  assert.equal((await audio(`/api/g/respostas/${(await qids(id))[0]}`, makeToneWav(2), g)).statusCode, 200);
  await post('/entrevista/submeter', {}, g);
  const used = () => regenerationsUsed(db, id);
  const prepJobs = async () => Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1 AND kind='prepare_script'`, [id])).n);

  // o primeiro processamento não conta; cada «Regenerar guião» conta
  await post(`/entrevistas/${id}/processar`, {}, user); await drain();
  assert.equal(await used(), 0);
  assert.match((await get(`/entrevistas/${id}/producao`, user)).body, /Regenerações do guião e do episódio: <strong id="regen">0 de 3<\/strong> incluídas/);
  await post(`/entrevistas/${id}/guiao/regenerar`, {}, user);
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/regenerar`, {}, user)), /trabalho de produção igual em curso/, 'duplo clique: uma só regeneração');
  await drain();
  assert.equal(await used(), 1); assert.equal(await prepJobs(), 1);
  await post(`/entrevistas/${id}/guiao/regenerar`, {}, user); await drain();
  assert.equal(await used(), 2);
  // recomeçar e processar de novo refaz o guião: também conta
  assert.match(msgOf(await post(`/entrevistas/${id}/producao/recomecar`, {}, user)), /recomeçada/);
  await post(`/entrevistas/${id}/processar`, {}, user); await drain();
  assert.equal(await used(), 3);
  assert.equal((await db.one('SELECT production_status s FROM interviews WHERE id=$1', [id])).s, 'editorial_review');

  // a 4.ª fica bloqueada: botões desativados e pedidos recusados no servidor
  const pg = (await get(`/entrevistas/${id}/producao`, user)).body;
  assert.match(pg, /<strong id="regen">3 de 3<\/strong>/);
  assert.match(pg, /<button class="ghost" disabled>Regenerar guião/); assert.match(pg, /<button class="danger" disabled>Recomeçar produção/);
  assert.match(pg, /Cada regeneração seguinte custa 1 crédito/);
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/regenerar`, {}, user)), /Já usou as 3 regenerações incluídas nesta entrevista \(guião e episódio\)\. Cada regeneração seguinte custa 1 crédito/);
  assert.equal(await prepJobs(), 2);
  assert.match(msgOf(await post(`/entrevistas/${id}/producao/recomecar`, {}, user)), /custa 1 crédito[\s\S]*não é possível recomeçar/);
  assert.ok(await db.one(`SELECT 1 FROM scripts WHERE interview_id=$1 AND status='draft'`, [id]), 'o guião atual não foi arquivado');

  // o primeiro episódio está incluído; gerar outro é uma regeneração
  await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, user);
  assert.match((await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en'] }, user)).headers.location as string, /ok=/);
  await drain();
  assert.ok(await db.one('SELECT 1 FROM episodes WHERE interview_id=$1', [id]), 'episódio gerado');
  assert.match((await get(`/entrevistas/${id}/producao`, user)).body, /Regenerações do guião e do episódio: <strong id="regen">3 de 3/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en', 'pt-PT'] }, user)), /custa 1 crédito/);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [id])).n), 1);

  // o administrador não fica bloqueado e as regenerações dele não contam
  assert.match((await post(`/entrevistas/${id}/guiao/regenerar`, {}, admin)).headers.location as string, /ok=/);
  await drain();
  assert.equal(await prepJobs(), 3); assert.equal(await used(), 3);
  assert.match((await get(`/entrevistas/${id}/producao`, admin)).body, /3 de 3<\/strong> incluídas \(o administrador não tem limite/);

  // uma regeneração que falhou não conta
  await db.query(`UPDATE jobs SET state='failed' WHERE id=(SELECT id FROM jobs WHERE interview_id=$1 AND input->>'regen'='true' ORDER BY created_at LIMIT 1)`, [id]);
  assert.equal(await used(), 2);
  assert.match((await post(`/entrevistas/${id}/guiao/regenerar`, {}, user)).headers.location as string, /ok=/);
  assert.equal(await used(), 3);
});
