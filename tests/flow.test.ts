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
  assert.match(r.body, /<footer>[\s\S]*quietinterview is owned and operated by Certif Int Association OÜ \(Estonia\) · <a href="https:\/\/www\.certifinternational\.com" rel="noopener">certifinternational\.com<\/a> · <a href="mailto:certifinternational@gmail\.com">certifinternational@gmail\.com<\/a><\/p><\/div><\/footer>/, 'só a entidade proprietária e gestora no rodapé');
  assert.match(r.body, /€19<span class="hint"> \/ month/);
  assert.match(r.body, /Up to <strong>3 interviews/);
  // fotografias licenciadas nos cinco lugares, com créditos; sem ilustrações, não há o aviso das ilustrações
  for (const n of ['hero', 'interviewer', 'guest', 'studio', 'listen']) assert.match(r.body, new RegExp(`src="/static/img/photos/${n}\\.jpg"`));
  assert.match(r.body, /Photos: Freepik/);
  assert.doesNotMatch(r.body, /class="ill"|Illustrations on this page/);
  assert.match(r.body, /professional culture and life experience[\s\S]*subtitles in English, Portuguese, Spanish, French and German/);
  // vídeo de apresentação: legendas por omissão, cartaz e aviso de IA (os ficheiros estáticos são servidos por server.ts)
  assert.match(r.body, /<video controls playsinline preload="none" poster="\/static\/video\/promo\.jpg"/);
  assert.match(r.body, /<track kind="captions" srclang="en" label="English" src="\/static\/video\/promo\.en\.vtt" default>/);
  assert.match(r.body, /<track kind="captions" srclang="pt-PT" label="Português" src="\/static\/video\/promo\.pt\.vtt">/, 'legendas em português disponíveis');
  assert.match(r.body, /AI-generated video and voices \(Google Veo\)[^<]*All people shown are fictional/);
  assert.match(r.body, /by default review before anything is published/, 'a política «só o entrevistador aprova» dispensa o convidado');
  assert.match(r.body, /<h3>Interviewee approves<\/h3><p>By default, your interviewee sees and validates/, '«interviewee» (a tradução do browser de «guest» dava «hóspede»)');
  assert.doesNotMatch(r.body, /Guest approves/);
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
  await post(`/entrevistas/${ivId}/guardar`, { title: 'Fibra ótica em Portugal', objective_text: 'Perceber o mercado', objective_shared: '1', host_name: 'Ana', guest_name: 'Rui', host_title: '  Editor,   Lisbon ', guest_title: 'Network engineer', guest_email: 'rui@example.com', interaction_lang: 'en', answer_lang: 'auto', planned_visibility: 'unlisted', subtitle_langs: ['en', 'pt-PT'], review_policy: 'guest_preview' }, owner);
  assert.deepEqual({ ...(await db.one('SELECT host_title, guest_title FROM interviews WHERE id=$1', [ivId])) }, { host_title: 'Editor, Lisbon', guest_title: 'Network engineer' }, 'funções do rodapé do vídeo');
  assert.match((await get(`/entrevistas/${ivId}/editar`, owner)).body, /name="guest_title"[^>]*value="Network engineer"/);
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
  assert.match(mail.text_body, /This link is personal\. You can answer until \d{1,2} \w+ \d{4}\./);
  assert.match(mail.text_body, /record it again until you submit the interview/, 'não promete ouvir antes de enviar (a gravação sobe ao parar)');
  // sem prazo, o link vale até ao fim do dia mostrado no email
  const inv = await db.one(`SELECT expires_at FROM invitations WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1`, [ivId]);
  assert.equal(new Date(inv.expires_at).toISOString().slice(11, 19), '11:59:59', 'fim do dia em qualquer fuso (23:59:59 em UTC−12)');
  const shown = new Date(new Date(inv.expires_at).getTime() - 12 * 3600_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  assert.ok(mail.text_body.includes(`until ${shown}.`), 'a data do email é a do fim da validade');
  assert.ok(mail.html.indexOf('>Open interview</a>') < mail.html.indexOf('I do not wish to take part'), 'recusa e apoio depois do botão');
  assert.match(mail.text_body, /quietinterview — interviews recorded in your own time · test\.local/);
  assert.doesNotMatch(mail.html + mail.text_body, /convida-o\(a\)|Conversations/);
  const { replyTo } = await import('../src/mail.ts');
  assert.equal(replyTo(), 'comercial@quietinterview.com', 'Reply-To: a caixa comercial do próprio domínio, nunca o SUPPORT_EMAIL');
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
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', host_edit: '1', processing: '1', publish: '1' }, guest);
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

test('pergunta gravada pelo entrevistador: ouve-se só a gravação, nunca a leitura sintética', async () => {
  const [q] = await db.query('SELECT * FROM questions WHERE interview_id=$1 ORDER BY position', [ivId]);
  const synth = /Read aloud with an AI-generated voice\./;
  assert.equal((await get(`/api/g/leitura/${q.id}`, guest)).statusCode, 200, 'sem gravação há leitura do servidor');
  let page = (await get('/entrevista/p/1', guest)).body;
  assert.doesNotMatch(page, /id="qaudio"/);
  assert.match(page, synth);
  const a = await db.one(`INSERT INTO assets(interview_id, kind, mime, size, sha256, storage_key) VALUES ($1,'question_audio','audio/webm',1,'x','x') RETURNING id`, [ivId]);
  await db.query('UPDATE questions SET audio_asset_id=$2 WHERE id=$1', [q.id, a.id]);
  try {
    assert.equal((await get(`/api/g/leitura/${q.id}`, guest)).statusCode, 404, 'com gravação não há voz sintética');
    page = (await get('/entrevista/p/1', guest)).body;
    assert.match(page, new RegExp(`<audio id="qaudio" controls preload="none" src="/api/g/media/${a.id}">`));
    assert.doesNotMatch(page, synth);
  } finally {
    await db.query('UPDATE questions SET audio_asset_id=NULL WHERE id=$1', [q.id]);
    await db.query('DELETE FROM assets WHERE id=$1', [a.id]);
  }
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

  // retirado (teste anterior): nenhum vídeo novo e publicar fica desativado com o motivo certo
  assert.equal(ep.status, 'withdrawn');
  const wd = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'pt-PT' }, owner);
  assert.match(decodeURIComponent(wd.headers.location as string), /só se gera para um episódio em pré-visualização/);
  const wdPage = (await get(`/entrevistas/${ivId}/producao`, owner)).body;
  assert.doesNotMatch(wdPage, />Publicar<\/button>/); assert.match(wdPage, /foi retirado e não volta a ser publicado/);
  assert.match(decodeURIComponent((await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'unlisted' }, owner)).headers.location as string), /bloqueada: Este episódio foi retirado/);
  await db.query(`UPDATE episodes SET status='preview', withdrawn_at=NULL WHERE id=$1`, [ep.id]);

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
  const vrow = await db.one('SELECT meta, duration_ms FROM assets WHERE id=$1', [ep2.video_asset_id]), meta = vrow.meta;
  assert.equal(meta.guestPhoto, false, 'sem autorização de publicação de fotografias, a do convidado não entra');
  // grafismo em todos os planos (sem IA): cartões de título e final, rodapés dos dois e um capítulo por pergunta
  assert.deepEqual(meta.graphics, { titleCard: true, endCard: true, lowerThirds: 2, chapters: ep.chapters.length });
  assert.ok(ep.chapters.length > 0);
  assert.equal(vrow.duration_ms, Math.round(ep.duration_ms / 40) * 40 + 8000, 'episódio + 4 s do cartão de título + 4 s do cartão final');

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
  assert.doesNotMatch(pg.body, /Replicate/, 'a sincronização labial deixou de ser oferecida ao convidado');
  assert.match(pg.body, /Google \(Veo\)/);
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

  // episódio já publicado: nenhum vídeo novo (iria logo para o ar sem ser visto e aprovado), nem se pede validação
  const videoJobs = async () => Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1 AND kind='render_video'`, [ivId])).n);
  await db.query(`UPDATE episodes SET status='published', visibility='unlisted', published_at=now() WHERE id=$1`, [ep.id]);
  const pubPage = (await get(`/entrevistas/${ivId}/producao`, owner)).body;
  assert.match(pubPage, /Um vídeo novo só se gera para um episódio em pré-visualização/);
  assert.doesNotMatch(pubPage, new RegExp(`action="/entrevistas/${ivId}/episodio/${ep.id}/video"`), 'sem o formulário do vídeo');
  const n0 = await videoJobs();
  const refused = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', animate: '1' }, owner);
  assert.match(decodeURIComponent(refused.headers.location as string), /só se gera para um episódio em pré-visualização/);
  assert.equal(await videoJobs(), n0, 'nada entra na fila');
  // vídeo pedido antes da publicação: publicar espera por ele; se o episódio sair entretanto, o vídeo não é ligado
  await db.query(`UPDATE episodes SET status='preview' WHERE id=$1`, [ep.id]);
  assert.match((await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', animate: '1' }, owner)).headers.location as string, /ok=/);
  assert.match(decodeURIComponent((await post(`/entrevistas/${ivId}/episodio/${ep.id}/publicar`, { visibility: 'unlisted' }, owner)).headers.location as string), /bloqueada: Há um vídeo a ser gerado para este episódio/);
  assert.match((await get(`/entrevistas/${ivId}/producao`, owner)).body, /Ainda não é possível publicar: Há um vídeo a ser gerado/);
  await db.query(`UPDATE episodes SET status='published' WHERE id=$1`, [ep.id]); // (publicado por outra via enquanto o vídeo esperava)
  await drain();
  const late = await db.one(`SELECT state, error FROM jobs WHERE kind='render_video' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(late.state, 'failed'); assert.match(late.error, /só se gera para um episódio em pré-visualização/);
  const pubVideo = await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id]);
  assert.equal(pubVideo.video_asset_id, ep2.video_asset_id, 'o vídeo no ar não mudou');
  const pv = await post(`/entrevistas/${ivId}/episodio/${ep.id}/enviar-previa`, {}, owner);
  assert.match(decodeURIComponent(pv.headers.location as string), /já está publicado/);

  // «só o entrevistador aprova» sem o convidado animado: não se lhe pede aprovação nem se fala de animação
  await db.query(`UPDATE interviews SET review_policy='host_only' WHERE id=$1`, [ivId]);
  await db.query(`UPDATE episodes SET status='preview', video_asset_id=NULL WHERE id=$1`, [ep.id]); // (sem o vídeo em que o convidado aparece animado)
  const view = await get('/entrevista/episodio', g);
  assert.match(view.body, /Publication is decided by the interviewer/);
  assert.doesNotMatch(view.body, /animated by AI, confirm|action="\/entrevista\/episodio\/decisao"/);
  const nGuestAp = (await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND actor='guest'`, [ep.id])).n;
  await post('/entrevista/episodio/decisao', { decision: 'changes', video: pubVideo.video_asset_id }, g);
  assert.equal((await db.one(`SELECT count(*)::int n FROM approvals WHERE episode_id=$1 AND actor='guest'`, [ep.id])).n, nGuestAp, 'sem alcance, a decisão do convidado não se regista');
  const pv2 = await post(`/entrevistas/${ivId}/episodio/${ep.id}/enviar-previa`, {}, owner);
  assert.match(decodeURIComponent(pv2.headers.location as string), /só valida um vídeo em que apareça animado/);
  await db.query(`UPDATE interviews SET review_policy='guest_preview' WHERE id=$1`, [ivId]);

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
  assert.doesNotMatch(pg.body, /value="veo" disabled/); assert.match(pg.body, /\d+ clipes, \d+ s faturados a ~\$0\.10\/s/);
  assert.match(pg.body, /value="veo" > Google Veo 3\.1 Fast:/);
  // nível escolhido pelo administrador: o Lite muda o rótulo e o preço da estimativa
  const { saveSetting } = await import('../src/settings.ts');
  await saveSetting(db, 'VEO_TIER', 'lite');
  const lite = await get(`/entrevistas/${ivId}/producao`, owner);
  assert.match(lite.body, /Google Veo 3\.1 Lite:/); assert.match(lite.body, /\d+ clipes, \d+ s faturados a ~\$0\.05\/s/);
  await saveSetting(db, 'VEO_TIER', '');

  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'pt-PT', engine: 'veo' }, owner);
  await drain();
  job = await lastJob();
  assert.equal(job.state, 'done', job.error ?? '');
  let ep2 = await db.one('SELECT video_asset_id, video_lang FROM episodes WHERE id=$1', [ep.id]);
  const meta = (await db.one('SELECT meta, duration_ms FROM assets WHERE id=$1', [ep2.video_asset_id])).meta;
  assert.equal(meta.engine, 'veo'); assert.ok(meta.veoClips > 0); assert.equal(meta.generatedClips, meta.veoClips);
  assert.deepEqual(meta.graphics, { titleCard: true, endCard: true, lowerThirds: 2, chapters: ep.chapters.length }, 'o mesmo grafismo no vídeo animado');
  assert.equal(meta.hostAiVideo, true); assert.equal(meta.guestAiVideo, true); assert.deepEqual(meta.fallbackSegments, []);
  assert.equal(meta.fidelity.length, meta.veoClips);
  assert.equal((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='veo_clip'`, [ivId])).n, meta.veoClips);
  // modelo e preço por segundo registados no vídeo e em cada clipe (sem conta de serviço: Gemini API)
  assert.equal(meta.tier, 'fast'); assert.equal(meta.usdPerSec, 0.1); assert.equal(meta.model, 'veo-3.1-fast-generate-preview'); assert.equal(meta.backend, 'gemini');
  const clipMetas = (await db.query(`SELECT meta FROM assets WHERE interview_id=$1 AND kind='veo_clip'`, [ivId])).map((r: any) => r.meta);
  assert.ok(clipMetas.every((m: any) => m.model === 'veo-3.1-fast-generate-preview' && m.usdPerSec === 0.1));
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
  // operações registadas e concluídas (em modo simulado também passam pela intenção gravada antes do envio), com o modelo
  // e o preço de cada uma; o administrador gera sem orçamento (custo interno)
  assert.equal((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE interview_id=$1 AND state IN ('pending','reserved')`, [ivId])).n, 0);
  const ops = await db.query(`SELECT model, usd_per_sec, state, quote_id, cost_usd, duration_sec FROM veo_ops WHERE interview_id=$1`, [ivId]);
  assert.ok(meta.veoClips > 0); assert.equal(ops.length, meta.veoClips, 'uma operação por clipe gerado (também em modo simulado)');
  assert.ok(ops.every((o: any) => o.model === 'veo-3.1-fast-generate-preview' && o.usd_per_sec === 0.1 && o.state === 'done' && o.quote_id === null && o.cost_usd === o.duration_sec * 0.1), 'cada operação nova guarda o modelo, o preço e o custo com que foi submetida (as antigas: teste da migração 012)');

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

  // com a política «só o entrevistador aprova», o convidado que autorizou entra no Veo na mesma (e aprova o vídeo antes de publicar)
  await db.query(`UPDATE approvals SET valid=false WHERE episode_id=$1`, [ep.id]);
  await db.query(`UPDATE interviews SET review_policy='host_only' WHERE id=$1`, [ivId]);
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  await drain();
  const vm = (await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [ep.id])).meta;
  assert.equal(vm.guestAiVideo, true); assert.equal(vm.hostAiVideo, true);
  const { guestMustApprove } = await import('../src/approval.ts');
  assert.equal(guestMustApprove({ review_policy: 'host_only' }, vm), true, 'o convidado animado aprova o vídeo');
  await db.query(`UPDATE interviews SET review_policy='guest_preview' WHERE id=$1`, [ivId]);

  // vídeo Veo com o convidado e depois mudança para «só o entrevistador aprova»: o vídeo sai e não se publica sem ele
  await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'veo' }, owner);
  await drain();
  const withGuest = await db.one('SELECT e.video_asset_id, a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [ep.id]);
  assert.equal(withGuest.meta.guestAiVideo, true);
  const ivNow = await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]);
  await post(`/entrevistas/${ivId}/guardar`, { title: ivNow.title, objective_text: ivNow.objective_text, host_name: ivNow.host_name, guest_name: ivNow.guest_name, guest_email: ivNow.guest_email, subtitle_langs: ivNow.subtitle_langs, review_policy: 'host_only', host_photo_rights: '1', host_animate: '1', host_ai_video: '1' }, owner);
  assert.equal((await db.one('SELECT review_policy FROM interviews WHERE id=$1', [ivId])).review_policy, 'guest_preview', 'depois do convite, a política não passa a «só o entrevistador aprova»');
  assert.ok((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [ep.id])).video_asset_id, 'o vídeo mantém-se: o convidado continua a aprovar');
  // com «só o entrevistador aprova» desde o início, o vídeo com o convidado animado exige na mesma a aprovação dele
  await db.query(`UPDATE interviews SET review_policy='host_only' WHERE id=$1`, [ivId]);
  const { createInvitation } = await import('../src/invites.ts');
  const vinv = await createInvitation(db, await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]), { name: 'Ana' }, { preview: true });
  const vmail = await db.one(`SELECT text_body FROM emails WHERE dedupe_key=$1`, [`invite:${vinv.invitationId}`]);
  // (o /guardar acima não enviou interaction_lang, por isso a entrevista ficou em pt-PT)
  assert.match(vmail.text_body, /O vídeo com a sua imagem animada não é publicado sem a sua aprovação/);
  assert.doesNotMatch(vmail.text_body, /Nada é publicado sem a sua aprovação/, 'em host_only não se promete a aprovação de tudo');
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

test('vídeo IA: o Veo de quem não é administrador só por orçamento; os retratos animados só do administrador', async () => {
  await drain();
  const ownerId = (await db.one('SELECT owner_id FROM interviews WHERE id=$1', [ivId])).owner_id;
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND NOT stale ORDER BY created_at DESC LIMIT 1`, [ivId]);
  const jobs = async () => Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1 AND kind='render_video'`, [ivId])).n);
  await db.query(`UPDATE users SET role='interviewer' WHERE id=$1`, [ownerId]);
  try {
    const pg = await get(`/entrevistas/${ivId}/producao`, owner);
    assert.doesNotMatch(pg.body, /value="lipsync"/); assert.doesNotMatch(pg.body, /value="veo"/);
    assert.match(pg.body, /Vídeo premium \(animação por IA\): veja os créditos e o seu saldo na secção «Vídeo premium \(animação por IA\)» abaixo/);
    assert.doesNotMatch(pg.body, /Google Veo 3\.1|Utilização registada|custo estimado/, 'sem modelos nem custos internos para o cliente');
    assert.match(pg.body, /id="orcamento"/, 'secção do orçamento');
    const before = await jobs();
    for (const [body, re] of [[{ lang: 'en', engine: 'veo' }, /faz-se por orçamento/], [{ lang: 'en', engine: 'lipsync' }, /reservados ao administrador/], [{ lang: 'en', animate: '1' }, /reservados ao administrador/]] as const) {
      const r = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, body, owner);
      assert.match(decodeURIComponent(r.headers.location as string), re);
    }
    assert.equal(await jobs(), before, 'nenhum trabalho pago entra na fila');
    // fotografias fixas continuam disponíveis
    const still = await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'still' }, owner);
    assert.match(decodeURIComponent(still.headers.location as string), /Geração do vídeo iniciada/);
    await drain();
    // segunda barreira: um trabalho pedido por quem já não é administrador não gera vídeo IA (nem clipes)
    const clips = Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE interview_id=$1`, [ivId])).n);
    for (const input of [{ episodeId: ep.id, lang: 'en', engine: 'veo', requestedBy: ownerId }, { episodeId: ep.id, lang: 'en', animate: true, requestedBy: ownerId }]) {
      const j = await db.one(`INSERT INTO jobs(interview_id, kind, input) VALUES ($1,'render_video',$2) RETURNING id`, [ivId, JSON.stringify(input)]);
      await drain();
      const r = await db.one('SELECT state, error FROM jobs WHERE id=$1', [j.id]);
      assert.equal(r.state, 'failed'); assert.match(r.error, input.engine ? /faz-se por orçamento/ : /só se geram a pedido do administrador/);
    }
    assert.equal(Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE interview_id=$1`, [ivId])).n), clips, 'nada foi enviado à Google');
    // (o último trabalho volta a ser um vídeo concluído, para o teste do progresso)
    await post(`/entrevistas/${ivId}/episodio/${ep.id}/video`, { lang: 'en', engine: 'still' }, owner);
    await drain();
  } finally {
    await db.query(`UPDATE users SET role='admin' WHERE id=$1`, [ownerId]);
  }
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

test('migração 012: as operações do Veo de antes dela ficam com o modelo e o preço do Fast na Gemini API (e o custo, na 016)', async () => {
  // Base nova só até à 011, com operações como as havia antes do registo do modelo e do preço (em modo simulado o fluxo
  // acima só cria operações novas, que já trazem o modelo: não exercitam a migração).
  const old = await openDb();
  try {
    await migrate(old, { until: '011_convite_finalidade.sql' });
    assert.equal((await old.one(`SELECT count(*)::int n FROM information_schema.columns WHERE table_name='veo_ops' AND column_name IN ('model','usd_per_sec')`)).n, 0, 'antes da 012 não há modelo nem preço');
    const u = await old.one(`INSERT INTO users(email, name, password_hash) VALUES ('antes-012@example.com','Antes','x') RETURNING id`);
    const iv = await old.one(`INSERT INTO interviews(owner_id, title) VALUES ($1,'Antes da 012') RETURNING id`, [u.id]);
    await old.query(`INSERT INTO veo_ops(interview_id, chunk_key, op_name, duration_sec, state) VALUES ($1,'k1','models/veo-3.1-fast-generate-preview/operations/1',8,'done'), ($1,'k2','models/veo-3.1-fast-generate-preview/operations/2',6,'busy')`, [iv.id]);
    await migrate(old);
    const ops = await old.query(`SELECT chunk_key, model, usd_per_sec, cost_usd, state FROM veo_ops ORDER BY chunk_key`);
    assert.deepEqual(ops.map((o: any) => [o.chunk_key, o.model, o.usd_per_sec, o.state]), [['k1', 'veo-3.1-fast-generate-preview', 0.1, 'done'], ['k2', 'veo-3.1-fast-generate-preview', 0.1, 'busy']]);
    assert.ok(Math.abs(ops[0].cost_usd - 0.8) < 1e-9 && Math.abs(ops[1].cost_usd - 0.6) < 1e-9, 'custo = segundos × preço da operação');
    // uma operação nova (depois da migração) guarda o modelo dela, sem ser reescrita por uma migração repetida
    await old.query(`INSERT INTO veo_ops(interview_id, chunk_key, op_name, duration_sec, state, model, usd_per_sec, cost_usd) VALUES ($1,'k3','x',8,'done','veo-3.1-lite-generate-001',0.05,0.4)`, [iv.id]);
    await old.query(`UPDATE veo_ops SET model='veo-3.1-fast-generate-preview', usd_per_sec=0.10 WHERE model IS NULL`); // (o UPDATE da 012)
    assert.equal((await old.one(`SELECT model FROM veo_ops WHERE chunk_key='k3'`)).model, 'veo-3.1-lite-generate-001');
  } finally { await old.close(); }
});

test('edição pelo entrevistador: autorização no convite e fotografia do entrevistado escolhida ou acrescentada por ele', async () => {
  // o convite anuncia a autorização de edição e a revisão antes de publicar; o início regista-a (host_edit)
  const inv = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at ASC LIMIT 1`, [ivId]);
  assert.match(inv.text_body, /autoriza o entrevistador a editar a entrevista|allow the interviewer to edit the interview/);
  assert.match(inv.text_body, /Só a pode tornar pública depois de a rever|can only be made public after you have reviewed/);
  const first = await db.one(`SELECT granted, text_snapshot FROM consents WHERE interview_id=$1 AND purpose='host_edit' ORDER BY created_at ASC LIMIT 1`, [ivId]);
  assert.equal(first.granted, true);
  assert.match(first.text_snapshot, /substituir a fotografia minha|replace the photo of me/);
  // sessão nova do convidado (link de validação)
  const { createInvitation } = await import('../src/invites.ts');
  const link = await createInvitation(db, await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]), { name: 'Ana' }, { preview: true });
  const g = `gs=${cookies(await post(`/i/${link.url!.split('/i/')[1]}/abrir`, {}, '')).gs}`;
  const gp = (await get('/entrevista/fotos', g)).body;
  assert.match(gp, /name="host_edit"/, 'o convidado pode retirar (ou dar) a autorização nas autorizações das fotografias');

  const jpg = await sharp({ create: { width: 320, height: 320, channels: 3, background: '#468' } }).jpeg().toBuffer();
  const upload = (extra: any = { 'x-photo-rights': '1' }) => app.inject({ method: 'POST', url: `/api/entrevistas/${ivId}/foto-convidado`, payload: jpg, headers: { 'content-type': 'image/jpeg', cookie: owner, ...extra } });
  // as autorizações das fotografias enviadas sem a caixa retiram-na: o entrevistador não pode acrescentar
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1' }, g);
  let pg = await get(`/entrevistas/${ivId}/producao`, owner);
  assert.match(pg.body, /id="foto-convidado"[\s\S]*não deu \(ou retirou\) a autorização de edição/);
  assert.equal((await upload()).statusCode, 409);

  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1', host_edit: '1' }, g);
  pg = await get(`/entrevistas/${ivId}/producao`, owner);
  assert.match(pg.body, /id="gphotoBtn"/); assert.match(pg.body, /src="\/static\/guest-photo\.js"/);
  assert.equal((await upload({})).statusCode, 422, 'sem a declaração de direitos');
  const r = await upload();
  assert.equal(r.statusCode, 200, r.body);
  const added = JSON.parse(r.body);
  const row = await db.one('SELECT added_by FROM photos WHERE id=$1', [added.id]);
  assert.equal(row.added_by, 'host');
  assert.equal((await db.one('SELECT guest_photo_id FROM interviews WHERE id=$1', [ivId])).guest_photo_id, added.id, 'passa a ser a do vídeo');
  const { videoGuestPhoto } = await import('../src/guest-photos.ts');
  let iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]);
  assert.equal((await videoGuestPhoto(db, iv))!.id, added.id);
  // o convidado vê-a, identificada, e não conta para as três dele
  assert.match((await get('/entrevista/fotos', g)).body, /Acrescentada pelo entrevistador|Added by the interviewer/);

  // escolher outra (a do convidado) e voltar à acrescentada
  const own = await db.one(`SELECT id FROM photos WHERE interview_id=$1 AND added_by='guest' ORDER BY created_at LIMIT 1`, [ivId]);
  if (own) {
    await post(`/entrevistas/${ivId}/foto-convidado/escolher`, { photo: own.id }, owner);
    assert.equal((await db.one('SELECT guest_photo_id FROM interviews WHERE id=$1', [ivId])).guest_photo_id, own.id);
    await post(`/entrevistas/${ivId}/foto-convidado/escolher`, { photo: added.id }, owner);
  }
  // retirar a autorização de edição: a fotografia acrescentada deixa de ser usada (e não se escolhe)
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1' }, g);
  iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]);
  assert.notEqual((await videoGuestPhoto(db, iv))?.id, added.id);
  const ch = await post(`/entrevistas/${ivId}/foto-convidado/escolher`, { photo: added.id }, owner);
  assert.match(decodeURIComponent(ch.headers.location as string), /já não pode ser usada/);
  // só o entrevistador retira as que acrescentou; o ficheiro sai do disco
  await post(`/entrevistas/${ivId}/foto-convidado/${added.id}/eliminar`, {}, owner);
  assert.ok(!(await db.one('SELECT 1 FROM photos WHERE id=$1', [added.id])));
  assert.ok((await db.one('SELECT deleted_at FROM assets WHERE id=$1', [added.assetId])).deleted_at);
  if (own) {
    const no = await post(`/entrevistas/${ivId}/foto-convidado/${own.id}/eliminar`, {}, owner);
    assert.match(decodeURIComponent(no.headers.location as string), /Só pode retirar as fotografias que acrescentou/);
  }
  // política «só o entrevistador aprova»: não acrescenta (o convidado tem de ver a fotografia antes de publicar)
  const { hostPhotoBlock } = await import('../src/guest-photos.ts');
  assert.match((await hostPhotoBlock(db, { ...iv, review_policy: 'host_only' }))!, /o entrevistado vê e aprova/);
});
