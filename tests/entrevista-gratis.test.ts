import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-gratis-'));
process.env.BASE_URL = 'http://test.local';
// Sentinela do email pessoal do dono: nunca aparece numa página nem num email (ver tests/suporte-inmail.test.ts).
process.env.SUPPORT_EMAIL = 'pessoal.gratis@exemplo.pt';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { config } = await import('../src/config.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { quotaFor } = await import('../src/billing.ts');
const { TERMS_VERSION } = await import('../src/legal.ts');
const { PRIVACY_UPDATED } = await import('../src/privacy.ts');
const { FAQ_SEED } = await import('../src/assistant-faq.ts');
const A = await import('../src/assistant.ts');
const F = await import('../src/free-interview.ts');
const M = await import('../src/metrics.ts');
const sharp = (await import('sharp')).default;

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
// Cada pedido de registo e de entrada vem de um endereço diferente (os limites por IP do registo e da entrada não interessam aqui).
let ipN = 1;
const ip = () => `10.9.${Math.floor(ipN / 250)}.${(ipN++ % 250) + 1}`;
const post = (url: string, body: any, cookie = '', headers: Record<string, string> = {}) => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'x-forwarded-for': ip(), ...headers } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const msgOf = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));
const PW = 'uma-palavra-passe-longa';
let admin = '';

