import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Espaço dos ficheiros enviados (tetos por entrevista e por conta sem pagamento) e apagamento do que deixou de servir:
// respostas substituídas ou recusadas antes da submissão, gravações do entrevistador substituídas ou de perguntas
// eliminadas, e vídeos só com fotografias substituídos antes de irem para o ar (src/uploads.ts).
process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-arm-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { runOne } = await import('../src/jobs.ts');
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav, saveAsset } = await import('../src/media.ts');
const U = await import('../src/uploads.ts');
const sharp = (await import('sharp')).default;

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie = '') => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const raw = (url: string, data: Buffer, cookie: string, type = 'audio/wav', extra: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: data, headers: { 'content-type': type, cookie, ...extra } });
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const fileOf = (key: string) => join(process.env.STORAGE_DIR!, key);
const asset = (id: string) => db.one('SELECT * FROM assets WHERE id=$1', [id]);
const selected = async (qid: string) => (await db.one(`SELECT t.id AS take_id, t.asset_id FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id WHERE an.question_id=$1`, [qid]));
const jpeg = (w: number, h: number, noise = false) => noise
  ? sharp(Buffer.from(Array.from({ length: w * h * 3 }, () => Math.floor(Math.random() * 256))), { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 95 }).toBuffer()
  : sharp({ create: { width: w, height: h, channels: 3, background: '#88aacc' } }).jpeg().toBuffer();
const MB = 1024 * 1024;
const limits = config.limits as any;
const saved = { iv: limits.interviewUploadMb, acc: limits.unpaidAccountUploadMb };
const restore = () => { limits.interviewUploadMb = saved.iv; limits.unpaidAccountUploadMb = saved.acc; };

let admin = '', ivId = '', guest = '', qs: string[] = [];

test('preparar: administrador, entrevista com 3 perguntas e sessão do convidado', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Ana', email: 'ana@example.com', password: 'uma-palavra-passe-longa', terms: '1' })).sid}`;
  const c = await post('/entrevistas', { title: 'Armazenamento' }, admin);
  ivId = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  for (const text of ['Primeira?', 'Segunda?', 'Terceira?']) await post(`/entrevistas/${ivId}/perguntas`, { text }, admin);
  await post(`/entrevistas/${ivId}/guardar`, { title: 'Armazenamento', objective_text: 'Teste', host_name: 'Ana', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'pt-PT', answer_lang: 'pt', review_policy: 'guest_preview', subtitle_langs: 'en' }, admin);
  assert.match((await post(`/entrevistas/${ivId}/convidar`, {}, admin)).headers.location as string, /ok=/);
  await flushOutbox(db);
  const m = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%'`, [ivId]);
  guest = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(m.text_body)![1]}/abrir`, {})).gs}`;
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1', photo_capture: '1' }, guest);
  qs = (await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [ivId])).map((r: any) => r.id);
  await db.query(`INSERT INTO consents(interview_id, purpose, granted, text_version, text_snapshot) VALUES ($1,'photo_capture',true,'t','t')`, [ivId]);
});

