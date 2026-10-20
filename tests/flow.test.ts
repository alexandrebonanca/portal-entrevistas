import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';
process.env.ALLOW_SIGNUP = 'false';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { runOne } = await import('../src/jobs.ts');
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav, stripJpegMetadata } = await import('../src/media.ts');
const sharp = (await import('sharp')).default;

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie: string, extra: any = {}) =>
  app.inject({ method: 'POST', url, payload: typeof body === 'string' || Buffer.isBuffer(body) ? body : form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, ...extra } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };

let owner = '', ivId = '', token = '', guest = '';

test('landing em inglês e primeira conta administradora', async () => {
  const r = await get('/');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /lang="en"/);
  assert.match(r.body, /Great interviews, recorded in your guest’s own time/);
  assert.match(r.body, /<span class="wq">quiet<\/span><span class="wi">interview<\/span>/, 'logótipo e nome no cabeçalho');
  assert.match(r.body, /€10/);
  assert.match(r.body, /Up to <strong>5 interviews/);
  assert.match(r.body, /fictional and do not depict any real person/, 'sem fotografias, as ilustrações são identificadas');
  // vídeo de apresentação: legendas por omissão, cartaz e aviso de IA (os ficheiros estáticos são servidos por server.ts)
  assert.match(r.body, /<video controls playsinline preload="none" poster="\/static\/video\/promo\.jpg"/);
  assert.match(r.body, /<track kind="captions" srclang="en" label="English" src="\/static\/video\/promo\.en\.vtt" default>/);
  assert.match(r.body, /AI-generated video and voices \(Google Veo\)[^<]*All people shown are fictional/);
  assert.match(r.body, /by default review before anything is published/, 'a política «só o entrevistador aprova» dispensa o convidado');
  assert.match(r.body, /href="#tour">Watch the 1-minute video/);
  const reg = await post('/registar', { name: 'Ana', email: 'ana@example.com', password: 'uma-palavra-passe-longa', terms: '1' }, '');
  assert.equal(reg.statusCode, 302);
  owner = `sid=${cookies(reg).sid}`;
  assert.equal((await db.one(`SELECT role FROM users WHERE email='ana@example.com'`)).role, 'admin');
});

test('criar entrevista, perguntas e convite', async () => {
  const c = await post('/entrevistas', { title: 'Fibra ótica em Portugal' }, owner);
  ivId = /\/entrevistas\/([0-9a-f-]{36})\/editar/.exec(c.headers.location as string)![1];
  for (const text of ['Qual é o maior desafio?', 'Que conselho dá aos formandos?']) await post(`/entrevistas/${ivId}/perguntas`, { text }, owner);
  // convite sem dados completos é bloqueado
  const bad = await post(`/entrevistas/${ivId}/convidar`, {}, owner);
  assert.match(bad.headers.location as string, /convidar$/);
  assert.equal((await db.one('SELECT collection_status s FROM interviews WHERE id=$1', [ivId])).s, 'draft');
  await post(`/entrevistas/${ivId}/guardar`, { title: 'Fibra ótica em Portugal', objective_text: 'Perceber o mercado', objective_shared: '1', host_name: 'Ana', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'en', answer_lang: 'auto', planned_visibility: 'unlisted', subtitle_langs: ['en', 'pt-PT'], review_policy: 'guest_preview' }, owner);
  const ok = await post(`/entrevistas/${ivId}/convidar`, {}, owner);
  assert.match(ok.headers.location as string, /ok=/);
  // clique duplo: não cria segundo convite
  await post(`/entrevistas/${ivId}/convidar`, {}, owner);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM invitations WHERE interview_id=$1', [ivId])).n), 1);
  await flushOutbox(db);
  const mail = await db.one(`SELECT * FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%'`, [ivId]);
  assert.equal(mail.state, 'sent');
  token = /\/i\/([A-Za-z0-9_-]{40,})/.exec(mail.text_body)![1];
  // convite da marca: explica o portal, sem título repetido, link pessoal com data, recusa e apoio depois do botão, rodapé com o endereço
  assert.equal(mail.subject, 'Ana invites you to an interview — Fibra ótica em Portugal');
  assert.match(mail.html, /<h1[^>]*>You are invited to an interview<\/h1>/);
  assert.equal(mail.html.split('Fibra ótica em Portugal').length - 1, 1, 'o título aparece uma só vez no corpo');
  assert.match(mail.html, /How quietinterview works:[\s\S]*Answer 2 questions[\s\S]*approve it before it is published/);
  assert.match(mail.text_body, /This link is personal; you can answer until \d{1,2} \w+ \d{4}\./);
  assert.ok(mail.html.indexOf('>Open interview</a>') < mail.html.indexOf('I do not wish to take part'), 'recusa e apoio depois do botão');
  assert.match(mail.text_body, /quietinterview — interviews recorded in your own time · test\.local/);
  assert.doesNotMatch(mail.html + mail.text_body, /convida-o\(a\)|Conversations/);
  const { replyTo } = await import('../src/mail.ts');
  assert.equal(replyTo(), '', 'sem contacto de apoio real, não há Reply-To');
  // perguntas bloqueadas depois do convite
  const edit = await post(`/entrevistas/${ivId}/perguntas`, { text: 'extra' }, owner);
  assert.match(edit.headers.location as string, /e=/);
});