/** Registo público: devolve a sessão e o id. */
const register = async (name: string, email: string, extra: Record<string, string> = {}) => {
  const r = await post('/registar', { name, email, password: PW, terms: 1, ...extra });
  assert.equal(r.statusCode, 302, r.body);
  return { ck: `sid=${cookies(r).sid}`, id: (await db.one('SELECT id FROM users WHERE email=$1', [email])).id as string };
};
/** Conta criada pelo administrador (email confirmado à partida), com a sessão dela. */
const created = async (name: string, email: string, more: Record<string, string> = {}) => {
  const r = await post('/admin/utilizadores', { name, email, password: PW, role: 'interviewer', ...more }, admin);
  assert.match(msgOf(r), /Utilizador criado/);
  const s = await post('/entrar', { email, password: PW });
  return { ck: `sid=${cookies(s).sid}`, id: (await db.one('SELECT id FROM users WHERE email=$1', [email])).id as string };
};
/** Rascunho pronto a convidar. */
const draft = async (ck: string, title: string, guestEmail: string, questions = ['Primeira?', 'Segunda?']) => {
  const c = await post('/entrevistas', { title }, ck);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  for (const text of questions) await post(`/entrevistas/${id}/perguntas`, { text }, ck);
  await post(`/entrevistas/${id}/guardar`, { title, objective_text: 'Objetivo', host_name: 'Host', guest_name: 'Convidado', guest_email: guestEmail, interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en' }, ck);
  return id;
};
const ivOf = (id: string) => db.one('SELECT collection_status, free_at, free_guest_hash, question_limit, answer_limit_sec, invited_at FROM interviews WHERE id=$1', [id]);
const userOf = (id: string) => db.one('SELECT email_verified_at, free_interview_at, free_interview_id, free_owner_hash FROM users WHERE id=$1', [id]);
const verifyMails = (email: string) => db.query(`SELECT * FROM emails WHERE to_email=$1 AND starts_with(dedupe_key, 'verify:') ORDER BY created_at, id`, [email]);
const tokenOf = (text: string) => /\/confirmar-email\/([A-Za-z0-9_-]{43})/.exec(text)![1];
const sendFree = (ck: string, id: string) => post(`/entrevistas/${id}/convidar`, { free: '1' }, ck);
/** Corre `fn` com os tetos da oferta e dos emails de confirmação alterados, e repõe-nos. */
const withLimits = async (o: Partial<typeof config.limits>, fn: () => Promise<void>) => {
  const old = { ...config.limits };
  Object.assign(config.limits, o);
  try { await fn(); } finally { Object.assign(config.limits, old); }
};

test('migração 036: as contas do registo público sem entidade ficam por confirmar; as outras, confirmadas', async () => {
  const old = await openDb();
  try {
    await migrate(old, { until: '035_suporte_visitante.sql' });
    const e = await old.one(`INSERT INTO entities(name, slug) VALUES ('Antes', 'antes') RETURNING id`);
    await old.query(`INSERT INTO users(email, name, password_hash, role, self_signup) VALUES ('adm@x.pt','A','x','admin',false), ('criado@x.pt','C','x','interviewer',false)`);
    await old.query(`INSERT INTO users(email, name, password_hash, role, self_signup) VALUES ('publico@x.pt','P','x','interviewer',true)`);
    await old.query(`INSERT INTO users(email, name, password_hash, role, self_signup, entity_id) VALUES ('ent@x.pt','E','x','interviewer',true,$1)`, [e.id]);
    await migrate(old);
    const v = Object.fromEntries((await old.query('SELECT email, email_verified_at IS NOT NULL AS ok, free_interview_at FROM users')).map((r: any) => [r.email, [r.ok, r.free_interview_at]]));
    assert.deepEqual(v, { 'adm@x.pt': [true, null], 'criado@x.pt': [true, null], 'publico@x.pt': [false, null], 'ent@x.pt': [true, null] });
    // a marca da entrevista grátis vem sempre com a impressão do convidado (e só com ela)
    const u = await old.one(`SELECT id FROM users WHERE email='criado@x.pt'`);
    const iv = await old.one(`INSERT INTO interviews(owner_id, title) VALUES ($1,'T') RETURNING id`, [u.id]);
    await assert.rejects(old.query(`UPDATE interviews SET free_at=now() WHERE id=$1`, [iv.id]));
    await assert.rejects(old.query(`UPDATE interviews SET free_at=now(), free_guest_hash='não' WHERE id=$1`, [iv.id]));
    // e a oferta usada pela conta vem sempre com a impressão da caixa de correio (e só com ela)
    await assert.rejects(old.query(`UPDATE users SET free_interview_at=now() WHERE id=$1`, [u.id]));
    await assert.rejects(old.query(`UPDATE users SET free_owner_hash=$2 WHERE id=$1`, [u.id, sha('x')]));
  } finally { await old.close(); }
});

test('registo: email «Confirm your email» sem texto de quem se regista, token só em hash; GET não confirma; certo, errado, expirado e reutilizado', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  assert.ok((await db.one(`SELECT email_verified_at FROM users WHERE email='admin@example.com'`)).email_verified_at, 'a primeira conta (administradora) fica confirmada');
  assert.equal((await verifyMails('admin@example.com')).length, 0);

  const reg = (await get('/registar')).body;
  assert.match(reg, /Your first interview is free: after you sign up, we email you a link to confirm your email address \(valid for 48 hours\)\. Once it is confirmed, you can send your first invitation with no payment and no card details, while available\./);
  const ana = await register('Ana <b>Promo</b> visite spam.example', 'ana@example.com');
  assert.equal((await userOf(ana.id)).email_verified_at, null);
  const [m] = await verifyMails('ana@example.com');
  assert.equal(m.subject, 'Confirm your email for quietinterview');
  assert.ok(!m.html.includes('Promo') && !m.text_body.includes('Promo') && !m.html.includes('spam.example'), 'o email nunca leva o nome escrito no registo');
  assert.match(m.text_body, /valid for 48 hours and can be used once/);
  assert.match(m.html, /Confirm my email/); assert.match(m.html, /href="http:\/\/test\.local\/contact"/);
  const token = tokenOf(m.text_body);
  const row = await db.one('SELECT * FROM email_verifications WHERE user_id=$1', [ana.id]);
  assert.equal(row.token_hash, sha(token), 'só a impressão do token na base');
  assert.ok(!JSON.stringify(row).includes(token));
  assert.equal(Math.round((new Date(row.expires_at).getTime() - new Date(row.created_at).getTime()) / 3600_000), 48);
  assert.deepEqual((await db.one(`SELECT meta FROM audit_events WHERE action='signup' AND actor='ana@example.com'`)).meta, { role: 'interviewer', emailVerification: 'sent' });

  // GET mostra o botão, sem cache, e não confirma
  const g = await get(`/confirmar-email/${token}`);
  assert.equal(g.statusCode, 200); assert.match(g.headers['cache-control'], /no-store/);
  assert.match(g.body, /<form method="post" action="\/confirmar-email"[^>]*><input type="hidden" name="token" value="[A-Za-z0-9_-]{43}"><button class="accent">Confirm my email<\/button>/);
  assert.match(g.body, /noindex/);
  assert.equal((await userOf(ana.id)).email_verified_at, null);
  // token errado ou malformado
  const wrong = randomBytes(32).toString('base64url');
  assert.equal((await get(`/confirmar-email/${wrong}`)).statusCode, 404);
  let r = await post('/confirmar-email', { token: wrong });
  assert.equal(r.statusCode, 404); assert.match(r.body, /This link is not valid/);
  assert.equal((await post('/confirmar-email', { token: "x' OR 1=1 --" })).statusCode, 404);
  assert.equal((await userOf(ana.id)).email_verified_at, null);
  // certo (sem sessão: página que confirma)
  r = await post('/confirmar-email', { token });
  assert.equal(r.statusCode, 200); assert.match(r.body, /Your email is confirmed/);
  assert.ok((await userOf(ana.id)).email_verified_at);
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='email.verified' AND actor='ana@example.com'`));
  // reutilizado
  r = await post('/confirmar-email', { token });
  assert.equal(r.statusCode, 200); assert.match(r.body, /This link has already been used\. Your email is confirmed\./);
  assert.match((await get(`/confirmar-email/${token}`)).body, /already been used/);

  // expirado: nem a página nem o POST confirmam
  const bia = await register('Bia', 'bia@example.com');
  const tb = tokenOf((await verifyMails('bia@example.com'))[0].text_body);
  await db.query(`UPDATE email_verifications SET expires_at = now() - interval '1 minute' WHERE user_id=$1`, [bia.id]);
  assert.equal((await get(`/confirmar-email/${tb}`)).statusCode, 410);
  r = await post('/confirmar-email', { token: tb });
  assert.equal(r.statusCode, 410); assert.match(r.body, /This link has expired\. A confirmed email is needed only for the free first interview: while it is offered, you can sign in and ask for a new link on your dashboard\./);
  assert.equal((await userOf(bia.id)).email_verified_at, null);

  // com a sessão da própria conta: volta ao painel
  const carla = await register('Carla', 'carla@example.com');
  r = await post('/confirmar-email', { token: tokenOf((await verifyMails('carla@example.com'))[0].text_body) }, carla.ck);
  assert.equal(r.headers.location, '/painel?ok=Email%20confirmado.#gratis');
  assert.ok((await userOf(carla.id)).email_verified_at);
});

test('«Reenviar»: link novo (o anterior continua válido), 3 por hora, volta só a páginas do portal; teto global dos emails de confirmação', async () => {
  const bia = { ck: `sid=${cookies(await post('/entrar', { email: 'bia@example.com', password: PW })).sid}`, id: (await db.one(`SELECT id FROM users WHERE email='bia@example.com'`)).id };
  const painel = (await get('/painel', bia.ck)).body;
  assert.match(painel, /<strong>A sua 1\.ª entrevista é grátis<\/strong>, depois de confirmar o email da sua conta\. Enviámos uma ligação para bia@example\.com/);
  assert.match(painel, /<form method="post" action="\/confirmar-email\/reenviar"[^>]*><input type="hidden" name="voltar" value="\/painel"><button[^>]*>Reenviar<\/button>/);
  let r = await post('/confirmar-email/reenviar', { voltar: '/painel' }, bia.ck);
  assert.match(msgOf(r), /^\/painel\?ok=Enviámos uma ligação nova para bia@example\.com\.#gratis$/);
  assert.equal((await verifyMails('bia@example.com')).length, 2);
  // a página de origem: só as do portal (outra qualquer volta ao painel)
  r = await post('/confirmar-email/reenviar', { voltar: 'https://evil.example/x' }, bia.ck);
  assert.match(msgOf(r), /^\/painel\?ok=/);
  r = await post('/confirmar-email/reenviar', { voltar: '/account' }, bia.ck);
  assert.match(msgOf(r), /^\/account\?ok=We sent a new link to bia@example\.com\.#gratis$/, 'na Conta (em inglês), a mensagem em inglês');
  assert.equal((await verifyMails('bia@example.com')).length, 4);
  r = await post('/confirmar-email/reenviar', { voltar: '/painel' }, bia.ck);
  assert.match(msgOf(r), /e=Já pediu vários emails de confirmação nesta hora/);
  assert.equal((await verifyMails('bia@example.com')).length, 4, 'o 4.º pedido na hora não envia');
  // os links anteriores continuam válidos até expirarem (cada um uma vez)
  const mails = await verifyMails('bia@example.com');
  assert.equal((await post('/confirmar-email', { token: tokenOf(mails[1].text_body) })).statusCode, 200);
  assert.ok((await userOf(bia.id)).email_verified_at);
  r = await post('/confirmar-email', { token: tokenOf(mails[2].text_body) });
  assert.match(r.body, /Your email is confirmed/, 'outro link válido depois de confirmada: nada muda');
  // sem sessão: para a entrada
  assert.equal((await post('/confirmar-email/reenviar', { voltar: '/painel' })).headers.location, '/entrar');
  // já confirmada
  const carla = `sid=${cookies(await post('/entrar', { email: 'carla@example.com', password: PW })).sid}`;
  assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, carla)), /ok=O seu email já está confirmado/);

  // teto global (contado na fila de emails): acima dele, a conta fica criada sem email e o painel deixa pedir outro
  const n = Number((await db.one(`SELECT count(*)::int n FROM emails WHERE starts_with(dedupe_key, 'verify:')`)).n);
  await withLimits({ verifyEmailsPerHour: n }, async () => {
    const dora = await register('Dora', 'dora@example.com');
    assert.equal((await verifyMails('dora@example.com')).length, 0);
    assert.equal((await db.one(`SELECT meta FROM audit_events WHERE action='signup' AND actor='dora@example.com'`)).meta.emailVerification, 'cap');
    assert.match((await get('/painel', dora.ck)).body, /Ainda não foi possível enviar a ligação para dora@example\.com: carregue em «Reenviar»/);
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, dora.ck)), /e=Não foi possível enviar o email agora/);
  });
  await withLimits({ verifyEmailsPerDay: 0 }, async () => {
    const dora = `sid=${cookies(await post('/entrar', { email: 'dora@example.com', password: PW })).sid}`;
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, dora)), /e=Não foi possível enviar/, '0 desliga os emails de confirmação');
  });
  const dora = `sid=${cookies(await post('/entrar', { email: 'dora@example.com', password: PW })).sid}`;
  assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, dora)), /ok=Enviámos uma ligação nova/);
  assert.equal((await verifyMails('dora@example.com')).length, 1);
});

test('contas confirmadas à partida: criadas pelo administrador e pelo link de registo de uma entidade', async () => {
  await post('/admin/entidades', { name: 'Entidade Teste' }, admin);
  const slug = (await db.one(`SELECT slug FROM entities WHERE name='Entidade Teste'`)).slug;
  assert.doesNotMatch((await get(`/registar?entidade=${slug}`)).body, /Your first interview is free/, 'a oferta não é das entidades');
  const e = await register('Eduarda', 'eduarda@example.com', { entidade: slug });
  assert.ok((await userOf(e.id)).email_verified_at);
  assert.equal((await verifyMails('eduarda@example.com')).length, 0);
  const c = await created('Criado', 'criado@example.com');
  assert.ok((await userOf(c.id)).email_verified_at);
  assert.equal((await verifyMails('criado@example.com')).length, 0);
});

test('elegibilidade: cada razão, pela ordem', async () => {
  const why = async (id: string, guestEmail?: string) => (await F.freeInterviewFor(db, { id }, guestEmail === undefined ? {} : { guestEmail })).reason;
  const adminId = (await db.one(`SELECT id FROM users WHERE email='admin@example.com'`)).id;
  assert.equal(await why(adminId), 'role');
  const ent = (await db.one(`SELECT id FROM entities WHERE name='Entidade Teste'`)).id;
  const gestor = await created('Gestor', 'gestor@example.com', { role: 'entity_admin', entity_id: ent });
  assert.equal(await why(gestor.id), 'role');
  assert.equal(await why((await db.one(`SELECT id FROM users WHERE email='eduarda@example.com'`)).id), 'entity');
  const dora = (await db.one(`SELECT id FROM users WHERE email='dora@example.com'`)).id;
  assert.equal(await why(dora), 'unverified');
  const ana = (await db.one(`SELECT id FROM users WHERE email='ana@example.com'`)).id;
  assert.equal(await why(ana), null);
  assert.equal((await F.freeInterviewFor(db, { id: ana })).eligible, true);
  // oferta desligada (um dos tetos a 0): antes do email por confirmar, para não pedir a confirmação de uma oferta que não há
  await withLimits({ freePerDay: 0 }, async () => { assert.equal(await why(ana), 'off'); assert.equal(await why(dora), 'off'); });
  await withLimits({ freePerMonth: 0 }, async () => { assert.equal(await why(ana), 'off'); });
  // tetos (dia e mês), pela contagem na base (com uma entrevista grátis de outra conta já enviada hoje)
  const other = await db.one(`INSERT INTO interviews(owner_id, title, guest_email, collection_status, free_at, free_guest_hash) VALUES ($1,'Antiga','x@y.pt','invited',now(),$2) RETURNING id`, [adminId, F.guestHash('Joao.Silva+podcast@GoogleMail.com')]);
  const c = await F.freeCounts(db);
  assert.ok(c.day >= 1 && c.month >= c.day);
  await withLimits({ freePerDay: c.day }, async () => { assert.equal(await why(ana), 'cap_day'); });
  await withLimits({ freePerDay: c.day + 1, freePerMonth: c.month }, async () => { assert.equal(await why(ana), 'cap_month'); });
  // subscrição ativa, e depois de cancelada (já teve subscrição)
  const s = await created('Sub', 'sub@example.com', { plan_id: 'start' });
  assert.equal(await why(s.id), 'subscribed');
  await db.query(`UPDATE subscriptions SET status='canceled' WHERE user_id=$1`, [s.id]);
  assert.equal(await why(s.id), 'had_subscription');
  await db.query(`UPDATE subscriptions SET status='inactive', plan_id=NULL WHERE user_id=$1`, [s.id]);
  assert.equal(await why(s.id), 'had_subscription', 'qualquer linha em subscriptions');
  // convidado que já recebeu uma entrevista grátis (email normalizado)
  assert.equal(await why(ana, 'joaosilva@gmail.com'), 'guest_used');
  assert.equal(await why(ana, ' JOAO.SILVA@gmail.com '), 'guest_used');
  assert.equal(await why(ana, 'joao.silva@exemplo.pt'), null, 'noutros domínios os pontos contam');
  assert.equal(F.normGuestEmail(' Rui.Costa+tag@Exemplo.PT '), 'rui.costa@exemplo.pt');
  await db.query('DELETE FROM interviews WHERE id=$1', [other.id]);
});

test('convite grátis: página, marca, limites do Start (da tabela), painel e Conta; usada leva à subscrição; não conta na quota depois', async () => {
  await db.query(`UPDATE plans SET max_questions=4, max_answer_total_sec=600 WHERE id='start'`);
  const fa = await created('Fábio', 'fabio@example.com');
  let painel = (await get('/painel', fa.ck)).body;
  assert.match(painel, /<strong>A sua 1\.ª entrevista é grátis\.<\/strong> Envie o primeiro convite sem pagamento nem dados de cartão, com os limites do plano Start \(até 4 perguntas, incluindo as adicionais, e até 10:00 min de respostas do entrevistado\)/);
  assert.match((await get('/account', fa.ck)).body, /<strong>Your first interview is free\.<\/strong> Send your first invitation with no payment and no card details, with the Start plan limits \(up to 4 questions/);

  const id = await draft(fa.ck, 'A grátis', 'Joao.Silva+x@gmail.com');
  const pg = (await get(`/entrevistas/${id}/convidar`, fa.ck)).body;
  assert.match(pg, /Este convite segue sem pagamento nem dados de cartão/);
  assert.match(pg, /<input type="hidden" name="free" value="1"><button class="accent" >Enviar convite grátis<\/button>/);
  assert.match(pg, /até 4 perguntas, incluindo as adicionais; até 10:00 min de respostas do entrevistado no total/);
  assert.doesNotMatch(pg, /Precisa de uma subscrição ativa|Uso neste período/);
  // sem o pedido explícito (página antiga) não gasta a oferta
  assert.match(msgOf(await post(`/entrevistas/${id}/convidar`, {}, fa.ck)), /Precisa de uma subscrição ativa/);
  assert.equal((await ivOf(id)).collection_status, 'draft');
  // acima do limite de perguntas do Start: a página diz que é o da entrevista grátis
  const big = await draft(fa.ck, 'Grande', 'g@example.com', ['1?', '2?', '3?', '4?', '5?']);
  assert.match((await get(`/entrevistas/${big}/convidar`, fa.ck)).body, /Tem 5 perguntas; a entrevista grátis permite até 4 por entrevista/);
  await sendFree(fa.ck, big);
  assert.equal((await ivOf(big)).collection_status, 'draft');

  const r = await sendFree(fa.ck, id);
  assert.match(msgOf(r), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis\./);
  const iv = await ivOf(id);
  assert.equal(iv.collection_status, 'invited'); assert.ok(iv.free_at); assert.ok(iv.invited_at);
  assert.equal(iv.free_guest_hash, sha('free-guest:joaosilva@gmail.com'));
  assert.deepEqual([iv.question_limit, iv.answer_limit_sec], [4, 600], 'limites do Start, lidos da tabela');
  const u = await userOf(fa.id);
  assert.ok(u.free_interview_at); assert.equal(u.free_interview_id, id);
  assert.ok(await db.one(`SELECT 1 FROM invitations WHERE interview_id=$1 AND purpose='invite' AND revoked_at IS NULL`, [id]));
  assert.ok(await db.one(`SELECT 1 FROM emails WHERE interview_id=$1 AND starts_with(dedupe_key, 'invite:')`, [id]));
  assert.deepEqual((await db.one(`SELECT meta FROM audit_events WHERE action='invitation.sent' AND interview_id=$1`, [id])).meta, { free: true });
  assert.match((await get(`/entrevistas/${id}`, fa.ck)).body, /1\.ª entrevista grátis/);
  // duplo clique: nada muda
  assert.equal((await sendFree(fa.ck, id)).headers.location, `/entrevistas/${id}`);

  // usada: o painel, a página do convite e a Conta dizem-no e levam à subscrição
  painel = (await get('/painel', fa.ck)).body;
  assert.match(painel, /Já usou a sua entrevista grátis \(enviada em [^)]+\)\. Para enviar mais convites, escolha um plano em <a href="\/account">Conta<\/a>\./);
  const d2 = await draft(fa.ck, 'Segunda', 'outra@example.com');
  const pg2 = (await get(`/entrevistas/${d2}/convidar`, fa.ck)).body;
  assert.match(pg2, /Já usou a sua entrevista grátis/); assert.match(pg2, /Precisa de uma subscrição ativa para enviar convites/);
  assert.match(pg2, /<button class="accent" disabled>Enviar convite<\/button>/);
  assert.match(msgOf(await sendFree(fa.ck, d2)), /Já usou a sua entrevista grátis\. Para enviar mais convites, precisa de uma subscrição ativa/);
  assert.equal((await ivOf(d2)).collection_status, 'draft');
  assert.match((await get('/account', fa.ck)).body, /You have used your free interview \(sent on [^)]+\)\. To send more invitations, choose a plan below\./);

  // a introdução animada (Veo, custo do portal) não vem com a entrevista grátis
  await post(`/entrevistas/${id}/guardar`, { title: 'A grátis', host_name: 'Host', guest_name: 'Convidado', host_photo_rights: '1', host_ai_video: '1', review_policy: 'guest_preview' }, fa.ck);
  const jpg = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#555' } }).jpeg().toBuffer();
  assert.equal((await app.inject({ method: 'POST', url: `/api/entrevistas/${id}/foto`, payload: jpg, headers: { 'content-type': 'image/jpeg', cookie: fa.ck } })).statusCode, 200);
  assert.match(msgOf(await post(`/entrevistas/${id}/introducao`, { intro_phrase: 'welcome', acao: 'gerar' }, fa.ck)), /não está incluída na 1\.ª entrevista grátis/);
  assert.equal(await db.one('SELECT 1 FROM host_intros WHERE user_id=$1', [fa.id]), undefined);

  // subscreve depois: a entrevista grátis não conta para a quota do plano
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source, interviews_override) VALUES ($1,'start','active','manual',1)`, [fa.id]);
  const q = await quotaFor(db, { id: fa.id, role: 'interviewer' });
  assert.deepEqual([q.allowed, q.used, q.limit], [true, 0, 1]);
  assert.doesNotMatch((await get('/painel', fa.ck)).body, /entrevista grátis/, 'com subscrição, o painel já não fala da oferta');
  assert.match(msgOf(await post(`/entrevistas/${d2}/convidar`, {}, fa.ck)), /ok=Convite enviado\./);
  assert.equal((await ivOf(d2)).free_at, null);
  assert.equal((await quotaFor(db, { id: fa.id, role: 'interviewer' })).used, 1);
  await db.query(`UPDATE plans SET max_questions=15, max_answer_total_sec=900 WHERE id='start'`);
});

