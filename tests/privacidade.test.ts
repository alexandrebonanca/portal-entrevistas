import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';
// Email de apoio com a forma de um email pessoal: o dono não o quer na página de privacidade.
process.env.SUPPORT_EMAIL = 'pessoal.dono@exemplo.pt';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { PRIVACY_UPDATED } = await import('../src/privacy.ts');
const { purgeExpiredSessions } = await import('../src/worker.ts');
const { sha256 } = await import('../src/lib.ts');

let db: any, app: any, body = '';
before(async () => {
  db = await openDb(); await migrate(db); app = await buildApp(db);
  const r = await app.inject({ method: 'GET', url: '/privacy' });
  assert.equal(r.statusCode, 200);
  body = r.body;
});
after(async () => { await app.close(); await db.close(); });

/** Texto de uma secção (do <h2 id="…"> até ao <h2 seguinte ou ao fim). */
const section = (title: string) => {
  const m = new RegExp(`<h2 id="[a-z-]+">${title}</h2>`).exec(body);
  assert.ok(m, `secção «${title}»`);
  const j = body.indexOf('<h2', m.index + 4);
  return body.slice(m.index, j < 0 ? undefined : j);
};

test('privacidade: completa, sem o aviso «por completar» e sem o email pessoal', () => {
  assert.doesNotMatch(body, /must be completed/); assert.doesNotMatch(body, /before production use/);
  assert.equal(config.supportEmail, 'pessoal.dono@exemplo.pt');
  assert.ok(!body.includes(config.supportEmail), 'o SUPPORT_EMAIL nunca aparece');
  assert.ok(body.includes(`Last updated: ${PRIVACY_UPDATED}`)); assert.equal(PRIVACY_UPDATED, '22 October 2026');
  // Quem somos: a entidade proprietária e gestora, com país, morada, IVA e contacto.
  const who = section('Who we are');
  for (const v of [config.owner.name, 'Estonia', config.owner.address, `VAT ${config.owner.vat}`, `mailto:${config.owner.email}`]) assert.ok(who.includes(v), v);
  assert.match(who, /we process the interview on their behalf/i);
  assert.ok(who.includes(config.seller.name), 'a vendedora das Definições (por omissão a Telecert)');
  assert.match(who, /href="\/privacidade-pagamentos"/); assert.match(who, /href="\/termos"/);
  // Os direitos: contacto da Certif e a autoridade de controlo; nunca um encarregado de proteção de dados inventado.
  const rights = section('Your rights');
  assert.ok(rights.includes(`<a href="mailto:${config.owner.email}">${config.owner.email}</a>`));
  for (const r of ['access', 'correction', 'deletion', 'restriction', 'portable', 'object', 'withdraw it at any time', 'Andmekaitse Inspektsioon', 'may not be recoverable']) assert.ok(rights.includes(r), r);
  assert.doesNotMatch(body, /data protection officer/i);
});