test('GET do convite (scanner de email) não consome nem inicia sessão', async () => {
  const r = await get(`/i/${token}`);
  assert.equal(r.statusCode, 200);
  assert.equal(cookies(r).gs, undefined);
  assert.equal((await db.one('SELECT first_opened_at f FROM invitations WHERE interview_id=$1', [ivId])).f, null);
  assert.equal((await db.one('SELECT collection_status s FROM interviews WHERE id=$1', [ivId])).s, 'invited');
  assert.equal((await get('/entrevista')).statusCode, 302, 'sem sessão não há acesso');
  assert.equal((await get('/i/token-inexistente-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')).statusCode, 200);
});

test('abrir com POST cria sessão e remove o token do URL', async () => {
  const r = await post(`/i/${token}/abrir`, {}, '');
  assert.equal(r.headers.location, '/entrevista');
  guest = `gs=${cookies(r).gs}`;
  assert.ok(cookies(r).gs);
  const page = await get('/entrevista', guest);
  assert.match(page.body, /Before you start/);
  assert.doesNotMatch(page.body, new RegExp(token));
});

test('gravar sem consentimento é recusado; depois do consentimento funciona', async () => {
  const qs = await db.query('SELECT * FROM questions WHERE interview_id=$1 ORDER BY position', [ivId]);
  const wav = makeToneWav(2);
  const no = await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[0].id}`, payload: wav, headers: { 'content-type': 'audio/wav', cookie: guest } });
  assert.equal(no.statusCode, 403);
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, guest);
  const up = await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[0].id}`, payload: wav, headers: { 'content-type': 'audio/wav', cookie: guest, 'x-upload-id': 'abc' } });
  assert.equal(up.statusCode, 200, up.body);
  assert.ok(up.json().durationMs > 1500);
  const dup = await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[0].id}`, payload: wav, headers: { 'content-type': 'audio/wav', cookie: guest, 'x-upload-id': 'abc' } });
  assert.equal(dup.json().duplicate, true);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM answer_takes')).n), 1);
  // formato falso é recusado pelo conteúdo, não pelo Content-Type
  const fake = await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[1].id}`, payload: Buffer.from('not audio at all, just text....'), headers: { 'content-type': 'audio/webm', cookie: guest } });
  assert.equal(fake.statusCode, 415);
  // ficheiro de áudio corrompido com cabeçalho válido
  const corrupt = Buffer.concat([Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt '), Buffer.alloc(40)]);
  const bad = await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[1].id}`, payload: corrupt, headers: { 'content-type': 'audio/wav', cookie: guest } });
  assert.equal(bad.statusCode, 422);
});

test('não é possível submeter com perguntas por responder; recusa explícita conta', async () => {
  const early = await post('/entrevista/submeter', {}, guest);
  assert.match(early.headers.location as string, /rever/);
  assert.equal((await db.one('SELECT collection_status s FROM interviews WHERE id=$1', [ivId])).s, 'started');
  const q2 = (await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [ivId]))[1];
  await post(`/api/g/respostas/${q2.id}/recusar-form`, {}, guest);
  assert.equal((await db.one('SELECT status FROM answers WHERE question_id=$1', [q2.id])).status, 'refused');
});

test('selfies: exigem consentimento, remove EXIF, máximo de três', async () => {
  const jpg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#a33' } }).withExif({ IFD0: { Copyright: 'SEGREDO-EXIF' } }).jpeg().toBuffer();
  assert.ok(jpg.includes(Buffer.from('SEGREDO-EXIF')), 'fixture tem EXIF');
  const send = () => app.inject({ method: 'POST', url: '/api/g/fotos', payload: jpg, headers: { 'content-type': 'image/jpeg', cookie: guest } });
  assert.equal((await send()).statusCode, 403);
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1' }, guest);
  for (let i = 0; i < 3; i++) assert.equal((await send()).statusCode, 200);
  assert.equal((await send()).statusCode, 409);
  const a = await db.one(`SELECT storage_key FROM assets WHERE kind='guest_photo' LIMIT 1`);
  const { storage } = await import('../src/storage.ts');
  assert.ok(!(await storage.get(a.storage_key)).includes(Buffer.from('SEGREDO-EXIF')));
  assert.ok(!stripJpegMetadata(jpg).includes(Buffer.from('SEGREDO-EXIF')));
});

test('isolamento: convidado e outros entrevistadores só veem o que é seu', async () => {
  const b = await db.one(`INSERT INTO users(email,name,password_hash) VALUES ('b@example.com','B','x') RETURNING id`);
  const { sha256 } = await import('../src/lib.ts');
  await db.query(`INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2, now() + interval '1 day')`, [sha256('tokB'), b.id]);
  const userB = 'sid=tokB';
  const other = await db.one(`INSERT INTO interviews(owner_id,title) VALUES ($1,'Outra') RETURNING id`, [b.id]);
  const oa = await db.one(`INSERT INTO assets(interview_id,kind,mime,size,sha256,storage_key) VALUES ($1,'answer_audio','audio/wav',1,'x','k') RETURNING id`, [other.id]);
  const mine = await db.one(`SELECT id FROM assets WHERE interview_id=$1 AND kind='answer_audio' LIMIT 1`, [ivId]);
  assert.equal((await get(`/api/g/media/${oa.id}`, guest)).statusCode, 404, 'convidado não vê ativos de outra entrevista');
  assert.equal((await get(`/media/${mine.id}`, userB)).statusCode, 404, 'outro entrevistador não vê os meus ficheiros');
  assert.equal((await get(`/entrevistas/${ivId}`, userB)).statusCode, 404);
  assert.equal((await get(`/entrevistas/${ivId}/producao`, userB)).statusCode, 404);
  assert.equal((await post(`/entrevistas/${ivId}/processar`, {}, userB)).statusCode, 404);
  assert.equal((await get(`/media/${mine.id}`)).statusCode, 401);
  assert.equal((await get(`/entrevistas/not-a-uuid`, owner)).statusCode, 404);
});

test('submissão: único email ao entrevistador, snapshot, idempotente', async () => {
  const r = await post('/entrevista/submeter', {}, guest);
  assert.match(r.headers.location as string, /obrigado/);
  await post('/entrevista/submeter', {}, guest); // clique duplo
  await flushOutbox(db);
  const mails = await db.query(`SELECT * FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'submitted:%'`, [ivId]);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Entrevista concluída — Fibra/);
  assert.match(mails[0].text_body, /fotografias: 3/);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM submissions WHERE interview_id=$1', [ivId])).n), 1);
  // depois de submeter não se grava mais
  const q = (await db.query('SELECT id FROM questions WHERE interview_id=$1', [ivId]))[0];
  const late = await app.inject({ method: 'POST', url: `/api/g/respostas/${q.id}`, payload: makeToneWav(1), headers: { 'content-type': 'audio/wav', cookie: guest } });
  assert.equal(late.statusCode, 409);
});

test('pipeline: processar, rever guião, aprovar, gerar, aprovações e publicar', async () => {
  const proc = await post(`/entrevistas/${ivId}/processar`, {}, owner);
  assert.match(proc.headers.location as string, /ok=/);
  await post(`/entrevistas/${ivId}/processar`, {}, owner); // duplo clique
  await drain();
  assert.equal((await db.one('SELECT production_status s FROM interviews WHERE id=$1', [ivId])).s, 'editorial_review');
  const sc = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft'`, [ivId]);
  assert.ok(sc.segments.some((s: any) => s.transformationType === 'editorial_intro'));
  assert.ok(sc.segments.filter((s: any) => s.speakerRole === 'guest').every((s: any) => s.sourceQuestionId), 'falas do convidado têm fonte');

  // gerar sem aprovar guião é recusado
  const early = await post(`/entrevistas/${ivId}/gerar`, { subtitle_langs: ['en'] }, owner);
  assert.match(early.headers.location as string, /e=/);

  await post(`/entrevistas/${ivId}/guiao/aprovar`, { reviewed: '1' }, owner);
  const g = await post(`/entrevistas/${ivId}/gerar`, { subtitle_langs: ['en', 'pt-PT'] }, owner);
  assert.match(g.headers.location as string, /ok=/);
  await drain();
  const ep = await db.one('SELECT * FROM episodes WHERE interview_id=$1', [ivId]);
  if (!ep) console.log(await db.query('SELECT kind,state,error FROM jobs'));
  assert.ok(ep, 'episódio criado');
  assert.ok(ep.duration_ms > 3000);
  assert.deepEqual(Object.keys(ep.subtitles).sort(), ['en', 'pt-PT']);
  assert.equal(ep.technical.qcIssues.length, 0, JSON.stringify(ep.technical.qcIssues));
  const cues = ep.subtitles.en;
  assert.ok(cues[0].text.includes('AI-generated voices'), 'aviso audível inicial presente nas legendas');
  for (let i = 1; i < cues.length; i++) assert.ok(cues[i].startMs >= cues[i - 1].endMs, 'sem sobreposições');
  assert.equal((await db.one('SELECT publication_status s FROM interviews WHERE id=$1', [ivId])).s, 'awaiting_approval');

  // publicação bloqueada sem aprovações
  const blocked = await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'unlisted' }, owner);
  assert.match(blocked.headers.location as string, /e=/);
  assert.equal((await get(`/e/${ep.slug}`)).statusCode, 404);

  await post(`/entrevistas/${ivId}/episodio/${ep.id}/aprovar`, {}, owner);
  const still = await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'unlisted' }, owner);
  assert.match(still.headers.location as string, /e=/, 'falta aprovação do entrevistado');

  // o entrevistado vê e aprova (nova sessão pelo link de pré-visualização)
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/enviar-previa`, {}, owner);
  await flushOutbox(db);
  const pm = await db.one(`SELECT subject, text_body, html AS html_body FROM emails WHERE interview_id=$1 AND subject LIKE 'Please review%'`, [ivId]);
  // email de validação próprio: sem número de perguntas, sem «responder no telemóvel», sem recusa
  assert.match(pm.subject, /validate your interview/);
  assert.match(pm.text_body, /Please confirm and validate your interview/);
  assert.doesNotMatch(pm.text_body, /question|whenever|do not wish/i);
  assert.match(pm.html_body, /View and validate the interview/);
  const tk2 = /\/i\/([A-Za-z0-9_-]{40,})/.exec(pm.text_body)![1];
  const landing = await get(`/i/${tk2}`);
  assert.match(landing.body, /Please confirm and validate your interview/);
  assert.doesNotMatch(landing.body, /recusar|do not wish|question/i, 'sem «Não pretendo participar» nem número de perguntas');
  await post(`/i/${tk2}/recusar`, {}, '');
  assert.equal((await db.one(`SELECT declined_at FROM invitations WHERE token_hash=$1`, [(await import('../src/lib.ts')).sha256(tk2)])).declined_at, null, 'um link de validação não recusa a entrevista');
  assert.equal((await get(`/i/${token}`)).statusCode, 200);
  assert.equal((await get('/entrevista', guest)).statusCode, 302, 'link antigo revogado invalida a sessão antiga');
  const open = await post(`/i/${tk2}/abrir`, {}, '');
  assert.equal(open.headers.location, '/entrevista/episodio', 'abrir leva diretamente ao episódio a validar');
  const g2 = `gs=${cookies(open).gs}`;
  const prev = await get('/entrevista/episodio', g2);
  assert.match(prev.body, /<h1>Episode preview<\/h1>/, 'abre na pré-visualização do episódio');
  assert.match(prev.body, /Please confirm and validate your interview/);
  assert.match(prev.body, /href="\/entrevista\/fotos"/);
  await post('/entrevista/episodio/decisao', { decision: 'approved' }, g2);

  const pub = await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'unlisted' }, owner);
  assert.match(pub.headers.location as string, /ok=/);
  const pg = await get(`/e/${ep.slug}`);
  assert.equal(pg.statusCode, 200);
  assert.match(pg.body, /noindex/, 'não listado não é indexável');
  assert.match(pg.body, /AI-generated voices/);
  const vtt = await get(`/e/${ep.slug}/subs/pt-PT.vtt`);
  assert.match(vtt.body, /^WEBVTT/);
  assert.match(vtt.body, /\d\d:\d\d:\d\d\.\d{3} --> /);
  const audio = await app.inject({ method: 'GET', url: `/e/${ep.slug}/audio`, headers: { range: 'bytes=0-99' } });
  assert.equal(audio.statusCode, 206);
  // originais nunca são servidos publicamente
  const orig = await db.one(`SELECT id FROM assets WHERE kind='answer_audio' LIMIT 1`);
  assert.equal((await get(`/media/${orig.id}`)).statusCode, 401);
  assert.equal((await get(`/api/g/media/${orig.id}`)).statusCode, 401);

  // retirar
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/retirar`, {}, owner);
  assert.equal((await get(`/e/${ep.slug}`)).statusCode, 404);
  assert.equal((await get(`/e/${ep.slug}/audio`)).statusCode, 404);
});