test('uma só por conta e por convidado (email normalizado), também vinda de outra conta; recusa neutra', async () => {
  const gi = await created('Gil', 'gil@example.com');
  const a = await draft(gi.ck, 'Mesmo convidado', 'JOAOSILVA@googlemail.com');
  assert.match((await get(`/entrevistas/${a}/convidar`, gi.ck)).body, /Enviar convite grátis/, 'a página não revela se o convidado já recebeu uma');
  const r = await sendFree(gi.ck, a);
  assert.match(msgOf(r), /e=A entrevista grátis não está disponível para este entrevistado\. Pode enviar o convite com uma subscrição ativa/);
  assert.deepEqual([(await ivOf(a)).collection_status, (await userOf(gi.id)).free_interview_at], ['draft', null], 'a oferta da conta continua por usar');
  // outro convidado: passa
  await post(`/entrevistas/${a}/guardar`, { title: 'Mesmo convidado', objective_text: 'Objetivo', host_name: 'Host', guest_name: 'Outro', guest_email: 'rita@example.com', review_policy: 'guest_preview', subtitle_langs: 'en' }, gi.ck);
  assert.match(msgOf(await sendFree(gi.ck, a)), /ok=/);
  // o índice único é a última defesa: a mesma impressão não entra duas vezes
  await assert.rejects(db.query(`UPDATE interviews SET free_at=now(), free_guest_hash=$2 WHERE id=(SELECT id FROM interviews WHERE id<>$1 AND free_at IS NULL LIMIT 1)`, [a, F.guestHash('rita@example.com')]));
  // tentativas de envio grátis por conta e por hora (cada recusa pelo convidado diz algo sobre esse email)
  const hu = await created('Hugo', 'hugo@example.com');
  const h = await draft(hu.ck, 'Sondagem', 'rita@example.com');
  for (let i = 0; i < 10; i++) assert.match(msgOf(await sendFree(hu.ck, h)), /não está disponível para este entrevistado/);
  assert.match(msgOf(await sendFree(hu.ck, h)), /Demasiadas tentativas de envio grátis nesta hora/);
});