test('privacidade: lista os terceiros integrados, as transferências e as bases legais', () => {
  const rec = section('Who receives data');
  for (const p of ['Render', 'OpenAI', 'Google', 'Replicate', 'MailerSend', 'Stripe', 'Moloni']) assert.ok(rec.includes(`<strong>${p}</strong>`), `${p} na lista`);
  assert.match(rec, /Veo, through Vertex AI or the Gemini API/); assert.match(rec, /us-central1/); assert.match(rec, /We do not sell personal data/);
  // Com a autorização só do entrevistador (veoPlan: hostVeo), as falas dele vão para o Veo com o texto literal, e as boas-vindas
  // e o agradecimento nomeiam o convidado (prepareScript): a página diz que o nome do convidado pode chegar à Google sem ele autorizar.
  assert.match(rec, /<strong>Google<\/strong> \(optional, only with the permission of the person shown\)[^<]*The interviewer’s lines can name the guest \(for example in the welcome and the thank-you\), so the guest’s name can reach Google with the interviewer’s permission alone\./);
  assert.match(section('AI processing'), /when only the interviewer allows AI video, the guest’s name can still be sent to Google without the guest’s permission/);
  assert.match(rec, /<strong>Replicate<\/strong>[^<]*the interviewer’s lines can mention the guest by name/);
  // O gestor de entidade só chega às chaves e aos dados de vendedora (canManage em routes/entities.ts); os utilizadores são do administrador.
  assert.ok(rec.includes('entity managers manage their organisation’s service accounts and seller details, but cannot see its members’ accounts or open their interviews'));
  assert.doesNotMatch(body, /settings and users/);
  // A Stripe recebe os dados também ao gravar a faturação de uma empresa com IVA de outro país da UE (verifyVatNumber), antes de qualquer compra.
  assert.match(rec, /<strong>Stripe<\/strong> \(when you buy, and when a business saves billing details with an EU VAT number from a country other than the seller’s, so that Stripe can check it in the EU VIES system\)/);
  assert.doesNotMatch(body, /only when you buy/);
  // Os fornecedores do laboratório só recebem retratos fictícios: não aparecem como destinatários.
  assert.doesNotMatch(body, /fal\.ai|WaveSpeed/);
  const tr = section('International transfers');
  assert.match(tr, /United States/); assert.match(tr, /standard contractual clauses/); assert.match(tr, /Chapter V of the GDPR/);
  assert.doesNotMatch(tr, /Data Privacy Framework|certified/i, 'nenhuma certificação que o código não prove');
  const what = section('What we collect and why');
  for (const b of ['performance of the contract', 'your consent', 'legitimate interest', 'legal obligations']) assert.ok(what.includes(b), b);
  assert.match(what, /nothing pre-ticked/);
});

test('privacidade: aprovação «por omissão», IA, prazos e cookies conforme o código', () => {
  const pub = section('Publication');
  assert.match(pub, /Nothing is published without the interviewer’s decision and, by default, your approval of the final version, and always with your approval when you appear animated by AI/);
  assert.doesNotMatch(body, /Nothing is published without your approval/);
  // Retirar a autorização da capa bloqueia a publicação dessa versão e tira a capa, a miniatura e o vídeo do episódio publicado
  // (approval.ts, coverWithdrawnSql; teste «retirar a autorização da capa» abaixo).
  assert.match(pub, /with your photos only while you allow it/);
  assert.match(pub, /If you withdraw permission to use your photos on the cover after a cover has been made with them, that version can no longer be published: the interviewer has to make a new version, whose cover leaves your photos out\. If it is already published, its cover, thumbnail and video \(the video shows the cover\) stop being shown on the episode page and in the gallery\./);
  assert.doesNotMatch(body, /does not change a cover|existing cover stays with the episode|when the cover was made/);
  assert.match(section('How long we keep data'), /a cover already made with their photos can no longer be published and, if it already is, it stops being shown together with its thumbnail and the video that shows it/);
  assert.match(section('Your rights'), /withdrawing permission for the cover also takes a cover already made with their photos off the episode/);
  const ai = section('AI processing');
  assert.match(ai, /no voice is cloned/); assert.match(ai, /audible notice/); assert.match(ai, /AI-animated portrait/); assert.match(ai, /AI-generated video · AI voice/);
  assert.match(ai, /not used to take decisions about anyone that have legal or similarly significant effects/);
  const keep = section('How long we keep data');
  for (const v of ['14 days', '180 days', '62 days', '90 days', 'no automatic deletion period', 'kept privately until deletion is requested']) assert.ok(keep.includes(v), v);
  // As faturas: o prazo é o da lei, cumprido pela vendedora; o portal não apaga as suas cópias (não há prazo implementado).
  assert.match(keep, /Invoices and VAT evidence: kept by the seller for the period tax law requires; the portal’s copies have no automatic deletion yet\./);
  assert.doesNotMatch(body, /10 years/);
  // As contagens da composição apaga-as o worker (purgeComposeUsage), uma vez por hora.
  assert.match(keep, /Composition assistant daily counts: deleted once they are more than 62 days old \(checked every hour\)\./);
  assert.match(keep, /record of a session[^<]*is deleted when you sign out or within about an hour after the session expires/);
  // Os pedidos ao suporte não são apagados com a entrevista ou a conta (não há forma de as apagar no portal).
  assert.doesNotMatch(body, /deleted together with the interview or the account/);
  const ck = section('Cookies and browser storage');
  assert.match(ck, /<code>sid<\/code>/); assert.match(ck, /<code>gs<\/code>/); assert.match(ck, /no advertising, analytics or third-party cookies/);
});