test('vozes escolhidas, agradecimento final, vídeo MP4 e galeria', async () => {
  const ep = await db.one('SELECT * FROM episodes WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1', [ivId]);
  assert.deepEqual(ep.technical.voices, { host: 'coral', guest: 'shimmer' }, 'feminina/feminina por omissão, vozes distintas');
  const sc = await db.one('SELECT segments FROM scripts WHERE id=$1', [ep.script_id]);
  const last = sc.segments[sc.segments.length - 1];
  assert.equal(last.transformationType, 'editorial_outro'); assert.equal(last.speakerRole, 'host');
  assert.ok(ep.technical.timing.length >= 3);

  const v = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'pt-PT' }, owner);
  assert.match(v.headers.location as string, /ok=/);
  const again = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'pt-PT' }, owner);
  assert.match(decodeURIComponent(again.headers.location as string), /Já há um vídeo/, 'clique repetido recusado');
  await drain();
  const job = await db.one(`SELECT state, error FROM jobs WHERE kind='render_video' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(job.state, 'done', job.error ?? '');
  const ep2 = await db.one('SELECT * FROM episodes WHERE id=$1', [ep.id]);
  assert.ok(ep2.video_asset_id); assert.equal(ep2.video_lang, 'pt-PT');
  const dl = await get(`/entrevistas/${ivId}/episodio/${ep.id}/video.mp4`, owner);
  assert.equal(dl.statusCode, 200);
  assert.match(String(dl.headers['content-disposition']), /attachment; filename=".+\.mp4"/);
  assert.equal(dl.rawPayload.subarray(4, 8).toString('latin1'), 'ftyp', 'MP4 válido');
  assert.equal((await get(`/entrevistas/${ivId}/episodio/${ep.id}/video.mp4`)).statusCode, 302, 'sem sessão não descarrega');
  const meta = (await db.one('SELECT meta FROM assets WHERE id=$1', [ep2.video_asset_id])).meta;
  assert.equal(meta.guestPhoto, false, 'sem autorização de publicação de fotografias, a do convidado não entra');

  // galeria: só episódios públicos e com autorização do entrevistador
  await db.query(`UPDATE episodes SET status='published', visibility='unlisted', withdrawn_at=NULL WHERE id=$1`, [ep.id]);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/galeria`, { gallery: '1', theme: 'Energia' }, owner);
  assert.equal((await db.one('SELECT gallery FROM episodes WHERE id=$1', [ep.id])).gallery, false, 'não listado não entra na galeria');
  await db.query(`UPDATE episodes SET visibility='public' WHERE id=$1`, [ep.id]);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/galeria`, { gallery: '1', theme: 'Energia' }, owner);
  const g = await get('/podcasts');
  assert.equal(g.statusCode, 200);
  assert.match(g.body, /<h2>Energia<\/h2>/);
  assert.match(g.body, new RegExp(ep.slug));
  assert.match((await get(`/e/${ep.slug}`)).body, /<video/);
  assert.equal((await get(`/e/${ep.slug}/video`)).statusCode, 200);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/retirar`, {}, owner);
  assert.doesNotMatch((await get('/podcasts')).body, new RegExp(ep.slug), 'retirado sai da galeria');
  assert.equal((await get(`/e/${ep.slug}/video`)).statusCode, 404);
});