test('tetos diário e mensal (0 desliga): textos neutros, nada enviado; landing e registo só anunciam com a oferta ligada', async () => {
  const ia = await created('Inês', 'ines@example.com');
  const id = await draft(ia.ck, 'Teto', 'teto@example.com');
  const c = await F.freeCounts(db);
  await withLimits({ freePerDay: c.day }, async () => {
    assert.match((await get('/painel', ia.ck)).body, /A oferta da 1\.ª entrevista grátis está temporariamente indisponível\. Pode tentar mais tarde ou escolher um plano em <a href="\/account">Conta<\/a>\./);
    const pg = (await get(`/entrevistas/${id}/convidar`, ia.ck)).body;
    assert.match(pg, /temporariamente indisponível/); assert.match(pg, /Precisa de uma subscrição ativa/);
    assert.match(msgOf(await sendFree(ia.ck, id)), /A oferta da 1\.ª entrevista grátis está temporariamente indisponível/);
    assert.match((await get('/account', ia.ck)).body, /The free first interview offer is temporarily unavailable/);
  });
  await withLimits({ freePerDay: c.day + 5, freePerMonth: c.month }, async () => {
    assert.match(msgOf(await sendFree(ia.ck, id)), /temporariamente indisponível/);
  });
  assert.equal((await ivOf(id)).collection_status, 'draft');

  // com a oferta ligada: a landing anuncia-a (limites do Start da tabela) e mantém a nota do IVA
  let home = (await get('/')).body;
  assert.match(home, /<strong>Your first interview is free<\/strong>: no card needed\. <a href="#free">/);
  assert.match(home, /<div class="card" id="free"[^>]*><h3[^>]*>Your first interview is free<\/h3>/);
  assert.match(home, /The free interview has the Start plan limits \(up to 15 questions and 15 minutes of answers\)/);
  assert.match(home, /One per person and organisation, and each guest can receive only one free interview\. A limited number of free interviews is available each day and each month; when they run out, the offer is temporarily unavailable\. The offer can be withdrawn at any time \(see the <a href="\/termos">terms<\/a>\)/);
  assert.match(home, /<a class="btn accent" href="\/registar">Send your first interview free<\/a>/);
  assert.match(home, /VAT, where it applies, depends on your country; the final price is always shown before you pay\./);
  assert.match(home, /Start from €19 \/ month/);
  // 0 desliga: nada na landing, no registo, no painel, na Conta nem na página do convite; o envio grátis é recusado
  await withLimits({ freePerMonth: 0 }, async () => {
    home = (await get('/')).body;
    assert.doesNotMatch(home, /first interview is free|id="free"/);
    assert.doesNotMatch((await get('/registar')).body, /first interview is free/);
    assert.doesNotMatch((await get('/painel', ia.ck)).body, /grátis/);
    assert.doesNotMatch((await get('/account', ia.ck)).body, /free interview|first interview is free/);
    const pg = (await get(`/entrevistas/${id}/convidar`, ia.ck)).body;
    assert.doesNotMatch(pg, /grátis/); assert.match(pg, /Precisa de uma subscrição ativa/);
    assert.match(msgOf(await sendFree(ia.ck, id)), /e=Precisa de uma subscrição ativa para enviar convites/);
    // o registo público não envia o email «Confirm your email» (ele promete a entrevista grátis), e «Reenviar» também não
    const off = await register('Desligada', 'desligada@example.com');
    assert.equal((await verifyMails('desligada@example.com')).length, 0);
    assert.equal(await db.one(`SELECT 1 FROM email_verifications WHERE user_id=$1`, [off.id]), undefined);
    assert.deepEqual((await db.one(`SELECT meta FROM audit_events WHERE action='signup' AND actor='desligada@example.com'`)).meta, { role: 'interviewer', emailVerification: 'off' });
    assert.doesNotMatch((await get('/painel', off.ck)).body, /grátis|Reenviar/);
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, off.ck)), /e=A 1\.ª entrevista grátis não está disponível neste momento: não é preciso confirmar o email\./);
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/account' }, off.ck)), /e=The free first interview is not offered at the moment/);
    assert.equal((await verifyMails('desligada@example.com')).length, 0);
    // as páginas do link (expirado ou inválido) não mandam carregar num «Reenviar» que não aparece
    const inv = await post('/confirmar-email', { token: randomBytes(32).toString('base64url') });
    assert.match(inv.body, /This link is not valid\. Check that you opened the whole address\. A confirmed email is needed only for the free first interview: while it is offered/);
    assert.doesNotMatch(inv.body, /Reenviar|Resend/);
  });
  // com a oferta de volta, a conta registada sem email pede o link no painel
  const off = `sid=${cookies(await post('/entrar', { email: 'desligada@example.com', password: PW })).sid}`;
  assert.match((await get('/painel', off)).body, /Ainda não foi possível enviar a ligação para desligada@example\.com: carregue em «Reenviar»/);
  assert.equal((await ivOf(id)).collection_status, 'draft');
  assert.match(msgOf(await sendFree(ia.ck, id)), /ok=/, 'com os tetos repostos, passa');
});