test('privacidade: o worker apaga as sessões expiradas (de quem tem conta e dos convidados) e mantém as válidas', async () => {
  const u = await db.one(`INSERT INTO users(email, name, password_hash) VALUES ('sessoes@example.com','S','x') RETURNING id`);
  const iv = await db.one(`INSERT INTO interviews(owner_id, title) VALUES ($1,'Sessões') RETURNING id`, [u.id]);
  const inv = await db.one(`INSERT INTO invitations(interview_id, token_hash, question_version, expires_at, purpose) VALUES ($1,'h-sessoes',1, now() + interval '1 day','invite') RETURNING id`, [iv.id]);
  await db.query(`INSERT INTO sessions(id, user_id, expires_at) VALUES ($1,$3, now() - interval '1 minute'), ($2,$3, now() + interval '1 day')`, [sha256('sid-velha'), sha256('sid-nova'), u.id]);
  await db.query(`INSERT INTO guest_sessions(id, interview_id, invitation_id, expires_at) VALUES ($1,$3,$4, now() - interval '1 minute'), ($2,$3,$4, now() + interval '1 day')`, [sha256('gs-velha'), sha256('gs-nova'), iv.id, inv.id]);
  assert.equal(await purgeExpiredSessions(db, true), 2);
  assert.deepEqual((await db.query('SELECT id FROM sessions WHERE user_id=$1', [u.id])).map((r: any) => r.id), [sha256('sid-nova')]);
  assert.deepEqual((await db.query('SELECT id FROM guest_sessions WHERE invitation_id=$1', [inv.id])).map((r: any) => r.id), [sha256('gs-nova')]);
  assert.equal(await purgeExpiredSessions(db), 0, 'no máximo uma vez por hora sem «force»');
  // A sessão que ficou continua a dar entrada.
  const r = await app.inject({ method: 'GET', url: '/account', cookies: { sid: 'sid-nova' } });
  assert.equal(r.statusCode, 200);
});