test('resposta gravada de novo: a anterior sai do disco; a mesma (repetida pelo cliente) não; texto substituído leva a transcrição', async () => {
  const r1 = await raw(`/api/g/respostas/${qs[0]}`, makeToneWav(2), guest, 'audio/wav', { 'x-upload-id': 'a-1' });
  assert.equal(r1.statusCode, 200, r1.body);
  const a1 = await asset(r1.json().assetId);
  assert.ok(existsSync(fileOf(a1.storage_key)));
  // o cliente repete o mesmo envio (rede): idempotente, nada apagado
  assert.equal((await raw(`/api/g/respostas/${qs[0]}`, makeToneWav(2), guest, 'audio/wav', { 'x-upload-id': 'a-1' })).json().duplicate, true);
  assert.equal((await asset(a1.id)).deleted_at, null);
  const r2 = await raw(`/api/g/respostas/${qs[0]}`, makeToneWav(3), guest, 'audio/wav', { 'x-upload-id': 'a-2' });
  assert.equal(r2.statusCode, 200);
  const old = await asset(a1.id);
  assert.ok(old.deleted_at, 'a gravação anterior fica marcada como apagada');
  assert.equal(old.meta.erased, 'replaced');
  assert.equal(existsSync(fileOf(a1.storage_key)), false, 'e sai do disco');
  assert.equal((await get(`/api/g/media/${a1.id}`, guest)).statusCode, 404);
  assert.equal((await selected(qs[0])).asset_id, r2.json().assetId);
  assert.equal((await get(`/api/g/media/${r2.json().assetId}`, guest)).statusCode, 200);

  // resposta escrita substituída por uma gravação: o texto e a transcrição «document» saem
  const d = await raw(`/api/g/respostas/${qs[1]}/documento`, Buffer.from('Resposta escrita que vai ser trocada.'), guest, 'text/plain');
  assert.equal(d.statusCode, 200, d.body);
  const dt = d.json().takeId;
  assert.ok(await db.one(`SELECT 1 FROM transcripts WHERE source_kind='answer_take' AND source_id=$1`, [dt]));
  assert.equal((await raw(`/api/g/respostas/${qs[1]}`, makeToneWav(2), guest)).statusCode, 200);
  assert.equal(await db.one(`SELECT 1 FROM transcripts WHERE source_kind='answer_take' AND source_id=$1`, [dt]), undefined);
  assert.ok((await asset(d.json().assetId)).deleted_at);

  // recusar a pergunta apaga a resposta que lá estava
  const r3 = await raw(`/api/g/respostas/${qs[2]}`, makeToneWav(2), guest);
  await post(`/api/g/respostas/${qs[2]}/recusar-form`, {}, guest);
  assert.ok((await asset(r3.json().assetId)).deleted_at, 'recusada: a gravação anterior sai');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM answer_takes t JOIN answers an ON an.id=t.answer_id WHERE an.interview_id=$1`, [ivId])).n), 5, 'o histórico dos takes fica (só os ficheiros saem)');
});

test('teto por entrevista: recusa com 413 e mensagem na língua do convidado, nada fica no disco; substituir a mesma resposta não conta a anterior', async () => {
  const used = Number((await db.one(`SELECT COALESCE(sum(size),0)::bigint b FROM assets WHERE interview_id=$1 AND deleted_at IS NULL`, [ivId])).b);
  limits.interviewUploadMb = (used + 200_000) / MB; // cabe uma gravação de 2 s (~96 KB), não duas
  try {
    const before = Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1`, [ivId])).n);
    const ok = await raw(`/api/g/respostas/${qs[2]}`, makeToneWav(2), guest);
    assert.equal(ok.statusCode, 200, ok.body);
    // a mesma pergunta outra vez: a anterior não conta, porque é substituída
    const again = await raw(`/api/g/respostas/${qs[2]}`, makeToneWav(2.5), guest);
    assert.equal(again.statusCode, 200, again.body);
    // uma fotografia de ~150 KB já não cabe
    const ph = await raw('/api/g/fotos', await jpeg(300, 300, true), guest, 'image/jpeg');
    assert.equal(ph.statusCode, 413);
    assert.equal(ph.json().error, 'storage');
    assert.match(ph.json().message, /atingiu o limite de espaço para ficheiros/);
    assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1`, [ivId])).n), before + 2, 'a recusa prévia não grava nada');
    // em inglês
    await db.query(`UPDATE interviews SET interaction_lang='en' WHERE id=$1`, [ivId]);
    const en = await raw(`/api/g/respostas/${qs[0]}/documento`, Buffer.from('x '.repeat(150_000)), guest, 'text/plain');
    assert.ok([413, 422].includes(en.statusCode));
    const big = await raw(`/api/g/respostas/${qs[1]}`, makeToneWav(5), guest);
    assert.equal(big.statusCode, 413);
    assert.match(big.json().message, /reached its storage limit/);
    await db.query(`UPDATE interviews SET interaction_lang='pt-PT' WHERE id=$1`, [ivId]);
  } finally { restore(); }
});

test('decisão na transação: com o ficheiro já guardado e o teto passado entretanto, o novo é recusado e apagado', async () => {
  // Como dois envios em simultâneo: a verificação prévia de ambos passou e o segundo já não cabe na transação.
  const used = Number((await db.one(`SELECT COALESCE(sum(size),0)::bigint b FROM assets WHERE interview_id=$1 AND deleted_at IS NULL AND kind IN ('answer_audio','answer_text','guest_photo','host_photo','objective_audio','question_audio')`, [ivId])).b);
  const room = await U.uploadRoom(db, ivId, 0);
  assert.equal(room, null);
  limits.interviewUploadMb = (used + 10) / MB;
  try {
    const r = await U.reserveUploadRoom(db, ivId, {});
    assert.equal(r, null, 'o que já está guardado cabe');
    const id = await saveAsset(db, { interviewId: ivId, kind: 'guest_photo', mime: 'image/jpeg', ext: 'jpg', data: await jpeg(64, 64) });
    const no = await db.tx((tx: any) => U.reserveUploadRoom(tx, ivId, {}));
    assert.equal(no?.scope, 'interview');
    assert.ok(no.usedMb >= 0);
    await U.discardAsset(db, id, 'refused');
    assert.ok((await asset(id)).deleted_at);
    // o administrador não tem teto
    assert.equal(await U.uploadRoom(db, ivId, 50 * MB, { admin: true }), null);
  } finally { restore(); }
});

test('teto por conta sem pagamento: soma as entrevistas da conta; contas pagas e o administrador não o têm', async () => {
  const r = await post('/admin/utilizadores', { name: 'Bia', email: 'bia@example.com', password: 'uma-palavra-passe-longa', role: 'interviewer' }, admin);
  assert.equal(r.statusCode, 302);
  const bia = `sid=${cookies(await post('/entrar', { email: 'bia@example.com', password: 'uma-palavra-passe-longa' })).sid}`;
  const mk = async (title: string) => /entrevistas\/([0-9a-f-]{36})/.exec((await post('/entrevistas', { title }, bia)).headers.location as string)![1];
  const a = await mk('Rascunho A'), b = await mk('Rascunho B');
  const photo = await jpeg(400, 400, true);
  limits.unpaidAccountUploadMb = (photo.length * 1.5) / MB; // cabe uma fotografia, não duas
  limits.interviewUploadMb = 0; // desligado: só conta o da conta
  try {
    const p1 = await raw(`/api/entrevistas/${a}/foto`, photo, bia, 'image/jpeg');
    assert.equal(p1.statusCode, 200, p1.body);
    const p2 = await raw(`/api/entrevistas/${b}/foto`, photo, bia, 'image/jpeg');
    assert.equal(p2.statusCode, 413, 'noutra entrevista da mesma conta');
    assert.match(p2.json().error, /As entrevistas desta conta sem subscrição atingiram o limite/);
    assert.equal((await db.one('SELECT host_photo_asset_id FROM interviews WHERE id=$1', [b])).host_photo_asset_id, null);
    // o administrador envia na entrevista dela sem teto
    assert.equal((await raw(`/api/entrevistas/${b}/foto`, photo, admin, 'image/jpeg')).statusCode, 200);
    // com subscrição ativa, o teto da conta deixa de valer
    await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, current_period_end) VALUES ((SELECT id FROM users WHERE email='bia@example.com'),'start','active', now() + interval '20 days')`);
    assert.equal((await raw(`/api/entrevistas/${a}/foto`, photo, bia, 'image/jpeg')).statusCode, 200);
  } finally { restore(); }
});