test('corrida: dois separadores da mesma conta, duas contas para o mesmo convidado e a última vaga do teto: só um passa', async () => {
  // a mesma conta, duas entrevistas
  const ju = await created('Júlia', 'julia@example.com');
  const [a, b] = [await draft(ju.ck, 'A', 'corrida-a@example.com'), await draft(ju.ck, 'B', 'corrida-b@example.com')];
  let rs = await Promise.all([sendFree(ju.ck, a), sendFree(ju.ck, b)]);
  let st = [await ivOf(a), await ivOf(b)];
  assert.equal(st.filter(s => s.collection_status === 'invited').length, 1, 'só uma entrevista grátis por conta');
  assert.equal(st.filter(s => s.free_at).length, 1);
  const won = st[0].free_at ? a : b, lost = won === a ? b : a;
  assert.equal((await userOf(ju.id)).free_interview_id, won);
  assert.match(msgOf(rs[won === a ? 1 : 0]), /Já usou a sua entrevista grátis/);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM invitations WHERE interview_id=$1', [lost])).n), 0, 'nada enviado');

  // duas contas, o mesmo convidado
  const [ka, la] = [await created('Kátia', 'katia@example.com'), await created('Luís', 'luis@example.com')];
  const [k, l] = [await draft(ka.ck, 'K', 'mesmo@example.com'), await draft(la.ck, 'L', 'Mesmo+x@Example.com')];
  rs = await Promise.all([sendFree(ka.ck, k), sendFree(la.ck, l)]);
  st = [await ivOf(k), await ivOf(l)];
  assert.equal(st.filter(s => s.collection_status === 'invited').length, 1, 'só uma entrevista grátis por convidado');
  assert.equal(rs.filter(r => /não está disponível para este entrevistado/.test(msgOf(r))).length, 1);

  // a última vaga do teto do dia
  const [ma, na] = [await created('Marta', 'marta@example.com'), await created('Nuno', 'nuno@example.com')];
  const [m, n] = [await draft(ma.ck, 'M', 'vaga-m@example.com'), await draft(na.ck, 'N', 'vaga-n@example.com')];
  const c = await F.freeCounts(db);
  await withLimits({ freePerDay: c.day + 1 }, async () => {
    rs = await Promise.all([sendFree(ma.ck, m), sendFree(na.ck, n)]);
  });
  st = [await ivOf(m), await ivOf(n)];
  assert.equal(st.filter(s => s.collection_status === 'invited').length, 1, 'o teto não é passado');
  assert.equal(rs.filter(r => /temporariamente indisponível/.test(msgOf(r))).length, 1);
  assert.equal((await F.freeCounts(db)).day, c.day + 1);
});

test('falha no envio do convite: a entrevista volta a rascunho, sem a marca, e a oferta fica por usar', async () => {
  const ol = await created('Olga', 'olga@example.com');
  const id = await draft(ol.ck, 'Falha', 'falha@example.com');
  await db.query(`CREATE FUNCTION falha_convite() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF starts_with(NEW.dedupe_key, 'invite:') THEN RAISE EXCEPTION 'falha simulada'; END IF; RETURN NEW; END $$`);
  await db.query(`CREATE TRIGGER falha_convite BEFORE INSERT ON emails FOR EACH ROW EXECUTE FUNCTION falha_convite()`);
  try {
    assert.equal((await sendFree(ol.ck, id)).statusCode, 500);
  } finally {
    await db.query('DROP TRIGGER falha_convite ON emails'); await db.query('DROP FUNCTION falha_convite()');
  }
  const iv = await ivOf(id);
  assert.deepEqual([iv.collection_status, iv.free_at, iv.free_guest_hash, iv.question_limit, iv.invited_at], ['draft', null, null, null, null]);
  assert.deepEqual([(await userOf(ol.id)).free_interview_at, (await userOf(ol.id)).free_interview_id, (await userOf(ol.id)).free_owner_hash], [null, null, null]);
  assert.equal(await db.one('SELECT 1 FROM invitations WHERE interview_id=$1 AND revoked_at IS NULL', [id]), undefined, 'o link criado fica revogado');
  // a seguir, o mesmo convite passa (o mesmo convidado não ficou marcado)
  assert.match(msgOf(await sendFree(ol.ck, id)), /ok=/);
  assert.ok((await ivOf(id)).free_at);
});