test('privacidade: retirar a autorização da capa antes e depois de publicar', async () => {
  const { enqueue, runOne } = await import('../src/jobs.ts');
  const { handlers } = await import('../src/pipeline.ts');
  const { saveAsset } = await import('../src/media.ts');
  const { coverWithdrawn } = await import('../src/approval.ts');
  const sharp = (await import('sharp')).default;
  const post = (url: string, body: Record<string, string>, cookies: Record<string, string>) =>
    app.inject({ method: 'POST', url, payload: new URLSearchParams(body).toString(), headers: { 'content-type': 'application/x-www-form-urlencoded' }, cookies });
  const get = (url: string, cookies: Record<string, string> = {}) => app.inject({ method: 'GET', url, cookies });
  const owner = { sid: 'sid-capa' }, guest = { gs: 'gs-capa' };
  const u = await db.one(`INSERT INTO users(email, name, password_hash) VALUES ('capa@example.com','Capa','x') RETURNING id`);
  await db.query(`INSERT INTO sessions(id, user_id, expires_at) VALUES ($1,$2, now() + interval '1 day')`, [sha256(owner.sid), u.id]);
  // «Só o entrevistador aprova»: era o caso em que a capa com as fotografias se publicava depois de retirada a autorização.
  const iv = await db.one(`INSERT INTO interviews(owner_id, title, host_name, guest_name, review_policy, collection_status, subtitle_langs) VALUES ($1,'Capas','Ana','Rui','host_only','submitted', ARRAY['en']) RETURNING id`, [u.id]);
  const inv = await db.one(`INSERT INTO invitations(interview_id, token_hash, question_version, expires_at, purpose) VALUES ($1,'h-capa',1, now() + interval '1 day','invite') RETURNING id`, [iv.id]);
  await db.query(`INSERT INTO guest_sessions(id, interview_id, invitation_id, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')`, [sha256(guest.gs), iv.id, inv.id]);
  await db.query(`INSERT INTO consents(interview_id, purpose, granted, text_version, text_snapshot) VALUES ($1,'processing',true,'t','t'), ($1,'publish',true,'t','t')`, [iv.id]);
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1' }, guest);
  const jpg = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#3a6' } }).jpeg().toBuffer();
  const photo = await db.one('INSERT INTO photos(interview_id, asset_id) VALUES ($1,$2) RETURNING id', [iv.id, await saveAsset(db, { interviewId: iv.id, kind: 'guest_photo', mime: 'image/jpeg', ext: 'jpg', data: jpg })]);
  const seg = (id: string, type: string, text: string) => ({ id, speakerRole: 'host', textEnglish: text, sourceQuestionId: null, transformationType: type });
  const script = await db.one(`INSERT INTO scripts(interview_id, revision, title_en, segments, status, prompt_version, model) VALUES ($1,1,'Covers',$2,'approved','t','t') RETURNING id`,
    [iv.id, JSON.stringify([seg('intro', 'editorial_intro', 'Welcome. Today Rui joins us to talk about covers.'), seg('outro', 'editorial_outro', 'Thank you, Rui, for sharing your time and experience with us.')])]);
  const generate = async () => {
    await enqueue(db, { kind: 'generate_episode', interviewId: iv.id, input: { scriptId: script.id, subtitleLangs: ['en'], coverPhotoIds: [photo.id] } });
    while (await runOne(db, handlers)) { /* */ }
    const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1`, [iv.id]);
    assert.ok(ep, JSON.stringify(await db.query(`SELECT state, error FROM jobs WHERE interview_id=$1`, [iv.id])));
    return ep;
  };

  // 1. Capa feita com a fotografia: o episódio guarda as fotografias que entraram de facto na capa (e a escolha, como antes).
  const ep = await generate();
  assert.deepEqual(ep.technical.coverPhotos, [photo.id]); assert.deepEqual(ep.technical.coverPhotoIds, [photo.id]);
  assert.deepEqual(ep.technical.qcIssues, []);
  assert.equal(await coverWithdrawn(db, ep.id), false);
  await post(`/entrevistas/${iv.id}/episodio/${ep.id}/aprovar`, {}, owner);

  // 2. Retirada antes de publicar: a publicação fica bloqueada, com o motivo na recusa e na página.
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1' }, guest);
  assert.equal(await coverWithdrawn(db, ep.id), true);
  const blocked = await post(`/entrevistas/${iv.id}/episodio/${ep.id}/publicar`, { visibility: 'public', gallery: '1' }, owner);
  assert.match(decodeURIComponent(String(blocked.headers.location)), /Publicação bloqueada: O entrevistado retirou a autorização da capa: regenere o episódio\./);
  assert.equal((await db.one('SELECT status FROM episodes WHERE id=$1', [ep.id])).status, 'preview');
  assert.match((await get(`/entrevistas/${iv.id}/producao`, owner)).body, /Ainda não é possível publicar: O entrevistado retirou a autorização da capa: regenere o episódio\./);

  // 3. Com a autorização dada de novo, publica-se; a capa, a miniatura e o vídeo (semeado) são servidos e aparecem.
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1' }, guest);
  assert.match(String((await post(`/entrevistas/${iv.id}/episodio/${ep.id}/publicar`, { visibility: 'public', gallery: '1' }, owner)).headers.location), /ok=/);
  const vid = await saveAsset(db, { interviewId: iv.id, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: Buffer.from('mp4') });
  await db.query('UPDATE episodes SET video_asset_id=$2 WHERE id=$1', [ep.id, vid]);
  const s = ep.slug;
  for (const p of ['cover', 'thumb', 'video', 'audio']) assert.equal((await get(`/e/${s}/${p}`)).statusCode, 200, p);
  assert.match((await get(`/e/${s}`)).body, new RegExp(`<video[^>]*poster="/e/${s}/cover"[\\s\\S]*<img src="/e/${s}/cover"`));
  assert.ok((await get('/podcasts')).body.includes(`src="/e/${s}/thumb"`));

  // 4. Retirada depois de publicar: a capa, a miniatura e o vídeo (que mostra a capa) deixam de ser servidos e saem da página e
  // da galeria; o episódio continua no ar com o áudio, e os ficheiros ficam com o entrevistador.
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1' }, guest);
  for (const p of ['cover', 'thumb', 'video']) assert.equal((await get(`/e/${s}/${p}`)).statusCode, 404, p);
  assert.equal((await get(`/e/${s}/audio`)).statusCode, 200);
  const pg = await get(`/e/${s}`);
  assert.equal(pg.statusCode, 200); assert.ok(!pg.body.includes(`/e/${s}/cover`)); assert.doesNotMatch(pg.body, /<video/);
  const gal = (await get('/podcasts')).body;
  assert.ok(gal.includes(`/e/${encodeURIComponent(s)}`)); assert.ok(!gal.includes(`/e/${s}/thumb`)); assert.doesNotMatch(gal, / · video/);
  assert.match((await get(`/entrevistas/${iv.id}/producao`, owner)).body, /O entrevistado retirou a autorização da capa: a capa, a miniatura e o vídeo \(que mostra a capa\) deixaram de ser mostrados/);
  assert.equal((await get(`/media/${ep.cover_asset_id}`, owner)).statusCode, 200, 'o ficheiro fica guardado em privado');

  // 5. Uma capa feita depois da retirada já não leva a fotografia, mesmo escolhida: não conta como retirada.
  const ep2 = await generate();
  assert.notEqual(ep2.id, ep.id);
  assert.deepEqual(ep2.technical.coverPhotoIds, [photo.id]); assert.deepEqual(ep2.technical.coverPhotos, []);
  assert.equal(await coverWithdrawn(db, ep2.id), false);

  // 6. Com a autorização dada de novo, o episódio publicado volta a mostrar a capa.
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1' }, guest);
  assert.equal((await get(`/e/${s}/cover`)).statusCode, 200);

  // 7. Episódios anteriores ao campo coverPhotos: por prudência, conta a escolha do entrevistador se a autorização chegou a ser
  // dada e a última foi retirada; sem nenhuma autorização da capa, a capa não podia ter fotografias.
  const old = await db.one(`INSERT INTO episodes(interview_id, script_id, slug, title, technical) VALUES ($1,$2,'capa-antiga','Old',$3) RETURNING id`, [iv.id, script.id, JSON.stringify({ coverPhotoIds: [photo.id] })]);
  assert.equal(await coverWithdrawn(db, old.id), false, 'autorização em vigor');
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1' }, guest);
  assert.equal(await coverWithdrawn(db, old.id), true, 'autorização retirada');
  const iv2 = await db.one(`INSERT INTO interviews(owner_id, title) VALUES ($1,'Sem capa') RETURNING id`, [u.id]);
  const sc2 = await db.one(`INSERT INTO scripts(interview_id, revision, title_en, segments, status, prompt_version, model) VALUES ($1,1,'X','[]','approved','t','t') RETURNING id`, [iv2.id]);
  const old2 = await db.one(`INSERT INTO episodes(interview_id, script_id, slug, title, technical) VALUES ($1,$2,'capa-antiga-2','Old',$3) RETURNING id`, [iv2.id, sc2.id, JSON.stringify({ coverPhotoIds: [photo.id] })]);
  assert.equal(await coverWithdrawn(db, old2.id), false, 'nunca autorizada');
});

test('privacidade: parágrafos já testados mantêm-se iguais', () => {
  assert.ok(body.includes('<h2 id="campaign-links">Campaign links</h2><p>Visits to the home page and the sign-up page, and to the gallery and episode pages when the link carries campaign tags, are counted as daily totals by page and by the campaign tags in the link (or the website you came from). These counters use no cookies and hold no IP address or anything else that identifies you; like any request, the visit also appears in the server’s technical logs, which record the IP address and the page address. When you create an account, the campaign tags you arrived with, or otherwise the website you came from, are kept with your account to measure campaign results.</p>'));
  assert.ok(body.includes('<h2 id="composition-assistant">Composition assistant</h2><p>When an interviewer with access to it asks the composition assistant on the interview edit page for suggestions, the saved title, goal, roles and question texts of that draft, and the optional request typed in the panel, are sent to OpenAI to draft suggestions (emails, website addresses and phone numbers in the usual formats are masked first); the name and email fields and the personal message are not sent. The portal keeps only a daily count of requests per account, not the texts or the suggestions.</p>'));
  assert.match(section('Help assistant and support'), /never sent to AI services[^<]*stored for|stored for 180 days[^<]*never sent to AI services/);
});

test('privacidade: formulário de contacto, direitos também pelo /contact e alojamento em Frankfurt', () => {
  const cf = section('Contact form');
  for (const v of ['your name, your email address, the topic you choose, your message', 'the address or title of an episode', 'only to answer your request',
    'legitimate interest', 'steps you ask us to take before entering into a contract', 'read only by the portal’s administrators',
    'through MailerSend with a private link to the conversation', 'never contain your message or our reply', 'Anyone who has the link can read the conversation and reply in it',
    'no automatic deletion period yet', 'until an administrator deletes the request', 'stops the link working']) assert.ok(cf.includes(v), v);
  assert.match(cf, /<a href="\/contact">contact form<\/a>/);
  assert.match(section('How long we keep data'), /Contact-form conversations \(name, email address, topic, episode reference and messages\)[^<]*kept until an administrator deletes the request, with no automatic deletion period yet/);
  assert.match(section('What we collect and why'), /<strong>Contact form:<\/strong>/);
  assert.match(section('Help assistant and support'), /Messages that account holders and guests send to support stay inside the portal \(no email is sent\)/);
  assert.match(section('Who we are'), /Contact: <a href="mailto:[^"]+">[^<]+<\/a> or the <a href="\/contact">contact form<\/a>\./);
  const rights = section('Your rights');
  assert.ok(rights.includes('<a href="/contact?topic=privacy">contact form</a> (topic “Privacy request”)'));
  assert.match(rights, /the help page of the interview while their link is valid, and the contact form after that/);
  // Render: empresa dos EUA, com o serviço e a base na região de Frankfurt (UE)
  const rec = section('Who receives data');
  assert.match(rec, /<strong>Render<\/strong> \(always\)[^<]*The service and its database run in Render’s Frankfurt region, in the EU\./);
  assert.match(section('International transfers'), /Render, the hosting provider, is also based there, although the service and its database run in its Frankfurt region, in the EU/);
  assert.doesNotMatch(body, /in the region chosen for it/);
  // OpenAI: o rótulo com os usos reais (também fora do processamento de uma entrevista)
  assert.match(rec, /<strong>OpenAI<\/strong> \(when answers, recorded questions or goals are transcribed, when questions are read aloud, when a script, its narration, subtitles or a cover are made, and when the assistants are used\)/);
  assert.doesNotMatch(body, /whenever an interview is processed/);
  // MailerSend: os emails do formulário e o seguimento desligado (MAILERSEND_SETTINGS em src/mail.ts)
  assert.match(rec, /<strong>MailerSend<\/strong>[^<]*the emails with the private link to a contact-form conversation\. Emails are sent with MailerSend’s open, click and content tracking switched off/);
  // Limites por IP: só em memória, enquanto contam (sweepRateLimits)
  assert.match(section('What we collect and why'), /<li id="abuse-limits"><strong>Abuse limits:<\/strong> sign-in, sign-up, invitation, support, contact-form and assistant requests are counted per IP address \(and, on the contact form, also per email address\) in the server’s memory, never in the database\. Each count lasts from 10 minutes to a day, and an address leaves the memory within about a minute after its count ends/);
});

test('privacidade: convidados (primeira abertura, registo e emails com o link pessoal), «(in Portuguese)» e remissões com âncora', () => {
  const what = section('What we collect and why');
  assert.match(what, /the first time you open your link is recorded and shown to the interviewer/);
  assert.match(what, /a log of key steps \([^)]*\) keeps what was done and when, without your IP address/);
  assert.match(what, /reach you by email, through MailerSend, with your personal link: anyone who has the link can open your interview while it is valid/);
  // as páginas em português dizem-no na ligação
  const pt = [...body.matchAll(/<a href="\/(termos|privacidade-pagamentos)">[^<]*<\/a>( \(in Portuguese\))?/g)];
  assert.equal(pt.length, 3);
  for (const m of pt) assert.ok(m[2], `${m[0]} sem «(in Portuguese)»`);
  // cada remissão «see …» é uma ligação para uma âncora que existe, e todas as secções têm âncora
  const ids = new Set([...body.matchAll(/ id="([a-z-]+)"/g)].map(m => m[1]));
  const refs = [...body.matchAll(/href="#([a-z-]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 10, `${refs.length} remissões`);
  for (const r of refs) assert.ok(ids.has(r), `#${r} sem âncora`);
  assert.doesNotMatch(body, /\(see [A-Z][^<)]*\)|described under [A-Z]/, 'nenhuma remissão sem ligação');
  assert.doesNotMatch(body, /<h2>/, 'todas as secções com âncora');
});