test('gravações do entrevistador: a substituída e a da pergunta eliminada saem do disco; a partilhada por uma cópia fica; a transcrição na fila termina sem erro', async () => {
  const c = await post('/entrevistas', { title: 'Gravações' }, admin);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: '' }, admin);
  const [q] = (await db.query('SELECT id FROM questions WHERE interview_id=$1', [id])).map((r: any) => r.id);
  const g1 = await raw(`/api/entrevistas/${id}/perguntas/${q}/audio`, makeToneWav(2), admin);
  assert.equal(g1.statusCode, 200, g1.body);
  const g2 = await raw(`/api/entrevistas/${id}/perguntas/${q}/audio`, makeToneWav(3), admin);
  assert.equal(g2.statusCode, 200);
  const old = await asset(g1.json().assetId);
  assert.ok(old.deleted_at); assert.equal(existsSync(fileOf(old.storage_key)), false);
  // a transcrição da primeira, ainda na fila, não falha (a gravação foi substituída)
  await drain();
  const failed = await db.query(`SELECT error FROM jobs WHERE interview_id=$1 AND state='failed'`, [id]);
  assert.deepEqual(failed, []);
  // objetivo gravado duas vezes
  const o1 = await raw(`/api/entrevistas/${id}/objetivo-audio`, makeToneWav(2), admin);
  const o2 = await raw(`/api/entrevistas/${id}/objetivo-audio`, makeToneWav(2), admin);
  assert.equal(o2.statusCode, 200);
  assert.ok((await asset(o1.json().assetId)).deleted_at);
  assert.equal((await asset(o2.json().assetId)).deleted_at, null);
  // pergunta duplicada partilha a gravação: eliminar uma não a apaga; eliminar a outra sim
  await post(`/entrevistas/${id}/perguntas/${q}/duplicar`, {}, admin);
  const copy = (await db.one('SELECT id FROM questions WHERE interview_id=$1 AND id<>$2', [id, q])).id;
  await post(`/entrevistas/${id}/perguntas/${q}/eliminar`, {}, admin);
  assert.equal((await asset(g2.json().assetId)).deleted_at, null, 'a cópia ainda a usa');
  await post(`/entrevistas/${id}/perguntas/${copy}/eliminar`, {}, admin);
  assert.ok((await asset(g2.json().assetId)).deleted_at, 'sem perguntas a usá-la, sai');
});