test('administrador, gestor de entidade, conta de entidade e subscritor: nada muda', async () => {
  const a = await draft(admin, 'Do administrador', 'adm-convidado@example.com');
  assert.doesNotMatch((await get(`/entrevistas/${a}/convidar`, admin)).body, /grátis/);
  assert.match(msgOf(await sendFree(admin, a)), /ok=Convite enviado\./, 'o administrador ignora o pedido grátis');
  assert.deepEqual([(await ivOf(a)).free_at, (await ivOf(a)).question_limit], [null, null]);
  const gestor = `sid=${cookies(await post('/entrar', { email: 'gestor@example.com', password: PW })).sid}`;
  const g = await draft(gestor, 'Do gestor', 'gestor-convidado@example.com');
  assert.doesNotMatch((await get(`/entrevistas/${g}/convidar`, gestor)).body, /grátis/);
  assert.match(msgOf(await sendFree(gestor, g)), /ok=Convite enviado\./);
  assert.deepEqual([(await ivOf(g)).free_at, (await ivOf(g)).question_limit], [null, 15]);
  // conta de uma entidade (sem subscrição): sem oferta, continua bloqueada
  const ed = `sid=${cookies(await post('/entrar', { email: 'eduarda@example.com', password: PW })).sid}`;
  const e = await draft(ed, 'Da entidade', 'ent-convidado@example.com');
  assert.doesNotMatch((await get('/painel', ed)).body, /grátis/);
  const pg = (await get(`/entrevistas/${e}/convidar`, ed)).body;
  assert.doesNotMatch(pg, /grátis/); assert.match(pg, /Precisa de uma subscrição ativa para enviar convites/);
  assert.match(msgOf(await sendFree(ed, e)), /e=Precisa de uma subscrição ativa/);
  assert.equal((await ivOf(e)).collection_status, 'draft');
  // subscritor: o pedido grátis é ignorado (convite do plano, conta para a quota)
  const su = await created('Subscritor', 'subscritor@example.com', { plan_id: 'start' });
  const s = await draft(su.ck, 'Do plano', 'plano-convidado@example.com');
  assert.doesNotMatch((await get(`/entrevistas/${s}/convidar`, su.ck)).body, /grátis/);
  assert.match(msgOf(await sendFree(su.ck, s)), /ok=Convite enviado\./);
  assert.equal((await ivOf(s)).free_at, null);
  assert.equal((await quotaFor(db, { id: su.id, role: 'interviewer' })).used, 1);
  assert.equal((await userOf(su.id)).free_interview_at, null);
});

test('administração e métricas: quem usou e quando, email confirmado; enviadas no período e conversão; «Com convite» conta as grátis', async () => {
  const list = (await get('/admin/utilizadores', admin)).body;
  assert.match(list, /fabio@example\.com<\/td>[\s\S]*?<td>usada em [^<]+<br><span class="hint">email confirmado<\/span><\/td>/);
  assert.match(list, /dora@example\.com<\/td>[\s\S]*?<td>—<br><span class="hint">email por confirmar<\/span><\/td>/);
  const fa = (await db.one(`SELECT id, free_interview_id FROM users WHERE email='fabio@example.com'`));
  const det = (await get(`/admin/utilizadores/${fa.id}`, admin)).body;
  assert.match(det, /Email confirmado em [^·]+· 1\.ª entrevista grátis: usada em [^(]+\(<a href="\/entrevistas\/[0-9a-f-]{36}">ver a entrevista<\/a>\)/);
  const dora = (await db.one(`SELECT id FROM users WHERE email='dora@example.com'`)).id;
  assert.match((await get(`/admin/utilizadores/${dora}`, admin)).body, /Email por confirmar \(último link enviado em [^)]+\)\s*· 1\.ª entrevista grátis: por usar — à espera da confirmação do email/);

  // métricas: as entrevistas grátis do período e as contas que passaram a pagar depois
  const today = M.utcDay(), P = { from: today, to: today, days: 1, preset: 'custom' as const };
  let m = await M.campaignMetrics(db, P);
  const sent = Number((await db.one('SELECT count(*)::int n FROM users WHERE free_interview_at IS NOT NULL')).n);
  assert.deepEqual(m.free, { sent, paying: 0 });
  // um pagamento antes da entrevista grátis não conta; depois, conta (uma vez por conta)
  const pay = (ref: string, userId: string, at: string, net = 1900) => db.query(`INSERT INTO invoice_queue(user_id, stripe_ref, description, net_cents, vat_cents, total_cents, paid_at) VALUES ($1,$2,'Teste',$3,0,$3,${at})`, [userId, ref, net]);
  const gil = (await db.one(`SELECT id FROM users WHERE email='gil@example.com'`)).id;
  await pay('in_antes', gil, `(SELECT free_interview_at - interval '1 minute' FROM users WHERE id='${gil}')`);
  await pay('in_depois_1', fa.id, 'now()'); await pay('in_depois_2', fa.id, 'now()');
  m = await M.campaignMetrics(db, P);
  assert.deepEqual(m.free, { sent, paying: 1 });
  const pg = (await get('/admin/metricas?p=7', admin)).body;
  assert.match(pg, new RegExp(`<p class="l">Entrevistas grátis</p><p class="v">${sent}</p><p class="s">enviadas no período; 1 dessas contas passaram a pagar \\(`));
  assert.match(pg, /«Com convite» conta também a 1\.ª entrevista grátis/);
  // «Com convite» (contas do registo no período com um convite enviado) conta também a entrevista grátis
  const before = m.totals.invited;
  const ana = `sid=${cookies(await post('/entrar', { email: 'ana@example.com', password: PW })).sid}`;
  const id = await draft(ana, 'Da Ana', 'convidado-ana@example.com');
  assert.match(msgOf(await sendFree(ana, id)), /ok=/);
  m = await M.campaignMetrics(db, P);
  assert.equal(m.totals.invited, before + 1);
  assert.equal(m.free.sent, sent + 1);
  // o CSV não muda de colunas
  assert.match((await get(`/admin/metricas.csv?p=7`, admin)).body, /^﻿Origem;Meio;Campanha;Site de referência;Visitas;Registos;Conversão \(%\);Ativados;Com convite;Pagantes;Receita sem IVA \(EUR\);Custo \(EUR\);Custo por registo \(EUR\);Custo por pagante \(EUR\);ROAS\r\n/);
});