test('animação por fala: só com autorização específica; aviso e reserva', async () => {
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND NOT stale ORDER BY created_at DESC LIMIT 1`, [ivId]);
  await db.query(`UPDATE episodes SET status='preview', withdrawn_at=NULL WHERE id=$1`, [ep.id]); // o teste anterior retirou-o
  // sem autorizações: pedir animação gera vídeo sem falas animadas
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', animate: '1' }, owner);
  await drain();
  let ep2 = await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id]);
  let meta = (await db.one('SELECT meta FROM assets WHERE id=$1', [ep2.video_asset_id])).meta;
  assert.equal(meta.animatedSegments, 0, 'sem autorização não anima ninguém');

  // entrevistador autoriza (com fotografia e direitos); convidado autoriza publicação e animação
  const jpg = await sharp({ create: { width: 400, height: 400, channels: 3, background: '#865' } }).jpeg().toBuffer();
  await app.inject({ method: 'POST', url: `/api/entrevistas/${ivId}/foto`, payload: jpg, headers: { 'content-type': 'image/jpeg', cookie: owner } });
  await db.query('UPDATE interviews SET host_photo_rights=true, host_animate=true WHERE id=$1', [ivId]);
  const tk = (await post(`/entrevistas/${ivId}/episodio/${ep.id}/enviar-previa`, {}, owner), await flushOutbox(db), await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND subject LIKE 'Please review%' ORDER BY created_at DESC LIMIT 1`, [ivId]));
  const gtoken = /\/i\/([A-Za-z0-9_-]{40,})/.exec(tk.text_body)![1];
  const g = `gs=${cookies(await post(`/i/${gtoken}/abrir`, {}, '')).gs}`;
  const pg = await get('/entrevista/fotos', g);
  assert.match(pg.body, /animated by AI/);
  assert.doesNotMatch(pg.body, /id="cam"/, 'depois de submeter não há captação nova');
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', animate_portrait: '1' }, g);
  const c = await db.one(`SELECT granted, text_snapshot FROM consents WHERE interview_id=$1 AND purpose='animate_portrait' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  assert.equal(c.granted, true); assert.match(c.text_snapshot, /AI-animated portrait/);

  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', animate: '1' }, owner);
  await drain();
  const job = await db.one(`SELECT state, error, result FROM jobs WHERE kind='render_video' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(job.state, 'done', job.error ?? '');
  ep2 = await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id]);
  meta = (await db.one('SELECT meta FROM assets WHERE id=$1', [ep2.video_asset_id])).meta;
  assert.ok(meta.animatedSegments > 0, 'falas animadas'); assert.equal(meta.guestAnimated, true); assert.equal(meta.hostAnimated, true);
  const v = await get(`/entrevistas/${ivId}/episodio/${ep.id}/video.mp4`, owner);
  assert.equal(v.rawPayload.subarray(4, 8).toString('latin1'), 'ftyp');

  // com «só o entrevistador aprova», o convidado animado por IA tem de ver e aprovar o vídeo na mesma
  await db.query(`UPDATE interviews SET review_policy='host_only' WHERE id=$1`, [ivId]);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/aprovar`, { video: ep2.video_asset_id }, owner);
  const blockedAnim = await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'unlisted' }, owner);
  assert.match(blockedAnim.headers.location as string, /e=/, 'sem a aprovação do convidado animado não publica');
  let prod = (await get(`/entrevistas/${ivId}/producao`, owner)).body;
  assert.match(prod, /<td>Entrevistado<\/td>/); assert.match(prod, /<button class="accent" disabled>Publicar/);
  await post('/entrevista/episodio/decisao', { decision: 'approved', video: ep2.video_asset_id }, g);
  prod = (await get(`/entrevistas/${ivId}/producao`, owner)).body;
  assert.match(prod, /<button class="accent" >Publicar/, 'com a aprovação do convidado, publicar fica disponível');
  await db.query(`UPDATE approvals SET valid=false WHERE episode_id=$1`, [ep.id]);
  await db.query(`UPDATE interviews SET review_policy='guest_preview' WHERE id=$1`, [ivId]);

  // episódio já publicado: um vídeo novo nunca anima o convidado (só o entrevistador), nem se pede validação
  await db.query(`UPDATE episodes SET status='published', visibility='unlisted' WHERE id=$1`, [ep.id]);
  assert.match((await get(`/entrevistas/${ivId}/producao`, owner)).body, /só é animado num episódio em pré-visualização/);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', animate: '1' }, owner);
  await drain();
  const pubVideo = await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id]);
  const pm = (await db.one('SELECT meta FROM assets WHERE id=$1', [pubVideo.video_asset_id])).meta;
  assert.equal(pm.guestAnimated, false, 'convidado em fotografia fixa num episódio publicado'); assert.equal(pm.hostAnimated, true);
  assert.ok(pm.animatedSegments > 0);
  const pv = await post(`/entrevistas/${ivId}/episodio/${ep.id}/enviar-previa`, {}, owner);
  assert.match(decodeURIComponent(pv.headers.location as string), /já está publicado/);
  await db.query(`UPDATE episodes SET status='preview', video_asset_id=$2 WHERE id=$1`, [ep.id, ep2.video_asset_id]);

  // retirar a autorização de animação tira o vídeo do ar (o ficheiro fica privado)
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1' }, g);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id, null);
});

test('vídeo com o Google Veo: autorização própria, som dos clipes, verificação e retirada', async () => {
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND NOT stale ORDER BY created_at DESC LIMIT 1`, [ivId]);
  await db.query(`UPDATE episodes SET status='preview', withdrawn_at=NULL WHERE id=$1`, [ep.id]); // o teste anterior retirou-o
  const lastJob = () => db.one(`SELECT state, error, result FROM jobs WHERE kind='render_video' ORDER BY created_at DESC LIMIT 1`);
  // sem autorização para o Veo: a opção aparece desativada e um pedido forçado falha sem gerar nada
  let pg = await get(`/entrevistas/${ivId}/producao`, owner);
  assert.match(pg.body, /value="veo" disabled/);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'pt-PT', engine: 'veo' }, owner);
  await drain();
  let job = await lastJob();
  assert.equal(job.state, 'failed'); assert.match(job.error, /Google Veo/);
  assert.equal((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='veo_clip'`, [ivId])).n, 0);

  // o entrevistador autoriza em Editar e o convidado em «Autorizações das fotografias»
  await db.query('UPDATE interviews SET host_ai_video=true WHERE id=$1', [ivId]);
  const tk = (await post(`/entrevistas/${ivId}/episodio/${ep.id}/enviar-previa`, {}, owner), await flushOutbox(db), await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND subject LIKE 'Please review%' ORDER BY created_at DESC LIMIT 1`, [ivId]));
  const g = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(tk.text_body)![1]}/abrir`, {}, '')).gs}`;
  assert.match((await get('/entrevista/fotos', g)).body, /Google \(Veo\)/);
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1' }, g);
  const c = await db.one(`SELECT granted, text_snapshot FROM consents WHERE interview_id=$1 AND purpose='ai_video' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  assert.equal(c.granted, true); assert.match(c.text_snapshot, /not my own voice|não é a minha voz/);
  pg = await get(`/entrevistas/${ivId}/producao`, owner);
  assert.doesNotMatch(pg.body, /value="veo" disabled/); assert.match(pg.body, /\d+ clipes, \d+ s faturados/);

  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'pt-PT', engine: 'veo' }, owner);
  await drain();
  job = await lastJob();
  assert.equal(job.state, 'done', job.error ?? '');
  let ep2 = await db.one('SELECT video_asset_id, video_lang FROM episodes WHERE id=$1', [ep.id]);
  const meta = (await db.one('SELECT meta, duration_ms FROM assets WHERE id=$1', [ep2.video_asset_id])).meta;
  assert.equal(meta.engine, 'veo'); assert.ok(meta.veoClips > 0); assert.equal(meta.generatedClips, meta.veoClips);
  assert.equal(meta.hostAiVideo, true); assert.equal(meta.guestAiVideo, true); assert.deepEqual(meta.fallbackSegments, []);
  assert.equal(meta.fidelity.length, meta.veoClips);
  assert.equal((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='veo_clip'`, [ivId])).n, meta.veoClips);
  const v = await get(`/entrevistas/${ivId}/episodio/${ep.id}/video.mp4`, owner);
  assert.equal(v.rawPayload.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.match((await get(`/entrevistas/${ivId}/producao`, owner)).body, /Fidelidade ao guião/);

  // gerar de novo reaproveita os clipes já pagos
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  await drain();
  ep2 = await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id]);
  assert.equal((await db.one('SELECT meta FROM assets WHERE id=$1', [ep2.video_asset_id])).meta.generatedClips, 0);

  // o vídeo novo invalida as aprovações anteriores e aparece na pré-visualização do convidado
  assert.equal((await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND valid AND decision='approved'`, [ep.id])).n, 0);
  const prev = await get('/entrevista/episodio', g);
  assert.match(prev.body, new RegExp(`<video[^>]+/api/g/media/${ep2.video_asset_id}`));
  // aprovações presas ao vídeo visto: uma página aberta antes do vídeo atual não aprova
  const stale = await post('/entrevista/episodio/decisao', { decision: 'approved', video: '' }, g);
  assert.match(stale.headers.location as string, /changed=1/);
  assert.equal((await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND actor='guest' AND valid AND decision='approved'`, [ep.id])).n, 0);
  const staleHost = await post(`/entrevistas/${ivId}/episodio/${ep.id}/aprovar`, {}, owner);
  assert.match(decodeURIComponent(staleHost.headers.location as string), /O vídeo mudou/);
  await post('/entrevista/episodio/decisao', { decision: 'approved', video: ep2.video_asset_id }, g);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/aprovar`, { video: ep2.video_asset_id }, owner);
  assert.equal((await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND valid AND decision='approved' AND video_asset_id=$2`, [ep.id, ep2.video_asset_id])).n, 2);
  // um vídeo desligado deixa de ser servido ao convidado
  // operações pagas ficam registadas e concluídas (em modo simulado não há operações na Google)
  assert.equal((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE interview_id=$1 AND state='pending'`, [ivId])).n, 0);

  // o entrevistador retira a autorização do Veo em Editar: o vídeo sai do ar
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]);
  await post(`/entrevistas/${ivId}/guardar`, { title: iv.title, objective_text: iv.objective_text, host_name: iv.host_name, guest_name: iv.guest_name, guest_email: iv.guest_email, subtitle_langs: iv.subtitle_langs, review_policy: iv.review_policy, host_photo_rights: '1', host_animate: '1' }, owner);
  assert.equal((await db.one('SELECT host_ai_video FROM interviews WHERE id=$1', [ivId])).host_ai_video, false);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id, null);

  // de novo com as duas autorizações; depois o convidado retira a dele: o vídeo sai do ar
  await db.query('UPDATE interviews SET host_ai_video=true WHERE id=$1', [ivId]);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  await drain();
  assert.ok((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id);
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1' }, g);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id, null);

  // episódio publicado ou retirado: o Veo é recusado (o vídeo tem de ser visto e aprovado antes da publicação)
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1' }, g);
  for (const st of ['published', 'withdrawn']) {
    await db.query(`UPDATE episodes SET status=$2 WHERE id=$1`, [ep.id, st]);
    const r = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
    assert.match(decodeURIComponent(r.headers.location as string), /pré-visualização/, st);
  }
  await db.query(`UPDATE episodes SET status='preview' WHERE id=$1`, [ep.id]);
  // pedido de alterações do convidado: o Veo é recusado
  await post('/entrevista/episodio/decisao', { decision: 'changes', note: 'Prefiro outra frase', video: '' }, g);
  const rc = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  assert.match(decodeURIComponent(rc.headers.location as string), /pediu alterações/);
  await db.query(`UPDATE approvals SET valid=false WHERE interview_id=$1 AND valid AND decision='approved'`, [ivId]); // o mesmo que «guardar revisão do guião»
  // gravar uma revisão do guião não apaga o pedido de alterações do convidado
  assert.equal((await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND actor='guest' AND valid AND decision='changes'`, [ep.id])).n, 1);

  // com a política «só o entrevistador aprova», o convidado não entra no Veo
  await db.query(`UPDATE approvals SET valid=false WHERE episode_id=$1`, [ep.id]);
  await db.query(`UPDATE interviews SET review_policy='host_only' WHERE id=$1`, [ivId]);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  await drain();
  const vm = (await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [ep.id])).meta;
  assert.equal(vm.guestAiVideo, false); assert.equal(vm.hostAiVideo, true);
  await db.query(`UPDATE interviews SET review_policy='guest_preview' WHERE id=$1`, [ivId]);

  // vídeo Veo com o convidado e depois mudança para «só o entrevistador aprova»: o vídeo sai e não se publica sem ele
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  await drain();
  const withGuest = await db.one('SELECT e.video_asset_id, a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [ep.id]);
  assert.equal(withGuest.meta.guestAiVideo, true);
  const ivNow = await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]);
  await post(`/entrevistas/${ivId}/guardar`, { title: ivNow.title, objective_text: ivNow.objective_text, host_name: ivNow.host_name, guest_name: ivNow.guest_name, guest_email: ivNow.guest_email, subtitle_langs: ivNow.subtitle_langs, review_policy: 'host_only', host_photo_rights: '1', host_animate: '1', host_ai_video: '1' }, owner);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id, null, 'host_only desliga o vídeo Veo do convidado');
  // mesmo que o vídeo volte a ser ligado (por exemplo, por uma corrida), publicar exige a aprovação do convidado
  await db.query('UPDATE episodes SET video_asset_id=$2 WHERE id=$1', [ep.id, withGuest.video_asset_id]);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/aprovar`, { video: withGuest.video_asset_id }, owner);
  const pub = await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'unlisted' }, owner);
  assert.match(decodeURIComponent(pub.headers.location as string), /bloqueada/);
  assert.equal((await db.one('SELECT status FROM episodes WHERE id=$1', [ep.id])).status, 'preview');
  await db.query(`UPDATE interviews SET review_policy='guest_preview' WHERE id=$1`, [ivId]);

  // tirar o vídeo do episódio volta à versão sem vídeo
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video/retirar`, {}, owner);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id, null);

  // guião substituído («Regenerar guião»): o Veo é recusado, mesmo sem pedido de alterações
  await db.query(`UPDATE scripts SET status='superseded' WHERE id=$1`, [ep.script_id]);
  const rs = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  assert.match(decodeURIComponent(rs.headers.location as string), /guião deste episódio foi substituído/);
  await db.query(`UPDATE scripts SET status='approved' WHERE id=$1`, [ep.script_id]);

  // «só o entrevistador aprova» e episódio sem vídeo Veo: um pedido de alterações do convidado não trava a publicação (como no main)
  await db.query(`UPDATE interviews SET review_policy='host_only' WHERE id=$1`, [ivId]);
  await db.query(`UPDATE approvals SET valid=false WHERE episode_id=$1`, [ep.id]);
  await post('/entrevista/episodio/decisao', { decision: 'changes', note: 'Uma sugestão', video: '' }, g);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/aprovar`, { video: '' }, owner);
  const pub2 = await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'private' }, owner);
  assert.match(decodeURIComponent(pub2.headers.location as string), /Guardado como privado/);
  await db.query(`UPDATE episodes SET status='preview' WHERE id=$1`, [ep.id]);
  await db.query(`UPDATE interviews SET review_policy='guest_preview' WHERE id=$1`, [ivId]);
});

test('alterar uma transcrição invalida guião e aprovações sem apagar versões', async () => {
  const take = await db.one(`SELECT t.id FROM answer_takes t LIMIT 1`);
  await post(`/entrevistas/${ivId}/transcricoes/${take.id}`, { text: 'Texto corrigido pelo editor' }, owner);
  const revs = await db.query(`SELECT revision, origin FROM transcripts WHERE source_id=$1 ORDER BY revision`, [take.id]);
  assert.deepEqual(revs.map((r: any) => r.revision), [1, 2]);
  assert.equal((await db.one(`SELECT count(*)::int n FROM approvals WHERE interview_id=$1 AND valid`, [ivId])).n, 0);
  assert.equal((await db.one(`SELECT bool_and(stale) s FROM episodes WHERE interview_id=$1`, [ivId])).s, true);
  // versão desatualizada: não se pede a validação ao convidado (nem sai email)
  const ep = await db.one(`SELECT id FROM episodes WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1`, [ivId]);
  const before = (await db.one(`SELECT count(*)::int n FROM emails WHERE interview_id=$1`, [ivId])).n;
  const r = await post(`/entrevistas/${ivId}/episodio/${ep.id}/enviar-previa`, {}, owner);
  assert.match(decodeURIComponent(r.headers.location as string), /Versão desatualizada/);
  assert.equal((await db.one(`SELECT count(*)::int n FROM emails WHERE interview_id=$1`, [ivId])).n, before);
  assert.doesNotMatch((await get(`/entrevistas/${ivId}/producao`, owner)).body, /Enviar pré-visualização<\/button>/);
});

test('CSRF: pedidos de outra origem são recusados', async () => {
  const r = await app.inject({ method: 'POST', url: '/sair', headers: { origin: 'https://evil.example', host: 'test.local', cookie: owner } });
  assert.equal(r.statusCode, 403);
});

test('CSRF: Origin null só passa com Sec-Fetch-Site same-origin; mesma origem e BASE_URL passam', async () => {
  const f = (h: any) => app.inject({ method: 'POST', url: '/sair', headers: { host: 'internal:10000', cookie: owner, ...h } });
  assert.equal((await f({ origin: 'null' })).statusCode, 403);
  assert.equal((await f({ origin: 'null', 'sec-fetch-site': 'same-origin' })).statusCode, 302);
  assert.equal((await f({ origin: 'http://test.local' })).statusCode, 302, 'host de BASE_URL aceite atrás de proxy');
});

test('progresso: JSON com percentagem e etapa, só para o dono', async () => {
  owner = `sid=${cookies(await post('/entrar', { email: 'ana@example.com', password: 'uma-palavra-passe-longa' }, '')).sid}`; // os testes de CSRF terminaram a sessão
  const r = await get(`/entrevistas/${ivId}/progresso`, owner);
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.equal(j.active, false);
  assert.equal(j.percent, 100);
  assert.equal(j.label, 'Concluído');
  assert.equal((await get(`/entrevistas/${ivId}/progresso`)).statusCode, 401);
  const job = await db.one(`SELECT progress_total, progress_done FROM jobs WHERE kind='generate_episode' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(job.progress_done, job.progress_total);
});