test('privacidade: a FAQ do assistente não contradiz a /privacy nem manda escrever por email', async () => {
  const { FAQ_SEED } = await import('../src/assistant-faq.ts');
  const answers = FAQ_SEED.flatMap(e => [e.pt[1], e.en[1]]).join('\n');
  assert.doesNotMatch(answers, /ou por email|or by email|contacte-nos|contact us|contacto de apoio|support contact/i);
  const by = (k: string) => FAQ_SEED.find(e => e.key === k)!;
  // retirar a autorização do vídeo IA: apagam-se os vídeos e os clipes do Veo; os do retrato animado ficam (eraseGuestAiVideo)
  assert.match(by('convidado-video-ia').pt[1], /os vídeos do episódio em que aparece animado deixam de ser mostrados e são apagados, tal como os clipes do Google Veo com a sua imagem; os clipes do retrato animado ficam guardados em privado até pedir ao suporte/);
  assert.match(by('convidado-video-ia').en[1], /together with the Google Veo clips of you; the animated-portrait clips are kept privately until you ask support/);
  assert.match(section('How long we keep data'), /together with their Google Veo clips; animated-portrait clips are kept privately until deletion is requested/);
  assert.match(by('convidado-privacidade').pt[1], /depois de o link deixar de valer, use o formulário de contacto do portal/);
  assert.match(by('convidado-suporte').en[1], /for a new request, use the portal’s contact form/);
  assert.match(by('convidado-aprovar').en[1], /use the link «Ask for a correction or the withdrawal of the episode» \(it opens the portal’s contact form with the episode filled in\)/);
  assert.match(by('devolucoes').pt[1], /peça-o ao suporte, nesta página de ajuda\./);
});