test('textos: termos (2-C), FAQ do assistente, privacidade; o email pessoal não aparece em nada disto', async () => {
  assert.equal(TERMS_VERSION, '2026-10-23');
  const t = (await get('/termos')).body;
  assert.match(t, /<h2 id="entrevista-gratis">2-C\. 1\.ª entrevista grátis<\/h2>/);
  for (const s of ['sem pagamento nem dados de cartão', 'uma por pessoa e por organização', 'limites por entrevista do plano Start', 'pode ser alterada ou retirada a qualquer momento, sem afetar as entrevistas grátis já enviadas', 'A indisponibilidade, a alteração ou a retirada da oferta não dão direito a créditos nem a reembolsos.'])
    assert.ok(t.includes(s), s);
  // a exclusão fica só nos créditos e reembolsos da oferta (nada de uma exclusão geral de «compensações»)
  assert.ok(!t.includes('compensações'));
  // FAQ: entrada própria, encontrada em pt e en, semeada na base
  const e = FAQ_SEED.find(x => x.key === 'entrevista-gratis')!;
  assert.match(e.pt[1], /^Sim: a 1\.ª entrevista é grátis, sem pagamento nem dados de cartão/); assert.match(e.en[1], /^Yes: your first interview is free/);
  const entries = (lang: 'pt' | 'en') => FAQ_SEED.filter(x => x.audience === 'interviewer' || x.audience === 'all').map((x, i) => ({ id: x.key, lang, audience: x.audience, question: x[lang][0], answer: x[lang][1], keywords: x[lang][2], sort: i * 10 }));
  for (const [q, lang] of [['Há teste grátis?', 'pt'], ['Posso experimentar sem pagar?', 'pt'], ['Is there a free trial?', 'en'], ['Can I try it for free?', 'en']] as const)
    assert.equal(A.searchFaq(entries(lang), q)[0]?.entry.id, 'entrevista-gratis', q);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assistant_faq WHERE seed_key='entrevista-gratis'`)).n), 2);
  // privacidade: o email de confirmação e a impressão do convidado
  assert.equal(PRIVACY_UPDATED, '23 October 2026');
  const p = (await get('/privacy')).body;
  assert.match(p, /If you sign up yourself while the free first interview is offered, we email you a link to confirm your email address \(valid for 48 hours and usable once; the portal keeps only a one-way hash of it\)/);
  assert.match(p, /your account records which interview it was, when you sent it and a one-way hash of your email address in a normalised form \(for example, without a “\+” tag\), so that the same mailbox cannot use it again from another account/);
  assert.match(p, /a one-way hash of your email address, in a normalised form \(for example, without a “\+” tag\), is kept with that interview so that each person receives at most one free interview/);
  assert.match(p, /<strong>MailerSend<\/strong>[^<]*the link to confirm the email address of a new account/);

  // sentinela: nenhuma página nem email desta oferta mostra o email pessoal do dono
  await flushOutbox(db);
  const fabio = `sid=${cookies(await post('/entrar', { email: 'fabio@example.com', password: PW })).sid}`;
  const dora = `sid=${cookies(await post('/entrar', { email: 'dora@example.com', password: PW })).sid}`;
  const tk = tokenOf((await verifyMails('dora@example.com')).at(-1).text_body);
  const iv = (await db.one(`SELECT free_interview_id FROM users WHERE email='fabio@example.com'`)).free_interview_id;
  const pages = [await get('/'), await get('/registar'), await get('/termos'), await get('/privacy'), await get(`/confirmar-email/${tk}`), await post('/confirmar-email', { token: 'x' }),
    await get('/painel', dora), await get('/account', dora), await get('/painel', fabio), await get('/account', fabio), await get(`/entrevistas/${iv}`, fabio),
    await get('/admin/utilizadores', admin), await get('/admin/metricas', admin)];
  for (const r of pages) assert.ok(!r.body.includes(config.supportEmail), r.body.slice(0, 80));
  for (const mm of await db.query(`SELECT html, text_body FROM emails WHERE starts_with(dedupe_key, 'verify:') OR interview_id IN (SELECT id FROM interviews WHERE free_at IS NOT NULL)`))
    assert.ok(!mm.html.includes(config.supportEmail) && !mm.text_body.includes(config.supportEmail));
});

// Os testes seguintes enviam mais entrevistas grátis do que o teto por omissão do dia (10): correm com tetos altos.
const manyFree = (fn: () => Promise<void>) => withLimits({ freePerDay: 1000, freePerMonth: 1000 }, fn);

test('corrida «Guardar»/envio grátis: o convite sai sempre para o convidado gravado com a marca (db.tx envolvido, como no script do revisor)', () => manyFree(async () => {
  // Todos os convites da entrevista foram para o convidado gravado, e a impressão é a dele.
  const consistent = async (id: string) => {
    const iv = await db.one('SELECT guest_email, free_at, free_guest_hash FROM interviews WHERE id=$1', [id]);
    const to = (await db.query(`SELECT to_email FROM emails WHERE interview_id=$1 AND starts_with(dedupe_key, 'invite:')`, [id])).map((m: any) => m.to_email);
    if (iv.free_at) assert.equal(iv.free_guest_hash, F.guestHash(iv.guest_email), 'a impressão é a do convidado gravado');
    for (const t of to) assert.equal(t, iv.guest_email, 'o convite saiu para o convidado gravado');
    return { iv, to };
  };
  /** Corre `fn` com um «Guardar» de outro email a cair entre a leitura do POST e o claimFree (o primeiro db.tx do pedido). */
  const between = async (id: string, guestEmail: string, fn: () => Promise<any>) => {
    const orig = db.tx;
    let once = true;
    db.tx = async (f: any) => {
      if (once) { once = false; await db.query(`UPDATE interviews SET guest_email=$2 WHERE id=$1 AND collection_status='draft'`, [id, guestEmail]); }
      return orig.call(db, f);
    };
    try { return await fn(); } finally { db.tx = orig; }
  };
  const pa = await created('Paula', 'paula@example.com');
  const pd = await draft(pa.ck, 'Primeira', 'alvo2@example.net');
  assert.match(msgOf(await sendFree(pa.ck, pd)), /ok=/);
  // outra conta com o mesmo convidado (que já recebeu uma); o «Guardar» troca-o por outro entre a leitura e o bloqueio
  const qu = await created('Quim', 'quim@example.com');
  const qd = await draft(qu.ck, 'Isco', 'alvo2@example.net');
  assert.match(msgOf(await between(qd, 'isco-j@example.net', () => sendFree(qu.ck, qd))), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  const { iv, to } = await consistent(qd);
  assert.deepEqual([iv.guest_email, to], ['isco-j@example.net', ['isco-j@example.net']], 'o email vai para o convidado da marca');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM emails WHERE to_email='alvo2@example.net' AND starts_with(dedupe_key, 'invite:')`)).n), 1, 'alvo2 só recebeu a primeira');
  await consistent(pd);
  // ao contrário (um convidado novo trocado por um que já recebeu): recusado, nada enviado
  const ro = await created('Rosa', 'rosa@example.com');
  const rd = await draft(ro.ck, 'Troca', 'novo-r@example.net');
  assert.match(msgOf(await between(rd, 'alvo2@example.net', () => sendFree(ro.ck, rd))), /e=A entrevista grátis não está disponível para este entrevistado/);
  assert.deepEqual([(await ivOf(rd)).collection_status, (await consistent(rd)).to], ['draft', []]);
  // o «Guardar» tira o email do convidado pelo meio: a entrevista gravada não está pronta, nada sai e a oferta fica por usar
  const sd = await draft(ro.ck, 'Sem email', 'sem-r@example.net');
  assert.equal((await between(sd, '', () => sendFree(ro.ck, sd))).headers.location, `/entrevistas/${sd}/convidar`);
  const [s, u] = [await ivOf(sd), await userOf(ro.id)];
  assert.deepEqual([s.collection_status, s.free_at, s.free_guest_hash, u.free_interview_at, u.free_owner_hash], ['draft', null, null, null, null]);
  assert.equal(await db.one('SELECT 1 FROM invitations WHERE interview_id=$1', [sd]), undefined);
}));