test('recomeçar produção arquiva (não apaga) e permite processar de novo', async () => {
  const before = Number((await db.one('SELECT count(*)::int n FROM episodes WHERE interview_id=$1', [ivId])).n);
  const r = await post(`/entrevistas/${ivId}/producao/recomecar`, {}, owner);
  assert.match(decodeURIComponent(r.headers.location as string), /recomeçada/);
  const iv = await db.one('SELECT production_status, publication_status FROM interviews WHERE id=$1', [ivId]);
  assert.equal(iv.production_status, 'not_requested'); assert.equal(iv.publication_status, 'private');
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM episodes WHERE interview_id=$1', [ivId])).n), before, 'nada é eliminado');
  assert.equal((await db.one(`SELECT count(*)::int n FROM scripts WHERE interview_id=$1 AND status<>'superseded'`, [ivId])).n, 0);
  assert.ok(Number((await db.one(`SELECT count(*)::int n FROM transcripts WHERE interview_id=$1`, [ivId])).n) > 0, 'transcrições mantêm-se');
  const pg = await get(`/entrevistas/${ivId}/producao`, owner);
  assert.match(pg.body, /Processar podcast/);
  assert.doesNotMatch(pg.body, /5\. Episódio/);
  await post(`/entrevistas/${ivId}/processar`, {}, owner);
  await drain();
  assert.equal((await db.one('SELECT production_status s FROM interviews WHERE id=$1', [ivId])).s, 'editorial_review');
});