test('emails: a MailerSend recebe o seguimento desligado (aberturas, cliques e conteúdo) em cada envio, e o rodapé liga à /privacy', async () => {
  const { queueEmail, flushOutbox, MAILERSEND_SETTINGS, emailShell } = await import('../src/mail.ts');
  assert.deepEqual(MAILERSEND_SETTINGS, { track_clicks: false, track_opens: false, track_content: false });
  const sent: any[] = [], realFetch = globalThis.fetch;
  process.env.MAILERSEND_API_KEY = 'chave-falsa-dos-testes'; // nunca sai daqui: o fetch é substituído
  globalThis.fetch = (async (u: any, init: any) => {
    sent.push({ url: String(u), body: JSON.parse(init.body) });
    return new Response('', { status: 202, headers: { 'x-message-id': `m${sent.length}` } });
  }) as any;
  try {
    await queueEmail(db, { key: 'teste-seguimento', to: 'seguimento@exemplo.pt', subject: 'Teste', html: emailShell('Teste', '<p>Teste</p>'), text: 'Teste' });
    await flushOutbox(db);
  } finally { globalThis.fetch = realFetch; delete process.env.MAILERSEND_API_KEY; }
  const m = sent.find(x => x.body.to?.[0]?.email === 'seguimento@exemplo.pt');
  assert.ok(m, 'enviado pela API');
  assert.equal(m.url, 'https://api.mailersend.com/v1/email');
  assert.deepEqual(m.body.settings, { track_clicks: false, track_opens: false, track_content: false });
  for (const x of sent) assert.deepEqual(x.body.settings, MAILERSEND_SETTINGS, 'em todos os envios');
  const row = await db.one(`SELECT state, provider_id FROM emails WHERE dedupe_key='teste-seguimento'`);
  assert.deepEqual([row.state, row.provider_id], ['sent', `m${sent.indexOf(m) + 1}`]);
  // rodapé por omissão: o formulário de contacto e a página de privacidade
  assert.match(m.body.html, /<a href="http:\/\/test\.local\/contact" style="color:#b4691f">Contacto<\/a> · <a href="http:\/\/test\.local\/privacy" style="color:#b4691f">Privacidade<\/a><\/p>/);
  assert.match(emailShell('T', '', undefined, { lang: 'en' }), /Contact us<\/a> · <a href="http:\/\/test\.local\/privacy" style="color:#b4691f">Privacy<\/a>/);
});