test('«Guardar» que leu a entrevista antes do convite grátis: o título, o objetivo, o convidado e a aprovação ficam os do convite, e «Reenviar» vai para ele', () => manyFree(async () => {
  const su = await created('Sara', 'sara@example.com');
  const id = await draft(su.ck, 'Antes', 'antes-s@example.net');
  // o UPDATE do «Guardar» só corre depois de o convite grátis ter saído (quando o «Guardar» leu a entrevista, era um rascunho)
  const orig = db.one;
  let once = true, sent: any;
  db.one = async (sql: string, params?: any[]) => {
    if (once && /^\s*UPDATE interviews SET title=/.test(sql)) { once = false; sent = await sendFree(su.ck, id); }
    return orig.call(db, sql, params);
  };
  try {
    await post(`/entrevistas/${id}/guardar`, { title: 'Depois', objective_text: 'Outro objetivo', host_name: 'Host', guest_name: 'Convidado', guest_email: 'depois-s@example.net', interaction_lang: 'en', review_policy: 'host_only', subtitle_langs: 'en' }, su.ck);
  } finally { db.one = orig; }
  assert.ok(!once, 'o «Guardar» chegou ao UPDATE');
  assert.match(msgOf(sent), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  const iv = await db.one('SELECT title, objective_text, guest_email, review_policy, free_guest_hash FROM interviews WHERE id=$1', [id]);
  assert.deepEqual([iv.title, iv.objective_text, iv.guest_email, iv.review_policy], ['Antes', 'Objetivo', 'antes-s@example.net', 'guest_preview']);
  assert.equal(iv.free_guest_hash, F.guestHash('antes-s@example.net'));
  // «Reenviar»: o link novo vai para o convidado da marca
  assert.match(msgOf(await post(`/entrevistas/${id}/reenviar`, {}, su.ck)), /ok=Novo convite enviado/);
  const to = (await db.query(`SELECT to_email FROM emails WHERE interview_id=$1 AND starts_with(dedupe_key, 'invite:')`, [id])).map((m: any) => m.to_email);
  assert.deepEqual(to, ['antes-s@example.net', 'antes-s@example.net']);
  // depois do convite, um «Guardar» normal também não os muda (o resto, como antes, muda)
  await post(`/entrevistas/${id}/guardar`, { title: 'Outra', objective_text: 'X', host_name: 'Host 2', guest_name: 'Convidado', guest_email: 'outro-s@example.net', review_policy: 'host_only', subtitle_langs: 'en' }, su.ck);
  const iv2 = await db.one('SELECT title, objective_text, guest_email, host_name, review_policy FROM interviews WHERE id=$1', [id]);
  assert.deepEqual([iv2.title, iv2.objective_text, iv2.guest_email, iv2.host_name, iv2.review_policy], ['Antes', 'Objetivo', 'antes-s@example.net', 'Host 2', 'guest_preview']);
  // num rascunho, o «Guardar» muda-os, e um título vazio mantém o anterior
  const d = await draft(su.ck, 'Rascunho', 'r-s@example.net');
  await post(`/entrevistas/${d}/guardar`, { title: ' ', objective_text: 'Novo', host_name: 'Host', guest_name: 'Convidado', guest_email: 'Novo-S@Example.net', review_policy: 'host_only', subtitle_langs: 'en' }, su.ck);
  const d2 = await db.one('SELECT title, objective_text, guest_email, review_policy FROM interviews WHERE id=$1', [d]);
  assert.deepEqual([d2.title, d2.objective_text, d2.guest_email, d2.review_policy], ['Rascunho', 'Novo', 'novo-s@example.net', 'host_only']);
}));

test('página do convite com o email por confirmar: o aviso com «Reenviar», sem «Precisa de uma subscrição ativa» nem «Uso neste período»', () => manyFree(async () => {
  const ve = await register('Vera', 'vera@example.com');
  const id = await draft(ve.ck, 'Por confirmar', 'vera-convidado@example.com');
  const pg = (await get(`/entrevistas/${id}/convidar`, ve.ck)).body;
  assert.match(pg, /<strong>A sua 1\.ª entrevista é grátis<\/strong>, depois de confirmar o email da sua conta\./);
  assert.match(pg, new RegExp(`<form method="post" action="/confirmar-email/reenviar"[^>]*><input type="hidden" name="voltar" value="/entrevistas/${id}/convidar"><button[^>]*>Reenviar</button>`));
  assert.match(pg, /<li>Confirme o email da sua conta para enviar a 1\.ª entrevista grátis, ou escolha um plano em Conta\.<\/li>/);
  assert.doesNotMatch(pg, /Precisa de uma subscrição ativa|Uso neste período/);
  assert.match(pg, /<button class="accent" disabled>Enviar convite<\/button>/);
  // confirmado o email, a mesma página oferece o envio grátis
  await post('/confirmar-email', { token: tokenOf((await verifyMails('vera@example.com'))[0].text_body) });
  const ok = (await get(`/entrevistas/${id}/convidar`, ve.ck)).body;
  assert.match(ok, /Enviar convite grátis/); assert.doesNotMatch(ok, /Confirme o email|Precisa de uma subscrição ativa|Uso neste período/);
  // uma conta de entidade sem subscrição continua com o aviso da subscrição (sem o «0/0»)
  const ed = `sid=${cookies(await post('/entrar', { email: 'eduarda@example.com', password: PW })).sid}`;
  const e = await draft(ed, 'Da entidade 2', 'ent2-convidado@example.com');
  const pe = (await get(`/entrevistas/${e}/convidar`, ed)).body;
  assert.match(pe, /Precisa de uma subscrição ativa para enviar convites/); assert.doesNotMatch(pe, /Uso neste período|Confirme o email/);
}));

test('uma por caixa de correio: eve+1@gmail.com usa-a; eve+2, e.v.e@gmail.com e eve@googlemail.com já não; a quem não confirmou, nada se diz', () => manyFree(async () => {
  assert.equal(F.ownerHash('E.V.E+x@GoogleMail.com'), F.ownerHash('eve@gmail.com'));
  assert.notEqual(F.ownerHash('e.v.e@example.org'), F.ownerHash('eve@example.org'), 'noutros domínios os pontos contam');
  const e1 = await created('Eve 1', 'eve+1@gmail.com');
  const d1 = await draft(e1.ck, 'Eve 1', 'eve-g1@example.net');
  assert.match(msgOf(await sendFree(e1.ck, d1)), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  assert.equal((await userOf(e1.id)).free_owner_hash, sha('free-owner:eve@gmail.com'));
  for (const [i, email] of ['eve+2@gmail.com', 'e.v.e@gmail.com', 'eve@googlemail.com', 'eve+promo@gmail.com'].entries()) {
    const a = await created(`Eve ${i + 2}`, email);
    assert.equal((await F.freeInterviewFor(db, { id: a.id })).reason, 'used', email);
    assert.match((await get('/painel', a.ck)).body, /Já usou a sua entrevista grátis\. Para enviar mais convites, escolha um plano/, email);
    const d = await draft(a.ck, `Eve ${i + 2}`, `eve-g${i + 2}@example.net`);
    assert.doesNotMatch((await get(`/entrevistas/${d}/convidar`, a.ck)).body, /Enviar convite grátis/, email);
    assert.match(msgOf(await sendFree(a.ck, d)), /e=Já usou a sua entrevista grátis/, email);
    assert.deepEqual([(await ivOf(d)).collection_status, (await userOf(a.id)).free_interview_at], ['draft', null], email);
  }
  const e2 = (await db.one(`SELECT id FROM users WHERE email='eve+2@gmail.com'`)).id;
  assert.match((await get(`/admin/utilizadores/${e2}`, admin)).body, /1\.ª entrevista grátis: por usar — já usada por outra conta com o mesmo email \(normalizado\)/);
  // o índice único é a última defesa
  await assert.rejects(db.query(`UPDATE users SET free_interview_at=now(), free_owner_hash=$2 WHERE id=$1`, [e2, sha('free-owner:eve@gmail.com')]));
  // conta da mesma caixa ainda por confirmar: o aviso é o da confirmação (nada se diz sobre a caixa a quem não provou que é dela)
  const e9 = await register('Eve 9', 'eve+9@gmail.com');
  assert.equal((await F.freeInterviewFor(db, { id: e9.id })).reason, 'unverified');
  const p9 = (await get('/painel', e9.ck)).body;
  assert.match(p9, /depois de confirmar o email da sua conta/); assert.doesNotMatch(p9, /Já usou/);
  // outra caixa (outro domínio, com pontos): passa
  const o = await created('Eve Outra', 'e.v.e@example.org');
  assert.match(msgOf(await sendFree(o.ck, await draft(o.ck, 'Outra caixa', 'eve-outra@example.net'))), /ok=/);
  // duas contas da mesma caixa em simultâneo: só uma
  const [x1, x2] = [await created('Xana', 'xana.silva@gmail.com'), await created('Xana 2', 'xanasilva+2@gmail.com')];
  const [y1, y2] = [await draft(x1.ck, 'X1', 'xg1@example.net'), await draft(x2.ck, 'X2', 'xg2@example.net')];
  const rs = await Promise.all([sendFree(x1.ck, y1), sendFree(x2.ck, y2)]);
  assert.equal([await ivOf(y1), await ivOf(y2)].filter(s => s.free_at).length, 1, 'uma por caixa, também em simultâneo');
  assert.equal(rs.filter(r => /Já usou a sua entrevista grátis/.test(msgOf(r))).length, 1);
}));