test('resposta já submetida não é apagada quando a recolha reabre e a pergunta é respondida de novo', async () => {
  for (const q of qs) if (!(await selected(q))) assert.equal((await raw(`/api/g/respostas/${q}`, makeToneWav(2), guest)).statusCode, 200);
  assert.match((await post('/entrevista/submeter', {}, guest)).headers.location as string, /obrigado/);
  const sub = await selected(qs[0]);
  await db.query(`UPDATE interviews SET collection_status='reopened' WHERE id=$1`, [ivId]); // como um pedido adicional
  assert.equal((await raw(`/api/g/respostas/${qs[0]}`, makeToneWav(2), guest)).statusCode, 200);
  assert.equal((await asset(sub.asset_id)).deleted_at, null, 'a resposta submetida é o original entregue e fica');
  assert.equal(await U.discardReplacedTake(db, ivId, sub.take_id), false);
  // repor a resposta submetida como escolhida e voltar a submeter, para a produção seguinte
  await db.query(`UPDATE answers SET selected_take_id=$2 WHERE question_id=$1`, [qs[0], sub.take_id]);
  await db.query(`UPDATE interviews SET collection_status='submitted' WHERE id=$1`, [ivId]);
});

test('vídeo com fotografias: o anterior por publicar sai ao ser substituído; os de versões nunca publicadas saem; publicados e Veo ficam', async () => {
  await post(`/entrevistas/${ivId}/processar`, {}, admin);
  await drain();
  await post(`/entrevistas/${ivId}/guiao/aprovar`, { reviewed: '1' }, admin);
  await post(`/entrevistas/${ivId}/gerar`, { subtitle_langs: ['en'] }, admin);
  await drain();
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND status='preview'`, [ivId]);
  assert.ok(ep, 'episódio em pré-visualização');
  const render = async () => { const r = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en' }, admin); assert.equal(r.statusCode, 302); await drain(); return (await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id as string; };
  const v1 = await render();
  assert.ok(v1, (await db.one(`SELECT error FROM jobs WHERE interview_id=$1 AND kind='render_video' ORDER BY created_at DESC LIMIT 1`, [ivId]))?.error);
  const v2 = await render();
  assert.notEqual(v2, v1);
  const a1 = await asset(v1);
  assert.ok(a1.deleted_at, 'o vídeo anterior, só com fotografias e por publicar, sai');
  assert.equal(a1.meta.erased, 'replaced_unpublished');
  assert.equal(existsSync(fileOf(a1.storage_key)), false);
  assert.equal((await asset(v2)).deleted_at, null);

  // um vídeo do Veo e um vídeo de um episódio que já esteve publicado ficam, mesmo em versões substituídas
  const veo = await saveAsset(db, { interviewId: ivId, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: Buffer.from('veo'), meta: { engine: 'veo' } });
  const pub = await saveAsset(db, { interviewId: ivId, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: Buffer.from('pub'), meta: { animatedSegments: 0 } });
  const orphan = await saveAsset(db, { interviewId: ivId, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: Buffer.from('orf'), meta: {} });
  const sc = ep.script_id;
  const mkEp = async (video: string, publishedAt: string | null) => (await db.one(`INSERT INTO episodes(interview_id, script_id, slug, title, status, video_asset_id, published_at) VALUES ($1,$2,$3,'t','superseded',$4,$5) RETURNING id`, [ivId, sc, `s-${video.slice(0, 8)}`, video, publishedAt])).id;
  await mkEp(veo, null); await mkEp(pub, new Date().toISOString());
  // «Recomeçar»: o episódio atual (com v2) passa a substituído e nunca foi publicado
  await db.query(`UPDATE episodes SET status='superseded' WHERE id=$1`, [ep.id]);
  assert.equal(await U.purgeUnpublishedPhotoVideos(db, ivId), 1);
  assert.ok((await asset(v2)).deleted_at);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id, null);
  for (const [id, what] of [[veo, 'Veo'], [pub, 'já publicado'], [orphan, 'nunca ligado (privado)']]) assert.equal((await asset(id)).deleted_at, null, what);
});

test('textos: FAQ do convidado e /privacy dizem que a resposta anterior é apagada', async () => {
  const { FAQ_SEED } = await import('../src/assistant-faq.ts');
  const e = FAQ_SEED.find((x: any) => x.key === 'convidado-regravar')!;
  assert.match(e.pt[1], /a anterior dessa pergunta é apagada/);
  assert.match(e.en[1], /the earlier one for that question is deleted/);
  assert.doesNotMatch(e.pt[1], /não são apagadas/);
  const p = (await get('/privacy')).body;
  assert.match(p, /replaces the earlier one for that question, which is deleted/);
  assert.match(p, /a video made only with photos is deleted when a new video or version of the episode replaces it before it is ever published/);
});