test('privacidade: os contadores dos limites por IP saem da memória quando deixam de contar', async () => {
  const { rateLimit, rateLimitAll, rateRoom, sweepRateLimits, rateHeld } = await import('../src/lib.ts');
  const t0 = Date.now();
  assert.equal(rateLimit('teste-ip:198.51.100.7', 2, 10 * 60_000), true);
  assert.equal(rateLimitAll([['teste-ip:198.51.100.8', 5, 3600_000], ['teste-email:a@exemplo.pt', 5, 24 * 3600_000]]), true);
  assert.equal(rateRoom('teste-ip:198.51.100.9', 1, 60_000), true);
  assert.equal(rateHeld('teste-ip:198.51.100.9'), false, 'conferir se há lugar não guarda nada');
  assert.equal(rateLimit('teste-fechado:198.51.100.10', 0, 60_000), false);
  assert.equal(rateHeld('teste-fechado:198.51.100.10'), false, 'uma recusa sem contagens não guarda a chave');
  const held = () => ['teste-ip:198.51.100.7', 'teste-ip:198.51.100.8', 'teste-email:a@exemplo.pt'].map(rateHeld);
  sweepRateLimits(t0 + 10 * 60_000 - 1000);
  assert.deepEqual(held(), [true, true, true], 'ainda contam');
  sweepRateLimits(t0 + 10 * 60_000 + 1000);
  assert.deepEqual(held(), [false, true, true], 'a janela de 10 min acabou');
  sweepRateLimits(t0 + 3600_000 + 1000);
  assert.deepEqual(held(), [false, false, true]);
  sweepRateLimits(t0 + 24 * 3600_000 + 1000);
  assert.deepEqual(held(), [false, false, false], 'o email do formulário sai ao fim do dia');
  // Uma chave cujos instantes saíram da janela sai do Map no pedido seguinte (sem esperar pela limpeza).
  assert.equal(rateLimit('teste-ip:198.51.100.11', 1, 1), true);
  await new Promise(r => setTimeout(r, 5));
  assert.equal(rateLimitAll([['teste-ip:198.51.100.11', 0, 1]]), false);
  assert.equal(rateHeld('teste-ip:198.51.100.11'), false);
});

test('privacidade: o worker apaga as contagens da composição com mais de 62 dias', async () => {
  const { purgeComposeUsage, COMPOSE_USAGE_DAYS } = await import('../src/compose.ts');
  assert.equal(COMPOSE_USAGE_DAYS, 62);
  await db.query(`INSERT INTO compose_usage(who, day, n) VALUES ('teste-velha', current_date - 63, 1), ('teste-62', current_date - 62, 1), ('teste-recente', current_date - 1, 1)`);
  assert.equal(await purgeComposeUsage(db, true), 1);
  assert.deepEqual((await db.query(`SELECT who FROM compose_usage WHERE who LIKE 'teste-%' ORDER BY who`)).map((r: any) => r.who), ['teste-62', 'teste-recente']);
  assert.equal(await purgeComposeUsage(db), 0, 'no máximo uma vez por hora sem «force»');
});
