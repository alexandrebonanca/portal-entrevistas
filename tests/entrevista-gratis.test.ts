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
const { VERIFY_PER_DAY, VERIFY_TOTAL, mailboxHash } = await import('../src/email-verify.ts');
const { runOne, PermanentError, enqueue } = await import('../src/jobs.ts');
const { handlers } = await import('../src/pipeline.ts');
const { regenerationsUsed, SCRIPT_SEGMENT_MAX, FREE_SCRIPT_BASE, FREE_SCRIPT_PER_MIN, FREE_TRANSCRIPT_BASE, FREE_TRANSCRIPT_PER_MIN } = await import('../src/limits.ts');
const { validateScript, REVIEW_MAX_TOKENS, translateSubtitleCues, subtitleMaxTokens, scriptMaxTokens, coverMaxTokens, newMeter, UNTRANSLATED, TEXT_MODEL_MAX_OUT } = await import('../src/ai/openai.ts');
const { makeToneWav, saveAsset } = await import('../src/media.ts');
const { PUBLIC_SIGNUPS_PER_IP_DAY } = await import('../src/routes/site.ts');
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
  assert.equal(r.headers.location, '/painel?gok=Email%20confirmado.#gratis');
  assert.ok((await userOf(carla.id)).email_verified_at);
});

test('«Reenviar»: link novo (o anterior continua válido), 3 em 24 horas com o do registo, volta só a páginas do portal; teto global dos emails de confirmação', async () => {
  const bia = { ck: `sid=${cookies(await post('/entrar', { email: 'bia@example.com', password: PW })).sid}`, id: (await db.one(`SELECT id FROM users WHERE email='bia@example.com'`)).id };
  const painel = (await get('/painel', bia.ck)).body;
  assert.match(painel, /<strong>A sua 1\.ª entrevista é grátis<\/strong>, depois de confirmar o email da sua conta\. Enviámos uma ligação para bia@example\.com/);
  assert.match(painel, /<form method="post" action="\/confirmar-email\/reenviar"[^>]*><input type="hidden" name="voltar" value="\/painel"><button[^>]*>Reenviar<\/button>/);
  let r = await post('/confirmar-email/reenviar', { voltar: '/painel' }, bia.ck);
  assert.match(msgOf(r), /^\/painel\?gok=Enviámos uma ligação nova para bia@example\.com\.#gratis$/);
  assert.equal((await verifyMails('bia@example.com')).length, 2);
  // a página de origem: só as do portal (outra qualquer volta ao painel)
  r = await post('/confirmar-email/reenviar', { voltar: 'https://evil.example/x' }, bia.ck);
  assert.match(msgOf(r), /^\/painel\?gok=/);
  assert.equal((await verifyMails('bia@example.com')).length, VERIFY_PER_DAY);
  // 3 emails em 24 horas, o do registo incluído: o pedido seguinte não envia (na Conta, em inglês, a mensagem em inglês)
  r = await post('/confirmar-email/reenviar', { voltar: '/account' }, bia.ck);
  assert.match(msgOf(r), /^\/account\?ge=We have sent 3 confirmation emails to this account’s email address in the last 24 hours\. Look for them in your inbox \(and spam folder\) or ask for another one later\.#gratis$/);
  r = await post('/confirmar-email/reenviar', { voltar: '/painel' }, bia.ck);
  assert.match(msgOf(r), /ge=Já enviámos 3 emails de confirmação para o email desta conta nas últimas 24 horas\. Procure-os na sua caixa de correio \(também no spam\) ou peça outro mais tarde\./);
  assert.equal((await verifyMails('bia@example.com')).length, 3, 'o 4.º pedido em 24 horas não envia');
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
  assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, carla)), /gok=O seu email já está confirmado/);

  // teto global (contado na fila de emails): acima dele, a conta fica criada sem email e o painel deixa pedir outro
  const n = Number((await db.one(`SELECT count(*)::int n FROM emails WHERE starts_with(dedupe_key, 'verify:')`)).n);
  await withLimits({ verifyEmailsPerHour: n }, async () => {
    const dora = await register('Dora', 'dora@example.com');
    assert.equal((await verifyMails('dora@example.com')).length, 0);
    assert.equal((await db.one(`SELECT meta FROM audit_events WHERE action='signup' AND actor='dora@example.com'`)).meta.emailVerification, 'cap');
    assert.match((await get('/painel', dora.ck)).body, /Ainda não foi possível enviar a ligação para dora@example\.com: carregue em «Reenviar»/);
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, dora.ck)), /ge=Não foi possível enviar o email agora/);
  });
  await withLimits({ verifyEmailsPerDay: 0 }, async () => {
    const dora = `sid=${cookies(await post('/entrar', { email: 'dora@example.com', password: PW })).sid}`;
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, dora)), /ge=Não foi possível enviar/, '0 desliga os emails de confirmação');
  });
  const dora = `sid=${cookies(await post('/entrar', { email: 'dora@example.com', password: PW })).sid}`;
  assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, dora)), /gok=Enviámos uma ligação nova/);
  assert.equal((await verifyMails('dora@example.com')).length, 1);
});

test('«Reenviar» do email de confirmação: total por conta contado na base (3 em 24 horas e 5 ao todo), com o relógio adiantado; acima dele, nada sai e o teto global não se gasta', async () => {
  // Uma conta registada com o email de outra pessoa carrega em «Reenviar» 4 vezes por hora durante 3 dias (com o relógio
  // adiantado: o do processo, que conta os pedidos em memória, e, no PGlite, o da base): no máximo 3 emails em cada 24
  // horas, o do registo incluído, e 5 ao todo (antes, 1 + 3 por hora, sem fim).
  const vi = await register('Vítima', 'vitima.verif@victim.example');
  const realNow = Date.now;
  let t = realNow(), ok = 0;
  Date.now = () => t;
  try {
    for (let h = 1; h <= 72; h++) {
      t += 3600_000 + 5000;
      for (let k = 0; k < 4; k++) if (/[?]gok=/.test(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, vi.ck)))) ok++;
    }
  } finally { Date.now = realNow; }
  const at = (await verifyMails('vitima.verif@victim.example')).map((m: any) => new Date(m.created_at).getTime());
  assert.deepEqual([at.length, ok], [VERIFY_TOTAL, VERIFY_TOTAL - 1]);
  for (const a of at) assert.ok(at.filter(b => b >= a && b - a < 86400_000).length <= VERIFY_PER_DAY, 'no máximo 3 em cada 24 horas');

  // O tempo da base: 24 horas depois, mais dois, até ao total de 5; acima dele, nem dias depois.
  const wa = await register('Wanda', 'wanda@example.com');
  const allVerify = async () => Number((await db.one(`SELECT count(*)::int n FROM emails WHERE starts_with(dedupe_key, 'verify:')`)).n);
  const again = (voltar = '/painel') => post('/confirmar-email/reenviar', { voltar }, wa.ck);
  for (let i = 1; i < VERIFY_PER_DAY; i++) assert.match(msgOf(await again()), /[?]gok=Enviámos uma ligação nova/);
  let before = await allVerify();
  assert.match(msgOf(await again()), /ge=Já enviámos 3 emails de confirmação para o email desta conta nas últimas 24 horas/);
  assert.equal(await allVerify(), before, 'a recusa não põe nada na fila (o teto global fica como estava)');
  await db.query(`UPDATE email_verifications SET created_at = created_at - interval '25 hours' WHERE user_id=$1`, [wa.id]);
  for (let i = VERIFY_PER_DAY; i < VERIFY_TOTAL; i++) assert.match(msgOf(await again()), /[?]gok=Enviámos uma ligação nova/);
  assert.equal((await verifyMails('wanda@example.com')).length, VERIFY_TOTAL);
  await db.query(`UPDATE email_verifications SET created_at = created_at - interval '30 days' WHERE user_id=$1`, [wa.id]);
  before = await allVerify();
  assert.match(msgOf(await again()), /ge=Já enviámos para o email desta conta o número máximo de emails de confirmação \(5\): não é possível pedir outro\. Procure-os na sua caixa de correio \(também no spam\)\./);
  assert.match(msgOf(await again('/account')), /^\/account\?ge=We have already sent the maximum number of confirmation emails \(5\) to this account’s email address, so no more can be requested\./);
  assert.equal(await allVerify(), before);
  assert.equal((await verifyMails('wanda@example.com')).length, VERIFY_TOTAL);
  // o painel e a Conta já não mostram «Reenviar»
  const painel = (await get('/painel', wa.ck)).body;
  assert.match(painel, /Já enviámos para o email desta conta o número máximo de ligações de confirmação \(5\): não é possível pedir outra\./);
  assert.doesNotMatch(painel, /action="\/confirmar-email\/reenviar"/);
  const conta = (await get('/account', wa.ck)).body;
  assert.match(conta, /We have already sent the maximum number of confirmation links \(5\) to this account’s email address, so no more can be requested\./);
  assert.doesNotMatch(conta, /action="\/confirmar-email\/reenviar"/);
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
  // 7.ª revisão: o total de trabalhos de produção, com a ligação ao ponto 2-C, onde a oferta se pede (antes, só nos termos e na FAQ)
  const JOBS_PT = 'e até 8 trabalhos de produção e 3 gerações do vídeo com fotografias (contam os que falham e cada «Tentar de novo»; ver os <a href="/termos#entrevista-gratis">termos</a>). É uma por pessoa e por organização';
  assert.ok(painel.includes(`10:00 min de respostas do entrevistado) ${JOBS_PT}: crie a entrevista`), 'painel');
  const conta = (await get('/account', fa.ck)).body;
  assert.match(conta, /<strong>Your first interview is free\.<\/strong> Send your first invitation with no payment and no card details, with the Start plan limits \(up to 4 questions/);
  assert.ok(conta.includes('10:00 min of answers) and up to 8 production jobs and 3 generations of the video with photos (failed ones and each «Tentar de novo», Try again, count; see the <a href="/termos#entrevista-gratis">terms</a>): create it on the dashboard'), 'Conta');

  const id = await draft(fa.ck, 'A grátis', 'Joao.Silva+x@gmail.com');
  const pg = (await get(`/entrevistas/${id}/convidar`, fa.ck)).body;
  assert.match(pg, /Este convite segue sem pagamento nem dados de cartão/);
  assert.ok(pg.includes(`10:00 min de respostas do entrevistado) ${JOBS_PT}.</div>`), 'caixa do convite');
  assert.match(pg, /<input type="hidden" name="free" value="1"><button class="accent" >Enviar convite grátis<\/button>/);
  assert.match(pg, /até 4 perguntas, incluindo as adicionais; até 10:00 min de respostas do entrevistado no total/);
  assert.ok(pg.includes('; máximo de 5:00 min por resposta; até 8 trabalhos de produção e 3 gerações do vídeo com fotografias (contam os que falham e cada «Tentar de novo»; ver os <a href="/termos#entrevista-gratis">termos</a>). Ficam fixos com o convite.'), 'linha dos limites');
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
  // 7.ª revisão: o total de trabalhos de produção e a ligação ao ponto 2-C dos termos
  assert.ok(home.includes('and the same production as the plans (transcription, English script, narration, subtitles, cover and the video with photos), within a total of 8 production jobs: processing, regenerating the script and generating the episode, counting failed jobs and each «Try again», and up to 3 generations of the video with photos. One per person'));
  assert.match(home, /One per person and organisation, and each guest can receive only one free interview\. A limited number of free interviews is available each day and each month; when they run out, the offer is temporarily unavailable\. The offer can be withdrawn at any time \(see the <a href="\/termos#entrevista-gratis">terms<\/a>\)/);
  assert.match(home, /<a class="btn accent" href="\/registar">Send your first interview free<\/a>/);
  assert.match(home, /VAT, where it applies, depends on your country; the final price is always shown before you pay\./);
  assert.match(home, /Start from €19 \/ month/);
  // com a oferta ligada, o assistente fala dela: a entrada própria e a frase de «Como envio o convite?»
  const OFFER = /1\.ª entrevista é grátis|primeira entrevista pode ser grátis|first interview is free|first interview can be free/;
  const sendFaq = (all: any[]) => A.fillVars(all.find(e => /^(Como envio o convite|How do I send the invitation)/.test(e.question))!.answer);
  for (const lang of ['pt', 'en'] as const) {
    const all = await A.activeFaq(db, lang, 'interviewer');
    assert.ok(all.some(e => /^(Sim: a 1\.ª entrevista é grátis|Yes: your first interview is free)/.test(e.answer)), lang);
    assert.match(sendFaq(all), OFFER, lang);
  }
  const asked = await A.answerQuestion(db, { question: 'Há teste grátis?', pageLang: 'pt', audience: 'interviewer' });
  assert.match((await A.loadAnswer(db, asked))!.entries[0].answer, /^Sim: a 1\.ª entrevista é grátis/);
  assert.match((await get('/ajuda', ia.ck)).body, /Há teste grátis\?/);
  // blocos condicionais da base: só com a condição; uma desconhecida fica como está
  assert.equal(A.fillVars('a.{?freeOffer} b.{/freeOffer} c.{?outra} d.{/outra}'), 'a. b. c.{?outra} d.{/outra}');
  // 0 desliga: nada na landing, no registo, no painel, na Conta nem na página do convite; o envio grátis é recusado
  await withLimits({ freePerMonth: 0 }, async () => {
    // nem no assistente: a entrada «Há teste grátis?» sai da pesquisa, da lista e das respostas já dadas, e «Como envio o
    // convite?» deixa de a referir
    assert.equal(A.fillVars('a.{?freeOffer} b.{/freeOffer} c.'), 'a. c.');
    for (const [lang, q] of [['pt', 'Há teste grátis?'], ['pt', 'Posso experimentar sem pagar?'], ['en', 'Is there a free trial?'], ['en', 'Can I try it for free?']] as const) {
      const all = await A.activeFaq(db, lang, 'interviewer');
      assert.ok(!all.some(e => /^(Sim: a 1\.ª entrevista é grátis|Yes: your first interview is free)/.test(e.answer)), lang);
      assert.ok(!A.searchFaq(all, q).some(h => OFFER.test(A.fillVars(h.entry.answer))), q);
      assert.doesNotMatch(sendFaq(all), /grátis|free|freeOffer/, lang);
    }
    assert.ok(!(await A.loadAnswer(db, asked))!.entries.some(e => /^Sim: a 1\.ª entrevista é grátis/.test(e.answer)), 'nem na resposta já dada');
    const ajuda = (await get('/ajuda', ia.ck)).body;
    assert.doesNotMatch(ajuda, /Há teste grátis/); assert.doesNotMatch(ajuda, OFFER);
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
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, off.ck)), /ge=A 1\.ª entrevista grátis não está disponível neste momento: não é preciso confirmar o email\./);
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/account' }, off.ck)), /ge=The free first interview is not offered at the moment/);
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
  assert.doesNotMatch((await get(`/entrevistas/${s}/convidar`, su.ck)).body, /grátis|trabalhos de produção/);
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
  assert.equal(TERMS_VERSION, '2026-10-24');
  const t = (await get('/termos')).body;
  assert.match(t, /<h2 id="entrevista-gratis">2-C\. 1\.ª entrevista grátis<\/h2>/);
  for (const s of ['sem pagamento nem dados de cartão', 'uma por pessoa e por organização', 'limites por entrevista do plano Start', 'pode ser alterada ou retirada a qualquer momento, sem afetar as entrevistas grátis já enviadas', 'A indisponibilidade, a alteração ou a retirada da oferta não dão direito a créditos nem a reembolsos.',
    // 6.ª revisão: o total de trabalhos de produção, escrito (antes, «as regenerações incluídas como num plano», sem ele)
    `dentro de um total de ${F.FREE_PRODUCTION_JOBS} trabalhos de produção (processar a entrevista, regenerar o guião e gerar o episódio): contam também os que falham, por qualquer motivo, e cada «Tentar de novo».`,
    // 7.ª revisão: um guião novo precisa de 2 por usar (o último só serve para gerar o episódio); antes, os termos prometiam as
    // regenerações incluídas dentro do total, mas a 7 de 8 nada fazia um guião novo, mesmo com regenerações por usar
    `Um guião novo (processar a entrevista, regenerar o guião, recomeçar a produção ou rever uma transcrição) precisa de ${F.FREE_JOBS_FOR_SCRIPT} desses trabalhos por usar, o dele e o do episódio, e um pedido adicional, depois do primeiro guião, também (a resposta do entrevistado obriga a refazer o guião e o episódio): o último trabalho só serve para gerar o episódio de um guião aprovado. Acima desse total, essa entrevista não tem mais regenerações, nem pagas com créditos`])
    assert.ok(t.includes(s), s);
  // a exclusão fica só nos créditos e reembolsos da oferta (nada de uma exclusão geral de «compensações»)
  assert.ok(!t.includes('compensações'));
  // FAQ: entrada própria, encontrada em pt e en, semeada na base
  const e = FAQ_SEED.find(x => x.key === 'entrevista-gratis')!;
  assert.match(e.pt[1], /^Sim: a 1\.ª entrevista é grátis, sem pagamento nem dados de cartão/); assert.match(e.en[1], /^Yes: your first interview is free/);
  // o total de emails de confirmação por conta, com os valores em vigor
  assert.match(A.fillVars(e.pt[1]), /carregue em «Reenviar» no Painel: até 3 emails em 24 horas e 5 ao todo\)/);
  assert.match(A.fillVars(e.en[1]), /on the dashboard: up to 3 emails in 24 hours and 5 in all\)/);
  // o total de trabalhos de produção (contam os que falham e cada «Tentar de novo»; acima dele, nem pagas) e a saída pela Ajuda
  assert.match(A.fillVars(e.pt[1]), /dentro de um total de 8 trabalhos de produção \(processar, regenerar o guião e gerar o episódio\): contam também os que falham, por qualquer motivo, e cada «Tentar de novo», e acima deles essa entrevista não tem mais regenerações, nem pagas com créditos\. [^]*A página da produção mostra quantos restam; se uma falha do serviço os gastar, peça ajuda à equipa em «Ajuda», que pode terminar a produção\./);
  assert.match(A.fillVars(e.en[1]), /within a total of 8 production jobs \(processing, regenerating the script and generating the episode\): jobs that fail, for any reason, and each «Tentar de novo» \(Try again\) also count, and beyond them that interview has no more regenerations, not even paid with credits\. [^]*The production page shows how many are left; if a service failure uses them up, ask the team for help in «Ajuda» \(Help\), who can finish the production\./);
  assert.doesNotMatch(e.pt[1] + e.en[1], /incluídas como num plano;|included as in a plan;/);
  // 7.ª revisão: um guião novo precisa de 2 trabalhos por usar, e o pedido adicional também
  assert.ok(A.fillVars(e.pt[1]).includes('nem pagas com créditos. Um guião novo (processar, regenerar o guião, recomeçar ou rever uma transcrição) precisa de 2 desses trabalhos por usar, o dele e o do episódio, e um pedido adicional, depois do primeiro guião, também (a resposta do entrevistado obriga a refazer o guião e o episódio): o último trabalho só serve para gerar o episódio de um guião aprovado. O vídeo com fotografias fica fora desse total, mas pode ser gerado até 3 vezes (contam também as que falham). A página da produção mostra quantos restam;'));
  assert.ok(A.fillVars(e.en[1]).includes('not even paid with credits. A new script (processing, regenerating the script, restarting or revising a transcript) needs 2 of those jobs left, its own and the episode\'s, and so does an additional question once there is a script (the guest\'s answer means redoing the script and the episode): the last job only serves to generate the episode of an approved script. The video with photos is outside that total, but it can be generated up to 3 times (failed ones also count). The production page shows how many are left;'));
  const rg = FAQ_SEED.find(x => x.key === 'regeneracoes')!;
  assert.match(A.fillVars(rg.pt[1]), /Na 1\.ª entrevista grátis há também um total de 8 trabalhos de produção, em que contam os que falham, e acima dele não há mais regenerações, nem pagas/);
  assert.ok(A.fillVars(rg.pt[1]).includes('nem pagas; um guião novo precisa de 2 desses trabalhos por usar (o dele e o do episódio), por isso o último só serve para gerar o episódio, mesmo com regenerações por usar (ver «Há teste grátis?»).'));
  assert.ok(A.fillVars(rg.en[1]).includes('not even paid; a new script needs 2 of those jobs left (its own and the episode\'s), so the last one only serves to generate the episode, even with regenerations left (see «Is there a free trial?»).'));
  // e a frase só aparece com a oferta ligada (bloco {?freeOffer})
  await withLimits({ freePerMonth: 0 }, async () => assert.doesNotMatch(A.fillVars(rg.pt[1]) + A.fillVars(rg.en[1]), /guião novo precisa|new script needs/));
  const fu = FAQ_SEED.find(x => x.key === 'pergunta-adicional')!;
  assert.ok(A.fillVars(fu.pt[1]).endsWith('Na 1.ª entrevista grátis, também não é possível depois de o entrevistado recusar o convite nem, quando já há um guião, com menos de 2 trabalhos de produção por usar (a resposta obriga a refazer o guião e o episódio).'));
  assert.ok(A.fillVars(fu.en[1]).endsWith('In the free first interview, it is also not possible after the guest declines the invitation, nor, once there is a script, with fewer than 2 production jobs left (the answer means redoing the script and the episode).'));
  assert.ok(A.FAQ_VAR_HELP.freeJobsScript);
  const entries = (lang: 'pt' | 'en') => FAQ_SEED.filter(x => x.audience === 'interviewer' || x.audience === 'all').map((x, i) => ({ id: x.key, lang, audience: x.audience, question: x[lang][0], answer: x[lang][1], keywords: x[lang][2], sort: i * 10 }));
  for (const [q, lang] of [['Há teste grátis?', 'pt'], ['Posso experimentar sem pagar?', 'pt'], ['Is there a free trial?', 'en'], ['Can I try it for free?', 'en']] as const)
    assert.equal(A.searchFaq(entries(lang), q)[0]?.entry.id, 'entrevista-gratis', q);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assistant_faq WHERE seed_key='entrevista-gratis'`)).n), 2);
  // privacidade: o email de confirmação e a impressão do convidado
  assert.equal(PRIVACY_UPDATED, '24 October 2026');
  const p = (await get('/privacy')).body;
  assert.match(p, /If you sign up yourself while the free first interview is offered, we email you a link to confirm your email address \(valid for 48 hours and usable once; apart from our copy of that email, the portal keeps only a one-way hash of the link’s code\)/);
  assert.doesNotMatch(p, /the portal keeps only a one-way hash of it\)/, 'a cópia do email (tabela emails) guarda o link completo');
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
  // depois do convite, um «Guardar» normal também não os muda, nem (na entrevista grátis) o nome do entrevistador; o resto, como antes, muda
  await post(`/entrevistas/${id}/guardar`, { title: 'Outra', objective_text: 'X', host_name: 'Host 2', guest_name: 'Convidado 2', guest_email: 'outro-s@example.net', review_policy: 'host_only', subtitle_langs: 'en' }, su.ck);
  const iv2 = await db.one('SELECT title, objective_text, guest_email, host_name, guest_name, review_policy FROM interviews WHERE id=$1', [id]);
  assert.deepEqual([iv2.title, iv2.objective_text, iv2.guest_email, iv2.host_name, iv2.guest_name, iv2.review_policy], ['Antes', 'Objetivo', 'antes-s@example.net', 'Host', 'Convidado 2', 'guest_preview']);
  // num rascunho, o «Guardar» muda-os, e um título vazio mantém o anterior
  const d = await draft(su.ck, 'Rascunho', 'r-s@example.net');
  await post(`/entrevistas/${d}/guardar`, { title: ' ', objective_text: 'Novo', host_name: 'Host', guest_name: 'Convidado', guest_email: 'Novo-S@Example.net', review_policy: 'host_only', subtitle_langs: 'en' }, su.ck);
  const d2 = await db.one('SELECT title, objective_text, guest_email, review_policy FROM interviews WHERE id=$1', [d]);
  assert.deepEqual([d2.title, d2.objective_text, d2.guest_email, d2.review_policy], ['Rascunho', 'Novo', 'novo-s@example.net', 'host_only']);
}));

test('«Reenviar convite» na entrevista grátis: nada depois da recusa (nem perguntas adicionais), no máximo 3 reenvios (também em simultâneo), nome e mensagem como no convite; as pagas como antes', () => manyFree(async () => {
  const realNow = Date.now;
  const inviteMails = (to: string) => db.query(`SELECT subject, text_body FROM emails WHERE to_email=$1 AND starts_with(dedupe_key, 'invite:') ORDER BY created_at, id`, [to]);
  const save = (ck: string, id: string, o: Record<string, string>) => post(`/entrevistas/${id}/guardar`, { title: 'T', objective_text: 'Objetivo', host_name: 'Host', guest_name: 'Convidado', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en', ...o }, ck);
  const SPAM = { host_name: 'WIN 1000 EUR NOW visit spam.example', personal_message: 'Click spam.example/claim to collect your prize' };

  // Conta grátis com mensagem pessoal: depois do convite, o nome do entrevistador (vai no assunto) e a mensagem ficam.
  const ta = await created('Tiago', 'tiago@example.com');
  const id = await draft(ta.ck, 'Recusada', 'recusa-t@example.net');
  await save(ta.ck, id, { title: 'Recusada', host_name: 'Tiago', guest_email: 'recusa-t@example.net', personal_message: 'Gostava de o entrevistar.' });
  assert.match(msgOf(await sendFree(ta.ck, id)), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  await save(ta.ck, id, { ...SPAM, guest_email: 'outra@x.example' });
  assert.deepEqual(Object.values(await db.one('SELECT host_name, personal_message, guest_email FROM interviews WHERE id=$1', [id])), ['Tiago', 'Gostava de o entrevistar.', 'recusa-t@example.net']);
  const ed = (await get(`/entrevistas/${id}/editar`, ta.ck)).body;
  assert.match(ed, /<input id="hn" name="host_name" type="text" value="Tiago" readonly>/);
  assert.match(ed, /<textarea id="pm" name="personal_message" readonly>Gostava de o entrevistar\.<\/textarea>/);
  assert.match(ed, /Na 1\.ª entrevista grátis, o nome público do entrevistador e a mensagem pessoal também ficam como foram enviados\./);

  // O convidado recusa: nem «Reenviar» (com o intervalo real e o relógio a avançá-lo de cada vez) nem perguntas adicionais.
  const [first] = await inviteMails('recusa-t@example.net');
  await post(`/i/${/\/i\/([A-Za-z0-9_-]{43})/.exec(first.text_body)![1]}/recusar`, {});
  const DECL = /e=O entrevistado recusou o convite: a 1\.ª entrevista grátis não lhe envia mais nada \(nem reenvios, nem perguntas adicionais\)\./;
  let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 5; i++) { t += (config.limits.resendCooldownSec + 1) * 1000; assert.match(msgOf(await post(`/entrevistas/${id}/reenviar`, {}, ta.ck)), DECL); }
  } finally { Date.now = realNow; }
  assert.match(msgOf(await post(`/entrevistas/${id}/adicional`, { text: 'Mais uma?' }, ta.ck)), /qe=O entrevistado recusou o convite/);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM questions WHERE interview_id=$1', [id])).n), 2);
  assert.equal((await inviteMails('recusa-t@example.net')).length, 1, 'só o convite');
  const pg = (await get(`/entrevistas/${id}`, ta.ck)).body;
  assert.doesNotMatch(pg, /\/reenviar"/); assert.match(pg, /<span class="hint sans">O entrevistado recusou o convite/);
  assert.match((await get(`/entrevistas/${id}/editar`, ta.ck)).body, /O entrevistado recusou o convite[^<]*<\/div><form id="adicional"[\s\S]*?<button class="accent" disabled>/);
  // expirada: fica expirada (não passa a «reaberta»)
  await db.query(`UPDATE interviews SET collection_status='expired' WHERE id=$1`, [id]);
  assert.match(msgOf(await post(`/entrevistas/${id}/reenviar`, {}, ta.ck)), DECL);
  assert.equal((await ivOf(id)).collection_status, 'expired');

  // Sem recusa: 3 reenvios e mais nenhum (10 tentativas com o intervalo real e o relógio adiantado), sempre com o texto do convite.
  const ua = await created('Ulisses', 'ulisses@example.com');
  const id2 = await draft(ua.ck, 'Três reenvios', 'tres-u@example.net');
  assert.match(msgOf(await sendFree(ua.ck, id2)), /ok=/);
  await save(ua.ck, id2, { ...SPAM, guest_email: 'tres-u@example.net' });
  const TOTAL = /e=Este convite já foi reenviado 3 vezes \(contam também os links novos pedidos pelo entrevistado\): a 1\.ª entrevista grátis não permite mais reenvios\./;
  let ok = 0;
  t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 10; i++) {
      t += (config.limits.resendCooldownSec + 1) * 1000;
      const m = msgOf(await post(`/entrevistas/${id2}/reenviar`, {}, ua.ck));
      if (/ok=Novo convite enviado/.test(m)) ok++; else assert.match(m, TOTAL);
    }
  } finally { Date.now = realNow; }
  assert.equal(ok, F.FREE_RESENDS);
  const sent = await inviteMails('tres-u@example.net');
  assert.equal(sent.length, 1 + F.FREE_RESENDS);
  assert.ok(sent.every((m: any) => /^Host invites you/.test(m.subject) && !/WIN 1000|spam\.example/.test(m.subject + m.text_body)), 'o assunto e a mensagem são os do convite');
  const pg2 = (await get(`/entrevistas/${id2}`, ua.ck)).body;
  assert.doesNotMatch(pg2, /\/reenviar"/); assert.match(pg2, /Este convite já foi reenviado 3 vezes/);
  // uma pergunta adicional não é um reenvio (traz uma versão nova das perguntas) e sai
  assert.match(msgOf(await post(`/entrevistas/${id2}/adicional`, { text: 'Uma adicional?' }, ua.ck)), /ok=Pergunta adicional enviada/);
  assert.equal((await inviteMails('tres-u@example.net')).length, 2 + F.FREE_RESENDS);

  await withLimits({ resendCooldownSec: 0 }, async () => {
    // Em simultâneo, na última vaga: só um passa (o total conta-se com a entrevista bloqueada, na transação do link novo).
    const va = await created('Vasco', 'vasco@example.com');
    const id3 = await draft(va.ck, 'Em simultâneo', 'simult-v@example.net');
    assert.match(msgOf(await sendFree(va.ck, id3)), /ok=/);
    for (let i = 1; i < F.FREE_RESENDS; i++) assert.match(msgOf(await post(`/entrevistas/${id3}/reenviar`, {}, va.ck)), /ok=Novo convite enviado/);
    // Os três pedidos passam a verificação do início antes de qualquer um criar o link (cada um espera pelos outros à
    // entrada da transação do link novo): só a contagem dentro dela, com a entrevista bloqueada, os separa.
    const orig = db.tx;
    let arrived = 0, go: () => void = () => {};
    const all = new Promise<void>(r => { go = r; });
    db.tx = async (f: any) => { if (++arrived === 3) go(); await all; return orig.call(db, f); };
    let rs: any[];
    try { rs = await Promise.all([1, 2, 3].map(() => post(`/entrevistas/${id3}/reenviar`, {}, va.ck))); } finally { db.tx = orig; }
    assert.equal(arrived, 3, 'os três chegaram à transação do link novo');
    assert.equal(rs.filter(r => /ok=Novo convite enviado/.test(msgOf(r))).length, 1, 'a última vaga só passa uma vez');
    assert.equal(rs.filter(r => /e=Este convite já foi reenviado 3 vezes/.test(msgOf(r))).length, 2);
    assert.equal((await inviteMails('simult-v@example.net')).length, 1 + F.FREE_RESENDS);

    // Entrevista paga (aqui, do administrador): depois da recusa e acima de 3, «Reenviar» como antes; nome e mensagem mudam.
    const pid = await draft(admin, 'Paga', 'paga-p@example.net');
    assert.match(msgOf(await post(`/entrevistas/${pid}/convidar`, {}, admin)), /ok=Convite enviado/);
    await post(`/i/${/\/i\/([A-Za-z0-9_-]{43})/.exec((await inviteMails('paga-p@example.net'))[0].text_body)![1]}/recusar`, {});
    for (let i = 0; i < F.FREE_RESENDS + 2; i++) assert.match(msgOf(await post(`/entrevistas/${pid}/reenviar`, {}, admin)), /ok=Novo convite enviado/);
    await save(admin, pid, { ...SPAM, guest_email: 'paga-p@example.net' });
    assert.deepEqual(Object.values(await db.one('SELECT host_name, personal_message FROM interviews WHERE id=$1', [pid])), [SPAM.host_name, SPAM.personal_message]);
    assert.doesNotMatch((await get(`/entrevistas/${pid}/editar`, admin)).body, /name="host_name" type="text" value="[^"]*" readonly/);
  });
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

test('emails de confirmação por caixa de correio: várias contas com variantes do mesmo endereço não os multiplicam (3 em 24 horas e 5 ao todo, somadas); a resposta é a do total da conta; outra caixa não conta', async () => {
  // Antes, contados só por conta: cada conta com uma variante (alvo+1@…, a.l.v.o@gmail.com, …) mandava mais 3 por dia e 5 ao todo à mesma caixa.
  const variants = ['caixa.alvo+1@gmail.com', 'caixa.alvo+2@gmail.com', 'c.a.i.x.a.alvo@gmail.com', 'caixaalvo@googlemail.com'];
  const accs: { ck: string; id: string }[] = [];
  for (const [i, e] of variants.entries()) accs.push(await register(`Variante ${i}`, e));
  const toMailbox = async () => (await db.query(`SELECT 1 FROM emails WHERE starts_with(dedupe_key, 'verify:') AND to_email = ANY($1)`, [variants])).length;
  const allVerify = async () => Number((await db.one(`SELECT count(*)::int n FROM emails WHERE starts_with(dedupe_key, 'verify:')`)).n);
  assert.equal(await toMailbox(), VERIFY_PER_DAY, 'só os 3 primeiros registos levam email (24 horas da caixa)');
  assert.equal((await db.one(`SELECT meta FROM audit_events WHERE action='signup' AND actor=$1`, [variants[3]])).meta.emailVerification, 'day_limit');
  // com cada link fica a impressão da caixa de correio (a mesma para as variantes)
  const hashes = await db.query(`SELECT DISTINCT v.mailbox_hash FROM email_verifications v JOIN users u ON u.id=v.user_id WHERE u.email = ANY($1)`, [variants]);
  assert.deepEqual(hashes.map((h: any) => h.mailbox_hash), [sha('verify-mailbox:caixaalvo@gmail.com')]);
  // «Reenviar» de qualquer delas, também da que ainda não recebeu nenhum: a mesma resposta do total da conta (nada sobre as outras)
  let before = await allVerify();
  for (const a of accs) assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, a.ck)), /[?]ge=Já enviámos 3 emails de confirmação para o email desta conta nas últimas 24 horas\./);
  assert.equal(await allVerify(), before, 'nada na fila: o teto global não se gasta');
  // 24 horas depois: mais 2, de contas diferentes (5 ao todo na caixa); depois, nenhum
  await db.query(`UPDATE email_verifications SET created_at = created_at - interval '25 hours' WHERE mailbox_hash=$1`, [hashes[0].mailbox_hash]);
  assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, accs[3].ck)), /[?]gok=Enviámos uma ligação nova para caixaalvo@googlemail\.com/);
  assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, accs[0].ck)), /[?]gok=Enviámos uma ligação nova/);
  assert.equal(await toMailbox(), VERIFY_TOTAL);
  await db.query(`UPDATE email_verifications SET created_at = created_at - interval '30 days' WHERE mailbox_hash=$1`, [hashes[0].mailbox_hash]);
  before = await allVerify();
  for (const a of accs) {
    assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, a.ck)), /[?]ge=Já enviámos para o email desta conta o número máximo de emails de confirmação \(5\)/);
    // e o painel deixa de mostrar «Reenviar» em todas, também nas que receberam menos
    const pg = (await get('/painel', a.ck)).body;
    assert.match(pg, /Já enviámos para o email desta conta o número máximo de ligações de confirmação \(5\)/);
    assert.doesNotMatch(pg, /action="\/confirmar-email\/reenviar"/);
  }
  assert.equal(await allVerify(), before);
  assert.equal(await toMailbox(), VERIFY_TOTAL, 'no máximo 5 para a caixa, somadas as 4 contas (antes, até 20)');
  // os links enviados continuam a valer para a conta a que foram enviados
  const last = (await db.query(`SELECT text_body FROM emails WHERE to_email=$1 AND starts_with(dedupe_key, 'verify:') ORDER BY created_at DESC LIMIT 1`, [variants[3]]))[0];
  assert.equal((await post('/confirmar-email', { token: tokenOf(last.text_body) })).statusCode, 200);
  assert.ok((await userOf(accs[3].id)).email_verified_at);
  // outra caixa de correio (outro domínio: os pontos e o resto contam) não é afetada
  await register('Outra caixa', 'caixa.alvo@example.net');
  assert.equal((await verifyMails('caixa.alvo@example.net')).length, 1);
});

test(`registo público: no máximo ${PUBLIC_SIGNUPS_PER_IP_DAY} por IP em 24 horas (além dos 10 por hora); os da ligação de uma entidade não contam`, async () => {
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  const reg = (email: string, extra: Record<string, string> = {}) => post('/registar', { name: 'Mesmo IP', email, password: PW, terms: 1, ...extra }, '', { 'x-forwarded-for': '10.77.0.1' });
  try {
    let n = 0;
    while (n < PUBLIC_SIGNUPS_PER_IP_DAY) {
      for (let i = 0; i < 10 && n < PUBLIC_SIGNUPS_PER_IP_DAY; i++) assert.equal((await reg(`ip-dia-${n++}@example.net`)).headers.location, '/account', `registo ${n}`);
      t += 3600_000 + 5000; // o limite por hora (10) não interessa aqui
    }
    const r = await reg('ip-dia-extra@example.net');
    assert.match(msgOf(r), /^\/registar\?e=Too many sign-ups from this address today\. Please try again tomorrow\.$/);
    assert.equal(await db.one(`SELECT 1 FROM users WHERE email='ip-dia-extra@example.net'`), undefined);
    // pelo link de uma entidade (sem email de confirmação nem oferta), o mesmo IP continua a registar
    const slug = (await db.one(`SELECT slug FROM entities WHERE name='Entidade Teste'`)).slug;
    assert.equal((await reg('ip-dia-entidade@example.net', { entidade: slug })).headers.location, '/account');
    // outro IP não é afetado; 24 horas depois, o mesmo IP volta a poder
    assert.equal((await post('/registar', { name: 'Outro IP', email: 'ip-dia-outro@example.net', password: PW, terms: 1 })).headers.location, '/account');
    t += 86400_000;
    assert.equal((await reg('ip-dia-amanha@example.net')).headers.location, '/account');
  } finally { Date.now = realNow; }
});

/** Guião por rever (rascunho) numa entrevista, como depois do processamento: submetida pelo convidado, com a autorização de processamento. */
const withDraftScript = async (id: string) => {
  await db.query(`INSERT INTO scripts(interview_id, revision, title_en, segments, status, prompt_version, model) VALUES ($1, 1, 'Title', $2, 'draft', 'script-v1', 'mock')`,
    [id, JSON.stringify([{ id: 'intro', speakerRole: 'host', textEnglish: 'Welcome.', sourceQuestionId: null, transformationType: 'editorial_intro' }])]);
  await db.query(`UPDATE interviews SET production_status='editorial_review', collection_status='submitted', submitted_at=now() WHERE id=$1`, [id]);
  await db.query(`INSERT INTO consents(interview_id, purpose, granted, text_version, text_snapshot) VALUES ($1,'processing',true,'teste','Processamento por IA.')`, [id]);
};

test('1.ª entrevista grátis: verificação do guião por IA com total por entrevista, contado na base (também em simultâneo); a vez volta se falhar; o administrador não conta; as pagas como antes', () => manyFree(async () => {
  const fr = await created('Rita Verifica', 'rita.verifica@example.com');
  const id = await draft(fr.ck, 'Verificar', 'conv-verifica@example.net');
  assert.match(msgOf(await sendFree(fr.ck, id)), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  await withDraftScript(id);
  const verify = (ck: string, ivId: string) => post(`/entrevistas/${ivId}/guiao/verificar`, {}, ck);
  const OK = /[?]ok=Sem alertas/;
  const USED = `/entrevistas/${id}/producao?e=${F.FREE_REVIEWS_USED}`;
  assert.match((await get(`/entrevistas/${id}/producao`, fr.ck)).body, /1\.ª entrevista grátis: <span id="verificacoes">0 de 6<\/span> verificações usadas\./);
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    for (let i = 0; i < 4; i++) assert.match(msgOf(await verify(fr.ck, id)), OK);
    t += 3600_000 + 5000; // o limite por hora (6, em memória) não interessa aqui: antes, a cada hora havia mais 6, sem fim
    assert.match((await get(`/entrevistas/${id}/producao`, fr.ck)).body, /<span id="verificacoes">4 de 6<\/span>/);
    // as duas últimas vezes com três pedidos em simultâneo: passam dois
    const rs = await Promise.all([verify(fr.ck, id), verify(fr.ck, id), verify(fr.ck, id)]);
    assert.equal(rs.filter(r => OK.test(msgOf(r))).length, 2);
    assert.equal(rs.filter(r => msgOf(r) === USED).length, 1);
    t += 3600_000 + 5000;
    assert.equal(msgOf(await verify(fr.ck, id)), USED, 'acima do total, nada chega à IA, também noutra hora');
    assert.equal(await F.aiUsed(db, id, 'script_review'), F.FREE_SCRIPT_REVIEWS);
    const pg = (await get(`/entrevistas/${id}/producao`, fr.ck)).body;
    assert.match(pg, /<button class="ghost" disabled>Verificação de fidelidade \(assistente\)<\/button>/);
    assert.ok(pg.includes(F.FREE_REVIEWS_USED));
    assert.match(F.FREE_REVIEWS_USED, /Com uma subscrição \(Conta\), as próximas entrevistas não têm este limite\./);
    // o administrador não conta nem fica bloqueado
    assert.match(msgOf(await verify(admin, id)), OK);
    assert.equal(await F.aiUsed(db, id, 'script_review'), F.FREE_SCRIPT_REVIEWS);
    // entrevista paga: só o limite por hora, como antes
    const pa = await created('Paulo Pago', 'paulo.pago@example.com');
    await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pa.id]);
    const pid = await draft(pa.ck, 'Paga', 'conv-paga@example.net');
    assert.match(msgOf(await post(`/entrevistas/${pid}/convidar`, {}, pa.ck)), /ok=Convite enviado\./);
    await withDraftScript(pid);
    for (let h = 0; h < 2; h++) { for (let i = 0; i < 6; i++) assert.match(msgOf(await verify(pa.ck, pid)), OK); t += 3600_000 + 5000; }
    assert.equal(await F.aiUsed(db, pid, 'script_review'), 0);
    assert.doesNotMatch((await get(`/entrevistas/${pid}/producao`, pa.ck)).body, /verificações usadas/);
  } finally { Date.now = realNow; }
  // uma falha (nada feito pela IA) devolve a vez; nunca abaixo de 0
  const g = await created('Gaspar Falha', 'gaspar.falha@example.com');
  const gid = await draft(g.ck, 'Falha', 'conv-falha@example.net');
  assert.match(msgOf(await sendFree(g.ck, gid)), /ok=/);
  assert.equal(await F.takeAiUse(db, gid, 'script_review', 1), true);
  assert.equal(await F.takeAiUse(db, gid, 'script_review', 1), false);
  await F.giveBackAiUse(db, gid, 'script_review');
  await F.giveBackAiUse(db, gid, 'script_review');
  assert.equal(await F.aiUsed(db, gid, 'script_review'), 0);
  assert.equal(await F.takeAiUse(db, gid, 'script_review', 0), false);
}));

test('1.ª entrevista grátis: leituras sintéticas das perguntas ao convidado com total por entrevista (2 por pergunta), contado na base; a guardada não conta; acima dele, a página usa a do navegador; as pagas como antes', () => manyFree(async () => {
  const guestOf = async (email: string) => {
    const m = (await db.query(`SELECT text_body FROM emails WHERE to_email=$1 ORDER BY created_at DESC LIMIT 1`, [email]))[0];
    return `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(m.text_body)![1]}/abrir`, {}, '')).gs}`;
  };
  const qids = async (id: string) => (await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [id])).map((x: any) => x.id as string);
  const voice = (id: string, v: string) => db.query('UPDATE interviews SET question_voice=$2 WHERE id=$1', [id, v]);
  const la = await created('Lia Leituras', 'lia.leituras@example.com');
  const id = await draft(la.ck, 'Leituras', 'conv-leituras@example.net');
  assert.match(msgOf(await sendFree(la.ck, id)), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  const gs = await guestOf('conv-leituras@example.net');
  const [q1, q2] = await qids(id);
  const read = async (q: string) => (await get(`/api/g/leitura/${q}`, gs)).statusCode;
  assert.deepEqual([await read(q1), await read(q2), await read(q1)], [200, 200, 200]);
  assert.equal(await F.aiUsed(db, id, 'question_reading'), 2, 'a leitura guardada reaproveita-se sem contar');
  // o entrevistador muda a voz das perguntas depois do convite: cada mudança refazia as leituras, sem fim
  await voice(id, 'male');
  assert.deepEqual([await read(q1), await read(q2)], [200, 200]);
  await voice(id, 'female');
  assert.equal(await read(q1), 404, 'acima de 2 leituras por pergunta, nada chega à IA (o navegador lê)');
  assert.equal(await F.aiUsed(db, id, 'question_reading'), F.FREE_READINGS_PER_QUESTION * 2);
  assert.equal((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='question_tts'`, [id])).n, 4);
  // entrevista paga: como antes
  const pb = await created('Pedro Pago', 'pedro.pago@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pb.id]);
  const pid = await draft(pb.ck, 'Paga leituras', 'conv-paga-leituras@example.net');
  assert.match(msgOf(await post(`/entrevistas/${pid}/convidar`, {}, pb.ck)), /ok=Convite enviado\./);
  const pgs = await guestOf('conv-paga-leituras@example.net');
  const [p1] = await qids(pid);
  for (const v of ['female', 'male', 'female', 'male']) { await voice(pid, v); assert.equal((await get(`/api/g/leitura/${p1}`, pgs)).statusCode, 200); }
  assert.equal(await F.aiUsed(db, pid, 'question_reading'), 0);
}));

test(`contas sem pagamento: transcrições automáticas das gravações do entrevistador com total em 24 horas (${F.UNPAID_TRANSCRIPTIONS_PER_DAY}, contado na fila); acima dele, a gravação que seria transcrita é recusada com a explicação; as pagas como antes`, async () => {
  const up = (url: string, ck: string) => app.inject({ method: 'POST', url, payload: makeToneWav(2), headers: { 'content-type': 'audio/wav', cookie: ck } });
  const jobsOf = async (uid: string) => Number((await db.one(`SELECT count(*)::int n FROM jobs j JOIN interviews i ON i.id=j.interview_id WHERE i.owner_id=$1 AND j.kind='transcribe_asset'`, [uid])).n);
  const newDraft = async (ck: string, title: string) => {
    const c = await post('/entrevistas', { title }, ck);
    const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
    await post(`/entrevistas/${id}/perguntas`, { text: '' }, ck); // sem texto: o texto vem da transcrição
    await post(`/entrevistas/${id}/perguntas`, { text: 'Com texto?' }, ck);
    return { id, qs: (await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [id])).map((x: any) => x.id as string) };
  };
  const fill = (id: string, n: number) => db.query(`INSERT INTO jobs(interview_id, kind, input, state) SELECT $1, 'transcribe_asset', '{}', 'done' FROM generate_series(1, $2::int)`, [id, n]);
  const ua = await created('Ulisses Transcreve', 'ulisses.transcreve@example.com');
  const d = await newDraft(ua.ck, 'Transcrições');
  await fill(d.id, F.UNPAID_TRANSCRIPTIONS_PER_DAY - 1);
  let r = await up(`/api/entrevistas/${d.id}/perguntas/${d.qs[0]}/audio`, ua.ck);
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(await jobsOf(ua.id), F.UNPAID_TRANSCRIPTIONS_PER_DAY);
  const before = (await db.one('SELECT audio_asset_id FROM questions WHERE id=$1', [d.qs[0]])).audio_asset_id;
  // a seguinte que seria transcrita: recusada (422: o gravador mostra a explicação e não repete), nada guardado nem na fila
  r = await up(`/api/entrevistas/${d.id}/perguntas/${d.qs[0]}/audio`, ua.ck);
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, F.transcriptionsUsed('question'));
  assert.match(r.json().error, /^Atingiu o limite de 40 transcrições automáticas em 24 horas das contas sem subscrição\. Escreva o texto da pergunta antes de a gravar/);
  assert.equal((await db.one('SELECT audio_asset_id FROM questions WHERE id=$1', [d.qs[0]])).audio_asset_id, before);
  r = await up(`/api/entrevistas/${d.id}/objetivo-audio`, ua.ck);
  assert.equal(r.statusCode, 422);
  assert.equal(r.json().error, F.transcriptionsUsed('objective'));
  // noutro rascunho também (o total é da conta)
  const d2 = await newDraft(ua.ck, 'Outro rascunho');
  assert.equal((await up(`/api/entrevistas/${d2.id}/perguntas/${d2.qs[0]}/audio`, ua.ck)).statusCode, 422);
  // uma pergunta com texto não é transcrita: grava-se
  assert.equal((await up(`/api/entrevistas/${d.id}/perguntas/${d.qs[1]}/audio`, ua.ck)).statusCode, 200);
  assert.equal(await jobsOf(ua.id), F.UNPAID_TRANSCRIPTIONS_PER_DAY);
  // 24 horas depois, volta a haver
  await db.query(`UPDATE jobs SET created_at = created_at - interval '25 hours' WHERE interview_id IN ($1, $2)`, [d.id, d2.id]);
  assert.equal((await up(`/api/entrevistas/${d.id}/objetivo-audio`, ua.ck)).statusCode, 200);
  assert.equal(await jobsOf(ua.id), F.UNPAID_TRANSCRIPTIONS_PER_DAY + 1);
  // conta paga: como antes
  const pc = await created('Clara Paga', 'clara.paga@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pc.id]);
  const dp = await newDraft(pc.ck, 'Paga transcrições');
  await fill(dp.id, F.UNPAID_TRANSCRIPTIONS_PER_DAY + 5);
  assert.equal((await up(`/api/entrevistas/${dp.id}/perguntas/${dp.qs[0]}/audio`, pc.ck)).statusCode, 200);
  assert.equal((await up(`/api/entrevistas/${dp.id}/objetivo-audio`, pc.ck)).statusCode, 200);
  assert.equal(await jobsOf(pc.id), F.UNPAID_TRANSCRIPTIONS_PER_DAY + 7);
});

test('resposta do «Reenviar» e da confirmação do email junto da caixa da oferta (#gratis) no painel, na Conta e na página do convite; os outros avisos ficam no topo; sem caixa, fica sozinha no lugar dela', async () => {
  const za = await register('Zélia Aviso', 'zelia.aviso@example.net');
  const pageOf = async (loc: string, ck: string) => (await get(loc.replace(/#.*$/, ''), ck)).body;
  const order = (html: string, ...parts: string[]) => {
    const at = parts.map(p => html.indexOf(p));
    assert.ok(at.every(i => i >= 0) && at.every((i, k) => k === 0 || at[k - 1] < i), `${parts.join(' < ')}: ${at.join(', ')}`);
  };
  // painel (resposta de sucesso, logo acima da caixa)
  let r = await post('/confirmar-email/reenviar', { voltar: '/painel' }, za.ck);
  assert.match(msgOf(r), /^\/painel\?gok=Enviámos uma ligação nova para zelia\.aviso@example\.net\.#gratis$/);
  order(await pageOf(String(r.headers.location), za.ck), '<div id="gratis"><div class="flash ok" role="status">Enviámos uma ligação nova', '<strong>A sua 1.ª entrevista é grátis</strong>, depois de confirmar', 'action="/confirmar-email/reenviar"');
  // Conta (em inglês)
  r = await post('/confirmar-email/reenviar', { voltar: '/account' }, za.ck);
  assert.match(msgOf(r), /^\/account\?gok=We sent a new link to zelia\.aviso@example\.net\.#gratis$/);
  order(await pageOf(String(r.headers.location), za.ck), '<div id="gratis"><div class="flash ok" role="status">We sent a new link', '<strong>Your first interview is free</strong> once you confirm');
  // página do convite (resposta de erro: o total de 24 horas)
  const id = await draft(za.ck, 'Aviso', 'conv-aviso@example.net');
  r = await post('/confirmar-email/reenviar', { voltar: `/entrevistas/${id}/convidar` }, za.ck);
  assert.match(msgOf(r), new RegExp(`^/entrevistas/${id}/convidar\\?ge=Já enviámos 3 emails de confirmação para o email desta conta nas últimas 24 horas\\..*#gratis$`));
  order(await pageOf(String(r.headers.location), za.ck), '<h1>Rever e convidar</h1>', '<div id="gratis"><div class="flash bad" role="status">Já enviámos 3 emails', '<strong>A sua 1.ª entrevista é grátis</strong>, depois de confirmar', '<strong>Antes de enviar:</strong>');
  // os outros avisos da página não mudam: no topo, fora da âncora
  order(await pageOf('/painel?ok=Outro%20aviso&gok=Resposta', za.ck), '<div class="flash ok" role="status">Outro aviso</div>', '<div id="gratis"><div class="flash ok" role="status">Resposta</div>');
  // confirmação do email com a sessão da própria conta: volta ao painel com a resposta junto da caixa (já sem o «Reenviar»)
  const tk = tokenOf((await verifyMails('zelia.aviso@example.net')).at(-1).text_body);
  r = await post('/confirmar-email', { token: tk }, za.ck);
  assert.equal(r.headers.location, '/painel?gok=Email%20confirmado.#gratis');
  const pc = await pageOf(String(r.headers.location), za.ck);
  assert.match(pc, /<div id="gratis"><div class="flash ok" role="status">Email confirmado\.<\/div><div class="flash[^"]*">/);
  assert.doesNotMatch(pc, /action="\/confirmar-email\/reenviar"/);
  // sem caixa da oferta (administrador): a resposta fica sozinha no lugar dela
  assert.match(await pageOf('/painel?gok=O%20seu%20email%20j%C3%A1%20est%C3%A1%20confirmado.', admin), /<div id="gratis"><div class="flash ok" role="status">O seu email já está confirmado\.<\/div><\/div>/);
  assert.match(await pageOf('/account?ge=Recusado', admin), /<div id="gratis"><div class="flash bad" role="status">Recusado<\/div><\/div>/);
  // valores repetidos no endereço não aparecem; e a âncora tem margem no topo
  const html = await pageOf('/painel?gok=a&gok=b', za.ck);
  assert.doesNotMatch(html, /role="status">a<|role="status">b</);
  assert.match(html, /#gratis\{scroll-margin-top:12px\}/);
});

// ---- produção da entrevista grátis ----
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
/**
 * Entrevista grátis (ou paga) enviada, respondida e submetida pelo convidado, com a autorização de processamento; `consent`
 * muda-a. `beforeSubmit`: corre com a sessão do convidado antes de ele responder (por exemplo, para enviar fotografias).
 */
const submitted = async (ck: string, title: string, guestEmail: string, paid = false, beforeSubmit?: (gs: string) => Promise<void>) => {
  const id = await draft(ck, title, guestEmail);
  if (paid) assert.match(msgOf(await post(`/entrevistas/${id}/convidar`, {}, ck)), /ok=Convite enviado\./);
  else assert.match(msgOf(await sendFree(ck, id)), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  await flushOutbox(db);
  const m = (await db.query(`SELECT text_body FROM emails WHERE to_email=$1 ORDER BY created_at DESC LIMIT 1`, [guestEmail]))[0];
  const gs = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(m.text_body)![1]}/abrir`, {})).gs}`;
  const consent = (processing: boolean) => post('/entrevista/consentimentos', { participation: '1', adult: '1', ...(processing ? { processing: '1' } : {}), publish: '1' }, gs);
  await consent(true);
  if (beforeSubmit) await beforeSubmit(gs);
  for (const q of await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [id]))
    assert.equal((await app.inject({ method: 'POST', url: `/api/g/respostas/${q.id}`, payload: makeToneWav(2), headers: { 'content-type': 'audio/wav', cookie: gs } })).statusCode, 200);
  await post('/entrevista/submeter', {}, gs);
  assert.equal((await db.one('SELECT collection_status s FROM interviews WHERE id=$1', [id])).s, 'submitted');
  return { id, consent };
};
const statusOf = async (id: string) => (await db.one('SELECT production_status s FROM interviews WHERE id=$1', [id])).s;
const jobsOf = async (id: string, kind: string, state = '') => Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1 AND kind=$2 AND ($3='' OR state=$3)`, [id, kind, state])).n);

test('1.ª entrevista grátis: depois de uma geração do episódio que falhou sem custo, processar de novo conta como regeneração (o ciclo pára na 4.ª volta, com as 3 regenerações e os 8 trabalhos usados, sem convidar a pagar); o /gerar verifica a autorização de processamento; «Tentar de novo» repete a geração sem refazer o guião', () => manyFree(async () => {
  // Antes: «Tentar de novo» (POST /processar) não contava depois de qualquer falha, e o /gerar não verificava a autorização.
  // Uma geração que falhava logo ao início (transcrição editada antes de o trabalho começar, ou autorização retirada pelo
  // convidado) tornava gratuito o guião seguinte (gpt-4.1), sem fim (6 voltas no teste do revisor, 0 regenerações).
  const ce = await created('Ciro Ciclo', 'ciro.ciclo@example.com');
  const { id, consent } = await submitted(ce.ck, 'Ciclo', 'conv-ciclo@example.net');
  const take = (await db.one(`SELECT t.id FROM answer_takes t JOIN answers a ON a.id=t.answer_id WHERE a.interview_id=$1 LIMIT 1`, [id])).id;
  /**
   * Aprova o guião, pede o episódio e edita uma transcrição antes de o trabalho começar: a geração falha logo ao início. Na
   * última volta (o 8.º trabalho de produção), a transcrição já não se grava (6.ª revisão: com menos de 2 trabalhos por usar):
   * a falha vem da autorização de processamento retirada pelo convidado, que depois a dá de novo.
   */
  const failGeneration = async (k: number) => {
    assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, ce.ck)), /ok=Guião aprovado/, `volta ${k}`);
    assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, ce.ck)), /ok=Geração iniciada/, `volta ${k}`);
    if (k < 3) await post(`/entrevistas/${id}/transcricoes/${take}`, { text: `Texto revisto ${k}` }, ce.ck);
    else {
      assert.equal(msgOf(await post(`/entrevistas/${id}/transcricoes/${take}`, { text: `Texto revisto ${k}` }, ce.ck)), `/entrevistas/${id}/producao?e=Transcrição não guardada. ${F.FREE_JOBS_USED}`);
      await consent(false);
    }
    await drain();
    if (k >= 3) await consent(true);
    assert.equal(await statusOf(id), 'failed', `volta ${k}`);
  };
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, ce.ck)), /ok=Processamento iniciado/);
  await drain();
  await failGeneration(0);
  assert.equal(await regenerationsUsed(db, id), 0, 'o primeiro processamento e a geração falhada não contam');
  // o guião ficou desatualizado: «Tentar de novo» processa de novo e diz que conta
  const pg = (await get(`/entrevistas/${id}/producao`, ce.ck)).body;
  // 6.ª revisão: na entrevista grátis, o conselho é esperar (cada tentativa conta), com a saída pela Ajuda
  assert.match(pg, new RegExp(`<form method="post" action="/entrevistas/${id}/processar"><p class="hint">Falhou\\. Na 1\\.ª entrevista grátis, cada «Tentar de novo» conta para os ${F.FREE_PRODUCTION_JOBS} trabalhos de produção \\(restam 6\\): espere algum tempo antes de tentar de novo [^<]*<a href="/ajuda">Ajuda</a>\\. «Tentar de novo» processa a entrevista outra vez e refaz o guião: conta como uma regeneração\\.</p><button class="ghost" >Tentar de novo</button>`));
  assert.doesNotMatch(pg, /depois de corrigir a causa/);
  for (let k = 1; k <= 3; k++) {
    assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, ce.ck)), /ok=Processamento iniciado/, `volta ${k}`);
    await drain();
    assert.equal(await regenerationsUsed(db, id), k, `volta ${k}: conta como regeneração`);
    await failGeneration(k);
  }
  // a 4.ª volta pára: nada na fila, nenhum guião novo. Com as 3 regenerações e os 8 trabalhos usados, a recusa é a do total
  // da entrevista grátis (antes, REGEN_BLOCKED com «Saldo: 0 créditos», que convidava a carregar créditos para nada)
  assert.equal(msgOf(await post(`/entrevistas/${id}/processar`, {}, ce.ck)), `/entrevistas/${id}/producao?e=${F.FREE_JOBS_USED}`);
  assert.deepEqual([await jobsOf(id, 'process_submission'), await jobsOf(id, 'process_submission', 'done')], [4, 4]);
  assert.deepEqual([await regenerationsUsed(db, id), await F.freeProductionJobs(db, id)], [3, F.FREE_PRODUCTION_JOBS]);
  // a página a 8 de 8 (6.ª revisão): nada de pagar nem de carregar créditos, sem saldo e com saldo
  const out8 = (await get(`/entrevistas/${id}/producao`, ce.ck)).body;
  assert.match(out8, /<button class="ghost" disabled>Tentar de novo<\/button>/);
  assert.doesNotMatch(out8, /Carregar créditos|pagar 1 crédito|name="pagar"|Cada regeneração seguinte custa/);
  assert.ok(out8.includes(`<div class="flash bad" id="trabalhos-aviso">${F.FREE_JOBS_USED_HTML}</div>`));
  await db.query('INSERT INTO wallets(user_id, available_cents) VALUES ($1, 2500)', [ce.id]);
  const paid8 = (await get(`/entrevistas/${id}/producao`, ce.ck)).body;
  assert.doesNotMatch(paid8, /Carregar créditos|pagar 1 crédito|name="pagar"|Cada regeneração seguinte custa/);
  // e o pedido expresso de pagar, com saldo, também é recusado antes de qualquer cobrança
  for (const url of ['processar', 'guiao/regenerar', 'gerar/repetir'])
    assert.equal(msgOf(await post(`/entrevistas/${id}/${url}`, { pagar: '1', start_now: '1', waiver: '1' }, ce.ck)), `/entrevistas/${id}/producao?e=${F.FREE_JOBS_USED}`, url);
  assert.equal((await db.one('SELECT available_cents FROM wallets WHERE user_id=$1', [ce.id])).available_cents, 2500);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1 AND state IN ('queued','running')`, [id])).n), 0, 'nada na fila');

  // o /gerar verifica a autorização de processamento; «Tentar de novo» depois de uma geração falhada repete-a
  const ga = await created('Gil Autoriza', 'gil.autoriza@example.com');
  const g = await submitted(ga.ck, 'Autorização', 'conv-autoriza@example.net');
  assert.match(msgOf(await post(`/entrevistas/${g.id}/processar`, {}, ga.ck)), /ok=Processamento iniciado/);
  await drain();
  assert.match(msgOf(await post(`/entrevistas/${g.id}/guiao/aprovar`, { reviewed: '1' }, ga.ck)), /ok=Guião aprovado/);
  await g.consent(false); // o convidado retira a autorização de processamento depois de submeter
  assert.match(msgOf(await post(`/entrevistas/${g.id}/gerar`, { subtitle_langs: 'en' }, ga.ck)), /e=Sem autorização de processamento por IA\./);
  assert.equal(await jobsOf(g.id, 'generate_episode'), 0, 'nada na fila');
  const p0 = (await get(`/entrevistas/${g.id}/producao`, ga.ck)).body;
  assert.match(p0, /O entrevistado retirou a autorização de processamento por IA: não é possível gerar o episódio\.<\/div>\s*<button class="accent" disabled>Gerar episódio<\/button>/);
  // retirada entre o pedido e o trabalho: a geração falha logo ao início (sem custo)
  await g.consent(true);
  assert.match(msgOf(await post(`/entrevistas/${g.id}/gerar`, { subtitle_langs: 'en' }, ga.ck)), /ok=Geração iniciada/);
  await g.consent(false);
  await drain();
  assert.equal(await statusOf(g.id), 'failed');
  const p1 = (await get(`/entrevistas/${g.id}/producao`, ga.ck)).body;
  assert.match(p1, new RegExp(`<form method="post" action="/entrevistas/${g.id}/gerar/repetir"><p class="hint">Falhou\\. Na 1\\.ª entrevista grátis, cada «Tentar de novo» conta para os ${F.FREE_PRODUCTION_JOBS} trabalhos de produção \\(restam 6\\): espere algum tempo antes de tentar de novo [^<]*<a href="/ajuda">Ajuda</a>\\. «Tentar de novo» volta a gerar o episódio do guião aprovado, com as mesmas legendas e fotografias \\(não conta como regeneração\\)\\.</p><button class="ghost" >Tentar de novo</button>`));
  assert.match(msgOf(await post(`/entrevistas/${g.id}/gerar/repetir`, {}, ga.ck)), /e=Sem autorização de processamento por IA\./);
  await g.consent(true);
  assert.match(msgOf(await post(`/entrevistas/${g.id}/gerar/repetir`, {}, ga.ck)), /ok=Geração iniciada de novo\./);
  await drain();
  assert.equal(await statusOf(g.id), 'ready');
  assert.ok(await db.one('SELECT 1 FROM episodes WHERE interview_id=$1', [g.id]), 'episódio gerado');
  assert.deepEqual([await jobsOf(g.id, 'process_submission'), await jobsOf(g.id, 'generate_episode'), await regenerationsUsed(db, g.id)], [1, 2, 0], 'o guião não foi refeito e nada contou');
  const jobs = await db.query(`SELECT input, dedupe_key FROM jobs WHERE interview_id=$1 AND kind='generate_episode' ORDER BY created_at`, [g.id]);
  assert.deepEqual(jobs[1].input, jobs[0].input, 'a mesma geração (guião, legendas e fotografias)');
  assert.match(jobs[1].dedupe_key, /:tentativa:1$/);
  assert.match(msgOf(await post(`/entrevistas/${g.id}/gerar/repetir`, {}, ga.ck)), /e=Não há nenhuma geração do episódio falhada para repetir/);
}));

test('guião editado à mão: cada segmento até 4 000 caracteres (limite da síntese de voz) e um total — na 1.ª entrevista grátis, pelas perguntas e pelos minutos de resposta —, recusados ao gravar, ao aprovar e ao gerar; as pagas com o total geral; o administrador só com o do segmento', () => manyFree(async () => {
  // Antes: o POST /guiao aceitava qualquer texto (até ao limite do pedido, MAX_UPLOAD_MB) e o episódio incluído sintetizava
  // tudo (no teste do revisor, um guião de 143 caracteres, com 0,07 min de respostas, mandou 28 120 caracteres à TTS); um
  // segmento acima do limite de entrada da TTS só falhava dentro do trabalho, depois de pagos os anteriores.
  const total = (segs: any[]) => segs.reduce((a, x) => a + x.textEnglish.length, 0);
  const sa = await created('Sara Tamanho', 'sara.tamanho@example.com');
  const { id } = await submitted(sa.ck, 'Tamanho', 'conv-tamanho@example.net');
  await post(`/entrevistas/${id}/processar`, {}, sa.ck); await drain();
  const draftScript = (ivId = id) => db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft' ORDER BY revision DESC LIMIT 1`, [ivId]);
  const s1 = await draftScript();
  const ms = Number((await db.one(`SELECT COALESCE(sum(ast.duration_ms),0)::int ms FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets ast ON ast.id=t.asset_id WHERE an.interview_id=$1`, [id])).ms);
  const budget = Math.ceil(FREE_SCRIPT_BASE + 1.5 * 'Primeira?Segunda?'.length + FREE_SCRIPT_PER_MIN * ms / 60000);
  const sp = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  assert.ok(budget > 3000 && budget < 3300, String(budget));
  const save = (texts: Record<number, string>, ck = sa.ck, ivId = id) => post(`/entrevistas/${ivId}/guiao`, Object.fromEntries(Object.entries(texts).map(([i, t]) => [`seg_${i}`, t])), ck);
  // a página diz os máximos, e cada caixa tem o do segmento
  const pg = (await get(`/entrevistas/${id}/producao`, sa.ck)).body;
  assert.ok(pg.includes(`Cada segmento pode ter até 4 000 caracteres e o guião até ${sp(budget)} na 1.ª entrevista grátis (tem ${sp(total(s1.segments))}).`));
  assert.equal((pg.match(/<textarea name="seg_\d+" maxlength="4000"/g) ?? []).length, s1.segments.length);
  // um segmento acima do limite da síntese de voz: nada gravado, com a mensagem
  assert.equal(msgOf(await save({ 1: 'x'.repeat(SCRIPT_SEGMENT_MAX + 1) })), `/entrevistas/${id}/producao?e=Revisão não guardada. O segmento ${s1.segments[1].id} tem 4 001 caracteres: cada segmento pode ter até 4 000 (limite da síntese de voz). Encurte-o.`);
  // o total da entrevista grátis, com cada segmento dentro do limite
  const over = { 1: 'y'.repeat(2000), 2: 'z'.repeat(2000) };
  assert.equal(msgOf(await save(over)), `/entrevistas/${id}/producao?e=Revisão não guardada. O guião tem ${sp(total(s1.segments) - s1.segments[1].textEnglish.length - s1.segments[2].textEnglish.length + 4000)} caracteres e, na 1.ª entrevista grátis, pode ter até ${sp(budget)} (calculado a partir das perguntas e de 0,1 min de respostas). Encurte o texto dos segmentos.`);
  assert.equal((await draftScript()).revision, s1.revision, 'nada gravado');
  // dentro do total: grava
  assert.match(msgOf(await save({ 1: 'w'.repeat(1500) })), /ok=Revisão \d+ guardada/);
  // a aprovação verifica outra vez (um guião que já está acima, por exemplo vindo da IA), e a geração também
  const s2 = await draftScript();
  await db.query('UPDATE scripts SET segments=$2 WHERE id=$1', [s2.id, JSON.stringify(s2.segments.map((x: any, i: number) => (i < 2 ? { ...x, textEnglish: 'v'.repeat(SCRIPT_SEGMENT_MAX) } : x)))]);
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, sa.ck)), /[?]e=Não é possível aprovar\. O guião tem [\d ]+ caracteres e, na 1\.ª entrevista grátis, pode ter até /);
  assert.equal((await db.one('SELECT status FROM scripts WHERE id=$1', [s2.id])).status, 'draft');
  await db.query(`UPDATE scripts SET status='approved' WHERE id=$1`, [s2.id]);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, sa.ck)), /[?]e=Não é possível gerar o episódio\. O guião tem [\d ]+ caracteres e, na 1\.ª entrevista grátis/);
  assert.equal(await jobsOf(id, 'generate_episode'), 0, 'nada na fila');
  // o guião da IA com um segmento acima do limite fica com um bloqueio editorial (não se aprova nem chega à síntese de voz)
  const v = validateScript({ titleEnglish: 'T', segments: [{ id: 'a1', speakerRole: 'guest', textEnglish: 'u'.repeat(SCRIPT_SEGMENT_MAX + 1), sourceQuestionId: 'q1', transformationType: 'translated_answer' }], reviewFlags: [], blockingIssues: [] });
  assert.deepEqual(v.blockingIssues, ['Segmento a1: 4 001 caracteres, acima do máximo de 4 000 da síntese de voz: encurte-o']);

  // entrevista paga: o total geral (não o da entrevista grátis); o limite do segmento, como em todas
  const pa = await created('Paula Tamanho', 'paula.tamanho@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pa.id]);
  const p = await submitted(pa.ck, 'Tamanho pago', 'conv-tamanho-pago@example.net', true);
  await post(`/entrevistas/${p.id}/processar`, {}, pa.ck); await drain();
  assert.match((await get(`/entrevistas/${p.id}/producao`, pa.ck)).body, /Cada segmento pode ter até 4 000 caracteres e o guião até 60 000 \(tem \d+\)\./);
  assert.match(msgOf(await save({ 1: 'p'.repeat(3500), 2: 'q'.repeat(3500) }, pa.ck, p.id)), /ok=Revisão \d+ guardada/, 'acima do total da entrevista grátis, dentro do geral');
  assert.match(msgOf(await save({ 3: 'r'.repeat(SCRIPT_SEGMENT_MAX + 1) }, pa.ck, p.id)), /[?]e=Revisão não guardada\. O segmento \S+ tem 4 001 caracteres: cada segmento pode ter até 4 000/);
  const ps = await draftScript(p.id);
  const many = Array.from({ length: 16 }, (_, k) => ({ id: `m${k}`, speakerRole: 'host', textEnglish: 'm'.repeat(SCRIPT_SEGMENT_MAX), sourceQuestionId: null, transformationType: 'editorial_transition' }));
  await db.query('UPDATE scripts SET segments=$2 WHERE id=$1', [ps.id, JSON.stringify(many)]);
  assert.equal(msgOf(await post(`/entrevistas/${p.id}/guiao/aprovar`, { reviewed: '1' }, pa.ck)), `/entrevistas/${p.id}/producao?e=Não é possível aprovar. O guião tem 64 000 caracteres e pode ter até 60 000. Encurte o texto dos segmentos.`);
  // o administrador não fica bloqueado pelo total (o limite do segmento vale para todos)
  assert.match(msgOf(await post(`/entrevistas/${p.id}/guiao/aprovar`, { reviewed: '1' }, admin)), /ok=Guião aprovado/);
}));

test('caixa da oferta com o email por confirmar, numa conta que nunca recebeu a ligação: com a caixa de correio sem mais emails de confirmação (gastos por outras contas) ou no limite de 24 horas, uma frase sem «carregue em Reenviar» nem o botão, e nada sobre outras contas (painel e Conta); sem maneira de confirmar, o título já não promete a entrevista grátis', () => withLimits({ verifyEmailsPerHour: 100000, verifyEmailsPerDay: 100000 }, async () => {
  // Antes: «Ainda não foi possível enviar a ligação para …: carregue em «Reenviar».» e logo a seguir «Já enviámos para o email
  // desta conta o número máximo de ligações de confirmação (5): não é possível pedir outra.», sem nenhum botão; no limite de
  // 24 horas, a caixa mandava carregar em «Reenviar», e o «Reenviar» recusava até ao dia seguinte.
  const box = (html: string) => /<div id="gratis">([\s\S]*?)<\/div><\/div>/.exec(html)?.[1] ?? '';
  let k = 0;
  /** Emails de confirmação já enviados à caixa de correio por outra conta (com uma variante do endereço). */
  const spent = async (userId: string, mailbox: string, n: number, ago: string) => {
    for (let i = 0; i < n; i++)
      await db.query(`INSERT INTO email_verifications(user_id, token_hash, mailbox_hash, expires_at, created_at) VALUES ($1,$2,$3, now() - interval '${ago}' + interval '48 hours', now() - interval '${ago}')`,
        [userId, sha(`caixa-gasta-${k++}`), mailboxHash(mailbox)]);
  };
  // a caixa já recebeu os 5 (de outra conta)
  const outra = await register('Outra conta', 'dona.caixa+1@gmail.com');
  await spent(outra.id, 'dona.caixa@gmail.com', VERIFY_TOTAL, '4 days');
  const dona = await register('Dona da caixa', 'dona.caixa@gmail.com');
  assert.equal((await verifyMails('dona.caixa@gmail.com')).length, 0, 'nenhuma ligação para esta conta');
  const pt = box((await get('/painel', dona.ck)).body);
  assert.match(pt, /<strong>A 1\.ª entrevista grátis exige o email da conta confirmado\.<\/strong> Não é possível enviar mais emails de confirmação para o email desta conta\./);
  assert.match(pt, /Para enviar convites, escolha um plano em <a href="\/account">Conta<\/a>\./);
  assert.doesNotMatch(pt, /Reenviar|reenviar|número máximo|outra conta|depois de confirmar/);
  const en = box((await get('/account', dona.ck)).body);
  assert.match(en, /<strong>The free first interview needs a confirmed account email\.<\/strong> No more confirmation emails can be sent to this account’s email address\./);
  assert.match(en, /To send invitations, choose a plan below\./);
  assert.doesNotMatch(en, /Resend|reenviar|maximum number|other account|once you confirm/);
  // a conta que tem uma ligação ainda válida continua a poder confirmar: o título fica, sem o convite a escolher um plano
  const viva = await register('Ainda vale', 'ainda.vale@example.org');
  await spent(viva.id, 'ainda.vale@example.org', VERIFY_TOTAL - 1, '1 hour');
  const pv = box((await get('/painel', viva.ck)).body);
  assert.match(pv, /<strong>A sua 1\.ª entrevista é grátis<\/strong>, depois de confirmar o email da sua conta\. Enviámos uma ligação para ainda\.vale@example\.org/);
  assert.match(pv, /número máximo de ligações de confirmação \(5\)/);
  assert.doesNotMatch(pv, /escolha um plano|action="\/confirmar-email\/reenviar"/);

  // no limite de 24 horas (3 emails de outra conta para a caixa): pode pedir mais tarde, sem o botão
  const outraDia = await register('Outra do dia', 'dia.caixa+1@gmail.com');
  await spent(outraDia.id, 'dia.caixa@gmail.com', VERIFY_PER_DAY, '1 hour');
  const dd = await register('Dona do dia', 'dia.caixa@gmail.com');
  assert.equal((await verifyMails('dia.caixa@gmail.com')).length, 0);
  const pd = box((await get('/painel', dd.ck)).body);
  assert.match(pd, /<strong>A sua 1\.ª entrevista é grátis<\/strong>, depois de confirmar o email da sua conta\. Ainda não foi possível enviar a ligação para dia\.caixa@gmail\.com\. Pode pedir uma ligação mais tarde\./);
  assert.doesNotMatch(pd, /carregue em «Reenviar»|action="\/confirmar-email\/reenviar"|outra conta/);
  const ed = box((await get('/account', dd.ck)).body);
  assert.match(ed, /We could not send the link to dia\.caixa@gmail\.com yet\. You can ask for a link later\./);
  assert.doesNotMatch(ed, /press «Resend»|action="\/confirmar-email\/reenviar"|other account/);
  // 24 horas depois, o «Reenviar» volta e envia
  await db.query(`UPDATE email_verifications SET created_at = created_at - interval '25 hours' WHERE mailbox_hash=$1`, [mailboxHash('dia.caixa@gmail.com')]);
  assert.match(box((await get('/painel', dd.ck)).body), /: carregue em «Reenviar»\.[\s\S]*action="\/confirmar-email\/reenviar"/);
  assert.match(msgOf(await post('/confirmar-email/reenviar', { voltar: '/painel' }, dd.ck)), /gok=Enviámos uma ligação nova para dia\.caixa@gmail\.com/);
}));

// ---- 5.ª revisão ----
/** Corre a fila até ao fim, também as tentativas de um erro que não é permanente (a espera de 30 s e 60 s encurtada). */
const drainAll = async () => { for (;;) { await db.query(`UPDATE jobs SET run_after=now() WHERE state='queued'`); if (!(await runOne(db, handlers))) break; } await flushOutbox(db); };
const jpeg = (bg: string) => sharp({ create: { width: 320, height: 320, channels: 3, background: bg } }).jpeg().toBuffer();
/** Fotografia (com o ativo) posta numa entrevista. */
const photoIn = async (ivId: string, bg: string) =>
  (await db.one('INSERT INTO photos(interview_id, asset_id) VALUES ($1,$2) RETURNING id', [ivId, await saveAsset(db, { interviewId: ivId, kind: 'guest_photo', mime: 'image/jpeg', ext: 'jpg', data: await jpeg(bg) })])).id as string;

test('1.ª entrevista grátis: fotografia da capa forjada ou de outra entrevista não chega ao trabalho, que verifica as entradas antes da primeira etapa paga; cada trabalho de produção conta para um total que não volta quando falha (falhas tardias incluídas) e o ciclo pára; transcrição editada pela duração da gravação', () => manyFree(async () => {
  // Antes (revisor, 13d7cb4): o /gerar aceitava em cover_photo qualquer cadeia /^[0-9a-f-]{36}$/ ('-' × 36), que só falhava
  // na consulta da capa, depois da voz, dos tempos das legendas, das traduções e da capa, três vezes (erro não permanente); o
  // «Tentar de novo» repetia-a sem contar (hadEpisode e regenerationsUsed ignoram os falhados): 7 gerações, 21 tentativas,
  // 0 regenerações. Qualquer outra falha tardia fazia o mesmo.
  const fa = await created('Fausto Forja', 'fausto.forja@example.com');
  const { id } = await submitted(fa.ck, 'Forja', 'conv-forja@example.net');
  const own = await photoIn(id, '#865');
  await db.query(`INSERT INTO consents(interview_id, purpose, granted, text_version, text_snapshot) VALUES ($1,'cover_use',true,'teste','Capa.')`, [id]);
  const foreign = await photoIn(await draft(fa.ck, 'Outra', 'conv-outra-forja@example.net'), '#4a6');
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, fa.ck)), /ok=Processamento iniciado/);
  await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, fa.ck)), /ok=Guião aprovado/);
  const BAD = '-'.repeat(36);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en', 'pt-PT'], cover_photo: [BAD, foreign.toUpperCase(), own.toUpperCase()] }, fa.ck)), /ok=Geração iniciada/);
  const gj = await db.one(`SELECT id, input FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [id]);
  assert.deepEqual(gj.input.coverPhotoIds, [own], 'só as fotografias desta entrevista, com um uuid válido');
  await drainAll();
  assert.deepEqual(Object.values(await db.one('SELECT state, attempts FROM jobs WHERE id=$1', [gj.id])), ['done', 1]);
  assert.deepEqual((await db.one('SELECT technical FROM episodes WHERE interview_id=$1', [id])).technical.coverPhotos, [own]);

  // o trabalho verifica as entradas (um pedido antigo ou escrito à mão) antes da primeira chamada paga: erro permanente,
  // uma só tentativa, sem nenhuma etapa começada
  const sid = (await db.one(`SELECT id FROM scripts WHERE interview_id=$1 AND status='approved'`, [id])).id;
  const before = Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1`, [id])).n);
  for (const input of [{ coverPhotoIds: [BAD] }, { coverPhotoIds: BAD }, { subtitleLangs: ['en', 'x y'] }])
    await db.query(`INSERT INTO jobs(interview_id, kind, input) VALUES ($1,'generate_episode',$2)`, [id, JSON.stringify({ scriptId: sid, subtitleLangs: ['en'], ...input })]);
  await drainAll();
  const forged = await db.query(`SELECT state, attempts, error, progress_label FROM jobs WHERE interview_id=$1 AND kind='generate_episode' AND id<>$2`, [id, gj.id]);
  assert.equal(forged.length, 3);
  assert.deepEqual(forged.map((j: any) => [j.state, j.attempts, j.progress_label ?? '']), Array(3).fill(['failed', 1, '']), 'nenhuma etapa começou');
  assert.deepEqual(forged.map((j: any) => j.error).sort(), ['Fotografias da capa inválidas', 'Fotografias da capa inválidas', 'Línguas das legendas inválidas']);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1`, [id])).n), before + 3);

  // transcrição editada: na entrevista grátis, até um máximo pela duração da gravação (antes, 20 000 caracteres em qualquer uma)
  const tk = await db.one(`SELECT t.id, ast.duration_ms FROM answer_takes t JOIN answers a ON a.id=t.answer_id JOIN assets ast ON ast.id=t.asset_id WHERE a.interview_id=$1 ORDER BY t.created_at LIMIT 1`, [id]);
  const tmax = Math.ceil(FREE_TRANSCRIPT_BASE + (FREE_TRANSCRIPT_PER_MIN * tk.duration_ms) / 60000);
  assert.ok(tmax > 300 && tmax < 450, String(tmax));
  assert.ok((await get(`/entrevistas/${id}/producao`, fa.ck)).body.includes(`<form method="post" action="/entrevistas/${id}/transcricoes/${tk.id}"><textarea name="text" maxlength="${tmax}" aria-label="Transcrição">`));
  const revs = async () => Number((await db.one(`SELECT count(*)::int n FROM transcripts WHERE source_kind='answer_take' AND source_id=$1`, [tk.id])).n);
  const r0 = await revs();
  assert.equal(msgOf(await post(`/entrevistas/${id}/transcricoes/${tk.id}`, { text: 'x'.repeat(tmax + 1) }, fa.ck)),
    `/entrevistas/${id}/producao?e=Transcrição não guardada. Na 1.ª entrevista grátis, a transcrição desta resposta pode ter até ${tmax} caracteres (calculado a partir de 0,0 min de gravação) e tem ${tmax + 1}. Encurte o texto.`);
  assert.equal(await revs(), r0, 'nada gravado');
  assert.match(msgOf(await post(`/entrevistas/${id}/transcricoes/${tk.id}`, { text: 'y'.repeat(tmax) }, fa.ck)), /ok=Transcrição guardada/);
  assert.equal(await revs(), r0 + 1);
  // o administrador não tem este máximo
  assert.match(msgOf(await post(`/entrevistas/${id}/transcricoes/${tk.id}`, { text: 'z'.repeat(tmax + 500) }, admin)), /ok=Transcrição guardada/);
  assert.equal(await revs(), r0 + 2);

  // falhas tardias (depois das etapas pagas), simuladas: cada trabalho conta para o total da entrevista grátis, também o
  // «Tentar de novo» e a regeneração que falhou (que deixa de contar como regeneração); no total, nada mais entra na fila
  const la = await created('Lia Laço', 'lia.laco@example.com');
  const L = await submitted(la.ck, 'Laço', 'conv-laco@example.net');
  const used = () => F.freeProductionJobs(db, L.id);
  const real = { gen: handlers.generate_episode, prep: handlers.prepare_script };
  const late = (label: string) => async (_job: any, ctx: any) => { await ctx.progress(1, 2, label); throw new Error('falha tardia simulada'); };
  try {
    assert.match(msgOf(await post(`/entrevistas/${L.id}/processar`, {}, la.ck)), /ok=Processamento iniciado/); await drainAll(); // 1
    assert.match((await get(`/entrevistas/${L.id}/producao`, la.ck)).body, /· 1\.ª entrevista grátis: <strong id="trabalhos">1 de 8<\/strong> trabalhos de produção usados \(contam também os que falharam; restam 7\)/);
    assert.match(msgOf(await post(`/entrevistas/${L.id}/guiao/aprovar`, { reviewed: '1' }, la.ck)), /ok=Guião aprovado/);
    handlers.generate_episode = late('A criar a capa');
    assert.match(msgOf(await post(`/entrevistas/${L.id}/gerar`, { subtitle_langs: 'en' }, la.ck)), /ok=Geração iniciada/); await drainAll(); // 2
    assert.match(msgOf(await post(`/entrevistas/${L.id}/gerar/repetir`, {}, la.ck)), /ok=Geração iniciada de novo/); await drainAll(); // 3
    handlers.prepare_script = late('A preparar o guião');
    assert.match(msgOf(await post(`/entrevistas/${L.id}/guiao/regenerar`, {}, la.ck)), /ok=Guião em regeneração/); await drainAll(); // 4
    assert.deepEqual([await regenerationsUsed(db, L.id), await used()], [0, 4], 'a regeneração que falhou não conta como regeneração, mas conta para o total');
    handlers.prepare_script = real.prep;
    assert.match(msgOf(await post(`/entrevistas/${L.id}/guiao/regenerar`, {}, la.ck)), /ok=Guião em regeneração/); await drainAll(); // 5
    assert.match(msgOf(await post(`/entrevistas/${L.id}/guiao/aprovar`, { reviewed: '1' }, la.ck)), /ok=Guião aprovado/);
    assert.match(msgOf(await post(`/entrevistas/${L.id}/gerar`, { subtitle_langs: 'en' }, la.ck)), /ok=Geração iniciada/); await drainAll(); // 6
    for (let k = 7; k <= F.FREE_PRODUCTION_JOBS; k++) { assert.match(msgOf(await post(`/entrevistas/${L.id}/gerar/repetir`, {}, la.ck)), /ok=Geração iniciada de novo/, `trabalho ${k}`); await drainAll(); }
    assert.equal(Number((await db.one(`SELECT sum(attempts)::int n FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [L.id])).n), 3 * 5, 'cada geração com 3 tentativas');
    assert.deepEqual([await regenerationsUsed(db, L.id), await used()], [1, F.FREE_PRODUCTION_JOBS]);
    const OUT = `/entrevistas/${L.id}/producao?e=${F.FREE_JOBS_USED}`;
    assert.equal(msgOf(await post(`/entrevistas/${L.id}/gerar/repetir`, {}, la.ck)), OUT, 'o ciclo pára');
    assert.equal(msgOf(await post(`/entrevistas/${L.id}/guiao/regenerar`, {}, la.ck)), OUT);
    assert.equal(msgOf(await post(`/entrevistas/${L.id}/processar`, {}, la.ck)), OUT);
    assert.equal(msgOf(await post(`/entrevistas/${L.id}/producao/recomecar`, {}, la.ck)), `${OUT} Não é possível recomeçar a produção.`);
    assert.equal(Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1`, [L.id])).n), F.FREE_PRODUCTION_JOBS, 'nada mais na fila');
    const pg = (await get(`/entrevistas/${L.id}/producao`, la.ck)).body;
    assert.match(pg, /<strong id="trabalhos">8 de 8<\/strong>/);
    assert.ok(pg.includes(`<div class="flash bad" id="trabalhos-aviso">${F.FREE_JOBS_USED_HTML}</div>`));
    assert.match(pg, /<button class="ghost" disabled>Tentar de novo<\/button>/);
    assert.match(pg, /<button class="danger" disabled>Recomeçar produção<\/button>/);
    assert.match(F.FREE_JOBS_USED, /Com uma subscrição \(Conta\), as próximas entrevistas não têm este limite\./);
    // o administrador não conta nem fica bloqueado
    handlers.generate_episode = real.gen;
    assert.match(msgOf(await post(`/entrevistas/${L.id}/gerar/repetir`, {}, admin)), /ok=Geração iniciada de novo/);
    await drainAll();
    assert.ok(await db.one('SELECT 1 FROM episodes WHERE interview_id=$1', [L.id]), 'episódio gerado');
    assert.equal(await used(), F.FREE_PRODUCTION_JOBS);
  } finally { handlers.generate_episode = real.gen; handlers.prepare_script = real.prep; }

  // entrevista paga: sem este total nem o máximo da transcrição (como antes)
  const pa = await created('Paco Pago', 'paco.pago@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pa.id]);
  const P = await submitted(pa.ck, 'Paga', 'conv-paga-laco@example.net', true);
  await post(`/entrevistas/${P.id}/processar`, {}, pa.ck); await drain();
  const ptk = (await db.one(`SELECT t.id FROM answer_takes t JOIN answers a ON a.id=t.answer_id WHERE a.interview_id=$1 LIMIT 1`, [P.id])).id;
  const ppg = (await get(`/entrevistas/${P.id}/producao`, pa.ck)).body;
  assert.doesNotMatch(ppg, /id="trabalhos"|trabalhos de produção/);
  assert.ok(ppg.includes(`<form method="post" action="/entrevistas/${P.id}/transcricoes/${ptk}"><textarea name="text" aria-label="Transcrição">`));
  assert.match(msgOf(await post(`/entrevistas/${P.id}/transcricoes/${ptk}`, { text: 'p'.repeat(tmax + 500) }, pa.ck)), /ok=Transcrição guardada/);
}));

test('1.ª entrevista grátis: o «novo link» pedido pelo convidado tem o total dos reenvios (o 4.º não cria convite nem email) e só sai sem nenhum link em vigor; a resposta é sempre a genérica; nada depois da recusa; as pagas como antes', () => manyFree(() => withLimits({ resendCooldownSec: 0 }, async () => {
  // Antes (revisor, 13d7cb4): o POST /i/:token/novo-link não verificava o total: 13 emails ao convidado (1 convite + 12
  // «novo link») em 12 pedidos, e depois o «Reenviar» do entrevistador ficava recusado; ~720 por dia por entrevista grátis.
  const linkOf = async (ivId: string) => /\/i\/([A-Za-z0-9_-]{40,})/.exec((await db.one(`SELECT e.text_body FROM emails e JOIN invitations i ON e.dedupe_key='invite:' || i.id::text
    WHERE i.interview_id=$1 AND i.revoked_at IS NULL`, [ivId])).text_body)![1];
  const counts = async (ivId: string, to: string) => [Number((await db.one('SELECT count(*)::int n FROM invitations WHERE interview_id=$1', [ivId])).n),
    Number((await db.one('SELECT count(*)::int n FROM emails WHERE to_email=$1', [to])).n)];
  const expire = (token: string) => db.query(`UPDATE invitations SET expires_at=now() - interval '1 hour' WHERE token_hash=$1`, [sha(token)]);
  const ask = async (token: string, email: string) => { const r = await post(`/i/${token}/novo-link`, { email }); await flushOutbox(db); return r.headers.location; };

  const na = await created('Nina Link', 'nina.link@example.com');
  const G = 'conv-novolink@example.net';
  const id = await draft(na.ck, 'Novo link', G);
  assert.match(msgOf(await sendFree(na.ck, id)), /ok=Convite enviado: usou a sua 1\.ª entrevista grátis/);
  await flushOutbox(db);
  const tk0 = await linkOf(id);
  // com o link do pedido ainda em vigor, nada sai (a resposta é a genérica)
  assert.equal(await ask(tk0, G), `/i/${tk0}?sent=1`);
  assert.deepEqual(await counts(id, G), [1, 1]);
  // link expirado: um novo, até FREE_RESENDS
  let tk = tk0;
  for (let k = 1; k <= F.FREE_RESENDS; k++) {
    await expire(tk);
    assert.equal(await ask(tk, G), `/i/${tk}?sent=1`);
    assert.deepEqual(await counts(id, G), [1 + k, 1 + k], `novo link ${k}`);
    tk = await linkOf(id);
  }
  // o token revogado (e expirado) não pede outro enquanto o mais recente, na mesma caixa de correio, estiver em vigor
  assert.equal(await ask(tk0, G), `/i/${tk0}?sent=1`);
  assert.deepEqual(await counts(id, G), [4, 4]);
  // o 4.º «novo link», com o mais recente expirado: nenhum convite nem email, e a resposta continua a genérica
  await expire(tk);
  assert.equal(await ask(tk, G), `/i/${tk}?sent=1`);
  assert.deepEqual(await counts(id, G), [1 + F.FREE_RESENDS, 1 + F.FREE_RESENDS]);
  assert.match((await get(`/i/${tk}?sent=1`)).body, /If the email matches an invitation, we have sent a new link\./);
  // o mesmo total do «Reenviar» do entrevistador
  assert.match(msgOf(await post(`/entrevistas/${id}/reenviar`, {}, na.ck)), /já foi reenviado 3 vezes/);
  assert.deepEqual(await counts(id, G), [4, 4]);

  // depois da recusa, nada, também a partir de um link anterior ao recusado (outra entrevista grátis)
  const ra = await created('Rui Recusa', 'rui.recusa@example.com');
  const R = 'conv-novolink-recusa@example.net';
  const rid = await draft(ra.ck, 'Recusa', R);
  assert.match(msgOf(await sendFree(ra.ck, rid)), /ok=/);
  await flushOutbox(db);
  const rt1 = await linkOf(rid);
  await expire(rt1);
  assert.equal(await ask(rt1, R), `/i/${rt1}?sent=1`);
  assert.deepEqual(await counts(rid, R), [2, 2]);
  const rt2 = await linkOf(rid);
  await post(`/i/${rt2}/recusar`, {});
  await expire(rt2);
  assert.equal(await ask(rt1, R), `/i/${rt1}?sent=1`);
  assert.deepEqual(await counts(rid, R), [2, 2], 'recusado: nada sai');

  // entrevista paga: como antes (o link novo sai a cada pedido, também com o link em vigor)
  const pa = await created('Pedro Link', 'pedro.link@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pa.id]);
  const P = 'conv-novolink-pago@example.net';
  const pid = await draft(pa.ck, 'Pago', P);
  assert.match(msgOf(await post(`/entrevistas/${pid}/convidar`, {}, pa.ck)), /ok=Convite enviado\./);
  await flushOutbox(db);
  let pt = await linkOf(pid);
  for (let k = 1; k <= F.FREE_RESENDS + 1; k++) {
    if (k > 1) await expire(pt);
    assert.equal(await ask(pt, P), `/i/${pt}?sent=1`);
    assert.deepEqual(await counts(pid, P), [1 + k, 1 + k], `pago, novo link ${k}`);
    pt = await linkOf(pid);
  }
})));

test('contas sem pagamento: um rascunho nunca enviado não chega à IA da produção — regenerar e verificar o guião, aprová-lo e gerar o episódio exigem a entrevista submetida pelo convidado e a autorização de processamento dele; nada fica na fila', async () => {
  // Antes (juiz, 13d7cb4): uma conta do registo público, com o email por confirmar e sem subscrição, fez 4 prepare_script
  // (gpt-4.1) e uma verificação num rascunho, que ficou em collection_status='draft' e production_status='editorial_review'.
  const sp = await register('Sem Pagar', 'sem.pagar.rascunho@example.org');
  assert.equal((await quotaFor(db, { id: sp.id, role: 'interviewer', entity_id: null } as any)).reason, 'no_subscription');
  const c = await post('/entrevistas', { title: 'Rascunho' }, sp.ck);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Uma pergunta?' }, sp.ck);
  const NO = `/entrevistas/${id}/producao?e=A entrevista não foi submetida.`;
  const jobs = async () => Number((await db.one('SELECT count(*)::int n FROM jobs WHERE interview_id=$1', [id])).n);
  for (let k = 0; k < 3; k++) assert.equal(msgOf(await post(`/entrevistas/${id}/guiao/regenerar`, {}, sp.ck)), NO, `pedido ${k + 1}`);
  await drain();
  assert.equal(await jobs(), 0, 'nada na fila');
  assert.ok(!(await db.one('SELECT 1 FROM scripts WHERE interview_id=$1', [id])), 'nenhum guião');
  // um guião no rascunho (posto à mão): nem verificação, nem aprovação, nem geração
  await db.query(`INSERT INTO scripts(interview_id, revision, title_en, segments, status, prompt_version, model) VALUES ($1, 1, 'Title', $2, 'draft', 'script-v1', 'mock')`,
    [id, JSON.stringify([{ id: 'intro', speakerRole: 'host', textEnglish: 'Welcome.', sourceQuestionId: null, transformationType: 'editorial_intro' }])]);
  assert.equal(msgOf(await post(`/entrevistas/${id}/guiao/verificar`, {}, sp.ck)), NO);
  assert.equal(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, sp.ck)), NO);
  await db.query(`UPDATE scripts SET status='approved' WHERE interview_id=$1`, [id]);
  assert.equal(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, sp.ck)), NO);
  assert.equal(await jobs(), 0);
  assert.deepEqual(Object.values(await db.one('SELECT collection_status, production_status FROM interviews WHERE id=$1', [id])), ['draft', 'not_requested']);
  // submetida, mas sem a autorização de processamento: também não
  await db.query(`UPDATE scripts SET status='draft' WHERE interview_id=$1`, [id]);
  await db.query(`UPDATE interviews SET collection_status='submitted' WHERE id=$1`, [id]);
  for (const a of ['guiao/regenerar', 'guiao/verificar']) assert.equal(msgOf(await post(`/entrevistas/${id}/${a}`, {}, sp.ck)), `/entrevistas/${id}/producao?e=Sem autorização de processamento por IA.`, a);
  assert.equal(await jobs(), 0);
});

test('1.ª entrevista grátis: a vez da verificação do guião só volta quando a OpenAI não respondeu (sem ligação, 429, 5xx); uma resposta que chegou e falhou depois (cortada pelo teto, JSON inválido) conta; os problemas que não são objetos ficam de fora; o pedido leva o teto de tokens', () => manyFree(async () => {
  // Antes: qualquer exceção devolvia a vez, também depois de a OpenAI responder e cobrar; o pedido não tinha teto de tokens,
  // e com issues=[null] o mapeamento lançava um TypeError. O guião e as transcrições (do próprio entrevistador) servem para
  // provocar estas falhas: o total de 6 deixava de limitar o custo.
  const va = await created('Vera Resposta', 'vera.resposta@example.com');
  const id = await draft(va.ck, 'Verificar resposta', 'conv-verifica-resposta@example.net');
  assert.match(msgOf(await sendFree(va.ck, id)), /ok=Convite enviado/);
  await withDraftScript(id);
  const bodies: any[] = [];
  let answer: () => Response = () => { throw new Error('sem resposta definida'); };
  const realFetch = globalThis.fetch, realMock = config.openai.mock, realKey = process.env.OPENAI_API_KEY;
  // Nada sai da máquina: só o endereço da OpenAI, respondido aqui, e com uma chave falsa.
  globalThis.fetch = (async (u: any, init: any) => {
    if (!String(u?.url ?? u).startsWith('https://api.openai.com/v1/chat/completions')) throw new Error(`rede proibida nos testes: ${String(u)}`);
    bodies.push(JSON.parse(String(init?.body ?? '{}')));
    return answer();
  }) as any;
  config.openai.mock = false;
  process.env.OPENAI_API_KEY = 'sk-teste-falso-verificacao-5';
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const completion = (content: string, finish = 'stop') => json(200, { id: 'chatcmpl-teste', object: 'chat.completion', created: 0, model: 'gpt-4.1', choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }] });
  const verify = async () => msgOf(await post(`/entrevistas/${id}/guiao/verificar`, {}, va.ck));
  const used = () => F.aiUsed(db, id, 'script_review');
  try {
    // respondeu (paga), cortada pelo teto: a vez não volta
    answer = completion('{"issues":[{"scriptSegmentId":"intro","severity":"high","explanation":"cor', 'length');
    assert.match(await verify(), /[?]e=Falha na verificação: resposta da IA cortada pelo teto de tokens/);
    assert.equal(await used(), 1);
    assert.equal(bodies[0].max_completion_tokens, REVIEW_MAX_TOKENS);
    // respondeu com JSON inválido: também conta
    answer = completion('{"issues": [nul');
    assert.match(await verify(), /[?]e=Falha na verificação/);
    assert.equal(await used(), 2);
    // problemas que não são objetos ficam de fora (antes, TypeError depois de paga e a vez voltava)
    answer = completion(JSON.stringify({ issues: [null, 3, 'x', [1], { scriptSegmentId: 'intro', severity: 'low', explanation: 'Confirmar o nome.' }] }));
    assert.match(await verify(), /[?]ok=1 possíveis problemas assinalados\./);
    assert.equal(await used(), 3);
    assert.deepEqual((await db.one(`SELECT review_flags FROM scripts WHERE interview_id=$1 AND status='draft'`, [id])).review_flags, [{ segmentId: 'intro', reason: '[low] Confirmar o nome.' }]);
    // sem resposta do fornecedor (sem ligação, 429, 5xx): a vez volta
    answer = () => { throw new TypeError('fetch failed'); };
    assert.match(await verify(), /[?]e=Falha na verificação/);
    assert.equal(await used(), 3, 'sem ligação');
    answer = json(429, { error: { message: 'Rate limit reached', type: 'requests' } });
    assert.match(await verify(), /[?]e=Falha na verificação/);
    assert.equal(await used(), 3, '429');
    answer = json(503, { error: { message: 'Service unavailable', type: 'server_error' } });
    assert.match(await verify(), /[?]e=Falha na verificação/);
    assert.equal(await used(), 3, '5xx');
    assert.equal(bodies.length, 6, 'um pedido por verificação (o SDK não repete)');
  } finally {
    globalThis.fetch = realFetch; config.openai.mock = realMock;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = realKey;
  }
}));

// ---- 6.ª revisão ----
/** Geração do episódio corrida à mão (sem a fila), com as línguas de cada etiqueta «A traduzir as legendas (…)»: uma por tradução paga. */
const generation = async (ivId: string, input: Record<string, unknown>) => {
  const labels: string[] = [];
  await handlers.generate_episode({ interview_id: ivId, input }, { db, progress: async (_d: number, _t?: number, l?: string) => { if (l) labels.push(l); } });
  return labels.filter(l => l.startsWith('A traduzir as legendas')).map(l => /\((.+)\)$/.exec(l)![1]);
};

test('línguas das legendas: só as oferecidas e cada uma uma vez (no máximo 5) no «Guardar», no /gerar e no /gerar/repetir; o trabalho traduz cada língua uma vez, também com as da entrevista, e recusa as outras antes da 1.ª chamada paga; pagas e grátis', () => manyFree(async () => {
  // Antes (3.ª ronda da 6.ª revisão): o filtro deixava passar as repetidas — um «Gerar episódio» com ['en', 'de' × 3000]
  // dava um trabalho com 3001 línguas e 3000 traduções das legendas (gpt-4.1, sem cache), que contava 1 dos 8 trabalhos da
  // entrevista grátis; o «Guardar» gravava 500 'fr'; o trabalho só verificava o formato (também nas línguas da entrevista).
  const li = await created('Lena Línguas', 'lena.linguas@example.com');
  const { id } = await submitted(li.ck, 'Línguas', 'conv-linguas@example.net');
  const langsOf = async (ivId: string) => (await db.one('SELECT subtitle_langs FROM interviews WHERE id=$1', [ivId])).subtitle_langs;
  const save = (ck: string, ivId: string, subtitle_langs: string[]) =>
    post(`/entrevistas/${ivId}/guardar`, { title: 'Línguas', host_name: 'Host', guest_name: 'Convidado', review_policy: 'guest_preview', subtitle_langs }, ck);
  await save(li.ck, id, ['en', ...Array(500).fill('fr'), 'xx', 'de', 'en']);
  assert.deepEqual(await langsOf(id), ['en', 'fr', 'de']);
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, li.ck)), /ok=Processamento iniciado/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, li.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en', ...Array(3000).fill('de')] }, li.ck)), /ok=Geração iniciada/);
  const gj = await db.one(`SELECT id, input FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [id]);
  assert.deepEqual([...gj.input.subtitleLangs].sort(), ['de', 'en']);
  // «Tentar de novo» de uma geração falhada com as línguas repetidas (um pedido de antes desta correção): cada uma uma vez
  await db.query(`UPDATE jobs SET state='failed', error='simulado', input=jsonb_set(input, '{subtitleLangs}', $2::jsonb) WHERE id=$1`, [gj.id, JSON.stringify(['en', 'es', 'es', 'es', 'it'])]);
  await db.query(`UPDATE interviews SET production_status='failed' WHERE id=$1`, [id]);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar/repetir`, {}, li.ck)), /ok=Geração iniciada de novo/);
  assert.deepEqual((await db.one(`SELECT input FROM jobs WHERE interview_id=$1 AND kind='generate_episode' AND state='queued'`, [id])).input.subtitleLangs, ['en', 'es']);
  await drain();
  assert.equal(await statusOf(id), 'ready');

  // o trabalho: uma tradução por língua, com as do pedido e, sem elas, com as da entrevista (gravadas antes desta correção)
  const sid = (await db.one(`SELECT id FROM scripts WHERE interview_id=$1 AND status='approved'`, [id])).id;
  assert.deepEqual(await generation(id, { scriptId: sid, subtitleLangs: ['en', 'de', 'de', 'fr', 'de', 'fr'] }), ['de', 'fr']);
  await db.query(`UPDATE interviews SET subtitle_langs=string_to_array($2, ',') WHERE id=$1`, [id, ['en', ...Array(50).fill('es')].join(',')]);
  assert.deepEqual(await generation(id, { scriptId: sid }), ['es']);
  assert.deepEqual(Object.keys((await db.one(`SELECT subtitles FROM episodes WHERE interview_id=$1 AND status='preview'`, [id])).subtitles).sort(), ['en', 'es']);
  // uma língua que o portal não oferece (no pedido ou na entrevista): erro permanente antes de qualquer etapa
  const refused = async (input: Record<string, unknown>) => {
    const labels: string[] = [];
    await assert.rejects(handlers.generate_episode({ interview_id: id, input: { scriptId: sid, ...input } }, { db, progress: async (_d: number, _t?: number, l?: string) => { if (l) labels.push(l); } }),
      (e: any) => e instanceof PermanentError && e.message === 'Línguas das legendas inválidas');
    assert.deepEqual(labels, [], 'nenhuma etapa começou');
  };
  await refused({ subtitleLangs: ['en', 'it'] });
  await refused({ subtitleLangs: 'de' });
  await db.query(`UPDATE interviews SET subtitle_langs=ARRAY['en','zz'] WHERE id=$1`, [id]);
  await refused({});

  // entrevista paga: as mesmas rotas e o mesmo trabalho
  const pa = await created('Paulo Línguas', 'paulo.linguas@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pa.id]);
  const P = await submitted(pa.ck, 'Línguas pagas', 'conv-linguas-pagas@example.net', true);
  await save(pa.ck, P.id, ['pt-PT', 'pt-PT', 'es', ...Array(200).fill('es')]);
  assert.deepEqual(await langsOf(P.id), ['pt-PT', 'es']);
  await post(`/entrevistas/${P.id}/processar`, {}, pa.ck); await drain();
  assert.match(msgOf(await post(`/entrevistas/${P.id}/guiao/aprovar`, { reviewed: '1' }, pa.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${P.id}/gerar`, { subtitle_langs: ['en', ...Array(1000).fill('fr')] }, pa.ck)), /ok=Geração iniciada/);
  assert.deepEqual([...(await db.one(`SELECT input FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [P.id])).input.subtitleLangs].sort(), ['en', 'fr']);
}));

test('capa: o título, os nomes e a marca sem os caracteres que o XML não admite (também no «Guardar»); a fotografia que não se descodifica é recusada no envio e, já guardada, fica fora da capa; o episódio sai à 1.ª tentativa', () => manyFree(async () => {
  // Antes (3.ª ronda da 6.ª revisão): um nome do convidado com U+0001 («Guardar») fazia falhar o SVG da capa («PCDATA invalid
  // Char»), e uma fotografia com a assinatura JPEG e o conteúdo corrompido passava a verificação do envio e falhava no sharp:
  // nos dois casos, o trabalho falhava 3 vezes depois das etapas pagas (voz, tempos das legendas, traduções e capa).
  const { composeCover, photoDecodes } = await import('../src/cover.ts');
  const { xmlText } = await import('../src/lib.ts');
  const { sniff } = await import('../src/media.ts');
  const good = await jpeg('#865');
  const bad = Buffer.concat([good.subarray(0, 20), randomBytes(4000)]);
  assert.equal(sniff(bad)?.mime, 'image/jpeg', 'passa a verificação da assinatura');
  assert.deepEqual([await photoDecodes(good), await photoDecodes(bad)], [true, false]);
  assert.equal(xmlText('a\u0001b\u0008c\tok\n￿\uD800x😀'), 'abc\tok\nx😀');
  await assert.rejects(sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>Eu\u0001</text></svg>')).png().toBuffer(), /PCDATA invalid Char/);
  // composeCover: texto com caracteres de controlo, um fundo e uma fotografia que não se descodificam — não falha
  const c = await composeCover({ title: 'T\u0001itle ￾ ok', subtitle: 'with Eu\u0001', brand: 'b\u0002rand', background: bad, photos: [bad, good] });
  assert.deepEqual(c.photos, [1], 'só a fotografia que se descodifica');
  assert.equal((await sharp(c.cover).metadata()).width, 1400);

  // no envio: o convidado e o entrevistador
  const fo = await created('Fábio Foto', 'fabio.foto@example.com');
  const up = (url: string, data: Buffer, cookie: string) => app.inject({ method: 'POST', url, payload: data, headers: { 'content-type': 'image/jpeg', cookie } });
  const { id } = await submitted(fo.ck, 'Foto', 'conv-foto@example.net', false, async gs => {
    await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1' }, gs);
    const r = await up('/api/g/fotos', bad, gs);
    assert.deepEqual([r.statusCode, r.json()], [415, { error: 'format' }]);
    assert.equal((await up('/api/g/fotos', good, gs)).statusCode, 200);
  });
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM photos WHERE interview_id=$1', [id])).n), 1, 'a corrompida não ficou');
  const hr = await up(`/api/entrevistas/${id}/foto`, bad, fo.ck);
  assert.deepEqual([hr.statusCode, hr.json()], [415, { error: 'A fotografia não se consegue abrir (ficheiro danificado ou com mais de 50 megapíxeis).' }]);
  assert.equal((await up(`/api/entrevistas/${id}/foto`, good, fo.ck)).statusCode, 200);
  // no «Guardar»: os nomes e as funções sem esses caracteres
  await post(`/entrevistas/${id}/guardar`, { title: 'Foto', host_name: 'Ho\u0002st', guest_name: 'Eu\u0001 Silva￿', guest_title: 'Eng\u0007enheira', review_policy: 'guest_preview', subtitle_langs: ['en', 'pt-PT'] }, fo.ck);
  assert.deepEqual(Object.values(await db.one('SELECT guest_name, guest_title FROM interviews WHERE id=$1', [id])), ['Eu Silva', 'Engenheira']);

  // gravados antes desta correção: um nome com U+0001 e uma fotografia corrompida já guardada (escolhida para a capa)
  await db.query('UPDATE interviews SET guest_name=$2 WHERE id=$1', [id, 'Eu\u0001 Silva']);
  const ok = (await db.one('SELECT id FROM photos WHERE interview_id=$1', [id])).id as string;
  const old = (await db.one('INSERT INTO photos(interview_id, asset_id) VALUES ($1,$2) RETURNING id', [id, await saveAsset(db, { interviewId: id, kind: 'guest_photo', mime: 'image/jpeg', ext: 'jpg', data: bad })])).id as string;
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, fo.ck)), /ok=Processamento iniciado/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, fo.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en', 'pt-PT'], cover_photo: [old, ok] }, fo.ck)), /ok=Geração iniciada/);
  await drainAll();
  assert.deepEqual(Object.values(await db.one(`SELECT state, attempts FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [id])), ['done', 1]);
  const ep = await db.one('SELECT technical, subtitles FROM episodes WHERE interview_id=$1', [id]);
  assert.deepEqual([[...ep.technical.coverPhotoIds].sort(), ep.technical.coverPhotos], [[old, ok].sort(), [ok]], 'a capa só com a fotografia que entrou');
  assert.deepEqual(Object.keys(ep.subtitles).sort(), ['en', 'pt-PT']);
  assert.equal(await F.freeProductionJobs(db, id), 2);
}));

test('1.ª entrevista grátis: «restam N»; com menos de 2 trabalhos por usar, «Guardar nova revisão», «Regenerar guião», processar e «Recomeçar» ficam desligados e recusados (o episódio pronto continua por publicar e ainda se gera de novo); a 8 de 8, a saída pela Ajuda e pela Conta; o administrador produz sem contar', () => manyFree(async () => {
  // Antes (3.ª ronda da 6.ª revisão): com falhas do fornecedor a contar, a 7 de 8 «Guardar nova revisão» continuava ativo e
  // sem aviso — gravar punha o episódio pronto como desatualizado, regenerar o guião gastava o último trabalho e o /gerar era
  // recusado: o episódio, que só esperava a aprovação, deixava de se poder publicar, também com uma subscrição. O aviso do
  // total falava só das «próximas entrevistas», sem saída para esta.
  const sa = await created('Saul Saída', 'saul.saida@example.com');
  const { id } = await submitted(sa.ck, 'Saída', 'conv-saida@example.net');
  const page = async (ck = sa.ck, qs = '') => (await get(`/entrevistas/${id}/producao${qs}`, ck)).body;
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, sa.ck)), /ok=Processamento iniciado/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, sa.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, sa.ck)), /ok=Geração iniciada/); await drain();
  assert.equal(await statusOf(id), 'ready');
  const p2 = await page();
  assert.match(p2, /<strong id="trabalhos">2 de 8<\/strong> trabalhos de produção usados \(contam também os que falharam; restam 6\)/);
  assert.doesNotMatch(p2, /id="trabalhos-aviso"/);
  // cinco trabalhos que falharam antes destes (por exemplo, falhas do fornecedor): 7 de 8
  for (let k = 0; k < 5; k++) await db.query(`INSERT INTO jobs(interview_id, kind, input, state, error, created_at) VALUES ($1,'prepare_script','{}','failed','503 simulado', now() - interval '1 hour')`, [id]);
  const p7 = await page();
  assert.match(p7, /<strong id="trabalhos">7 de 8<\/strong> trabalhos de produção usados \(contam também os que falharam; restam 1\)/);
  assert.ok(p7.includes(`<div class="flash" id="trabalhos-aviso">${F.FREE_JOBS_LOW_HTML}</div>`));
  assert.match(F.FREE_JOBS_LOW_HTML, /resta 1 dos 8 trabalhos de produção: chega para gerar o episódio de um guião aprovado[^<]*peça ajuda à equipa do portal em <a href="\/ajuda">Ajuda<\/a>: a equipa pode terminar a produção desta entrevista\./);
  assert.match(p7, /<button class="ghost" disabled>Guardar nova revisão \(r2\)<\/button>/);
  assert.match(p7, /<button class="ghost" disabled>Regenerar guião a partir das transcrições<\/button>/);
  assert.match(p7, /<button class="danger" disabled>Recomeçar produção<\/button>/);
  assert.match(p7, /com menos de 2 trabalhos de produção por usar, as transcrições e o guião já não se refazem/);
  // recusados também no servidor: nada gravado, nada na fila, o episódio continua atual
  const take = (await db.one(`SELECT t.id FROM answer_takes t JOIN answers a ON a.id=t.answer_id WHERE a.interview_id=$1 LIMIT 1`, [id])).id;
  const revs = async () => Number((await db.one(`SELECT count(*)::int n FROM transcripts WHERE source_kind='answer_take' AND source_id=$1`, [take])).n);
  const r0 = await revs(), n0 = Number((await db.one('SELECT count(*)::int n FROM jobs WHERE interview_id=$1', [id])).n);
  const LOW = `/entrevistas/${id}/producao?e=${F.FREE_JOBS_LOW}`;
  assert.equal(msgOf(await post(`/entrevistas/${id}/transcricoes/${take}`, { text: 'Revisão a 7 de 8' }, sa.ck)), `/entrevistas/${id}/producao?e=Transcrição não guardada. ${F.FREE_JOBS_LOW}`);
  assert.equal(msgOf(await post(`/entrevistas/${id}/guiao/regenerar`, {}, sa.ck)), LOW);
  assert.equal(msgOf(await post(`/entrevistas/${id}/processar`, {}, sa.ck)), LOW);
  assert.equal(msgOf(await post(`/entrevistas/${id}/producao/recomecar`, {}, sa.ck)), `${LOW} Não é possível recomeçar a produção.`);
  assert.equal(await revs(), r0, 'nada gravado');
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM jobs WHERE interview_id=$1', [id])).n), n0, 'nada na fila');
  assert.deepEqual(Object.values(await db.one(`SELECT stale, status FROM episodes WHERE interview_id=$1`, [id])), [false, 'preview']);
  assert.equal(await statusOf(id), 'ready');
  // a recusa no endereço não se repete por cima do aviso
  assert.ok(!(await page(sa.ck, `?e=${encodeURIComponent(F.FREE_JOBS_LOW)}`)).includes(F.FREE_JOBS_LOW));
  // gerar o episódio de novo ainda é possível (precisa de 1): é o 8.º trabalho; enquanto corre, o aviso é neutro (7.ª revisão)
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en', 'pt-PT'] }, sa.ck)), /ok=Geração iniciada/);
  const pRun = await page();
  assert.ok(pRun.includes(`<div class="flash" id="trabalhos-aviso">${F.freeJobsDoneHtml('running')}</div>`));
  assert.match(F.freeJobsDoneHtml('running'), /e já os usou todos\. O último está em curso: quando o episódio ficar pronto, pode aprová-lo, enviar a pré-visualização ao entrevistado \(quando ele aprova a versão final\) e publicá-lo, como sempre\./);
  await drain();
  assert.equal(await statusOf(id), 'ready');
  assert.equal(await F.freeProductionJobs(db, id), F.FREE_PRODUCTION_JOBS);

  // 8 de 8 com o episódio pronto (7.ª revisão): o aviso é neutro — o episódio aprova-se, envia-se e publica-se como sempre, e
  // só as alterações precisam da Ajuda. Antes, o aviso vermelho dizia que era preciso a equipa para concluir a entrevista.
  const p8 = await page();
  assert.match(p8, /<strong id="trabalhos">8 de 8<\/strong> trabalhos de produção usados \(contam também os que falharam; restam 0\)/);
  const DONE = `<div class="flash" id="trabalhos-aviso">${F.freeJobsDoneHtml('preview')}</div>`;
  assert.ok(p8.includes(DONE));
  assert.doesNotMatch(p8, /Para a concluir|class="flash bad" id="trabalhos-aviso"/);
  assert.match(F.freeJobsDoneHtml('preview'), /e já os usou todos\. O episódio atual não muda: pode aprová-lo, enviar a pré-visualização ao entrevistado \(quando ele aprova a versão final\) e publicá-lo, como sempre\. Nesta entrevista não há mais regenerações, nem pagas com créditos, nem pedidos adicionais: para alterar o guião ou o episódio, peça ajuda à equipa do portal em <a href="\/ajuda">Ajuda<\/a>\. Com uma subscrição \(<a href="\/account">Conta<\/a>\), as próximas entrevistas não têm este limite\./);
  assert.match(p8, /<button class="ghost">Aprovar esta versão<\/button>/);
  assert.match(p8, /<button class="ghost">Enviar pré-visualização<\/button>/);
  // sem episódio que se possa aprovar e publicar, o aviso vermelho com a saída pela Ajuda
  assert.match(F.FREE_JOBS_USED_HTML, /e já os usou todos: nesta entrevista não há mais regenerações, nem pagas com créditos, nem pedidos adicionais \(a resposta do entrevistado desatualiza o guião e o episódio\)\. Para a concluir, peça ajuda à equipa do portal em <a href="\/ajuda">Ajuda<\/a>: a equipa pode terminar a produção desta entrevista\. Com uma subscrição \(<a href="\/account">Conta<\/a>\), as próximas entrevistas não têm este limite\./);
  assert.match(F.FREE_JOBS_USED, /peça ajuda à equipa do portal em «Ajuda»: a equipa pode terminar a produção desta entrevista\. Com uma subscrição \(Conta\)/);
  for (const [sql, expected] of [[`UPDATE episodes SET technical=jsonb_set(technical, '{qcIssues}', '["Áudio com clipping"]') WHERE interview_id=$1 AND status='preview'`, 'qualidade'], [`UPDATE episodes SET stale=true WHERE interview_id=$1 AND status='preview'`, 'desatualizado']] as const) {
    const before = await db.query(`SELECT id, technical, stale FROM episodes WHERE interview_id=$1 AND status='preview'`, [id]);
    await db.query(sql, [id]);
    assert.ok((await page()).includes(`<div class="flash bad" id="trabalhos-aviso">${F.FREE_JOBS_USED_HTML}</div>`), expected);
    for (const b of before) await db.query('UPDATE episodes SET technical=$2, stale=$3 WHERE id=$1', [b.id, JSON.stringify(b.technical), b.stale]);
  }
  assert.ok((await page()).includes(DONE));
  // publicado: «continua publicado»
  await db.query(`UPDATE episodes SET status='published' WHERE interview_id=$1 AND status='preview'`, [id]);
  assert.ok((await page()).includes(`<div class="flash" id="trabalhos-aviso">${F.freeJobsDoneHtml('published')}</div>`));
  assert.match(F.freeJobsDoneHtml('published'), /e já os usou todos\. O episódio continua publicado\. Nesta entrevista não há mais regenerações/);
  await db.query(`UPDATE episodes SET status='preview' WHERE interview_id=$1 AND status='published'`, [id]);
  assert.match(p8, /<button class="ghost" disabled>Guardar nova revisão \(r2\)<\/button>/);
  assert.match(p8, /<button class="ghost" disabled>Regenerar guião a partir das transcrições<\/button>/);
  assert.doesNotMatch(p8, /Carregar créditos|pagar 1 crédito|name="pagar"/);
  assert.equal(msgOf(await post(`/entrevistas/${id}/transcricoes/${take}`, { text: 'Revisão a 8 de 8' }, sa.ck)), `/entrevistas/${id}/producao?e=Transcrição não guardada. ${F.FREE_JOBS_USED}`);
  assert.ok(!(await page(sa.ck, `?e=${encodeURIComponent(F.FREE_JOBS_USED)}`)).includes(F.FREE_JOBS_USED));
  // o episódio da 8.ª geração continua a seguir o caminho de sempre (a aprovação do entrevistador)
  const ep = await db.one(`SELECT id FROM episodes WHERE interview_id=$1 AND status='preview'`, [id]);
  assert.match(msgOf(await post(`/entrevistas/${id}/episodio/${ep.id}/aprovar`, { video: '' }, sa.ck)), /ok=Versão aprovada/);
  // a 8 de 8 com as regenerações esgotadas e uma geração paga que falhou depois de um episódio (o crédito volta e o trabalho
  // conta): os cartões «Gerar episódio» e «Tentar de novo» continuam sem nada para pagar nem carregar
  const sid = (await db.one(`SELECT id FROM scripts WHERE interview_id=$1 AND status='approved'`, [id])).id;
  for (let k = 0; k < 2; k++) await db.query(`INSERT INTO jobs(interview_id, kind, input, state, created_at) VALUES ($1,'prepare_script','{"regen":true}','done', now() - interval '1 hour')`, [id]);
  await db.query(`INSERT INTO jobs(interview_id, kind, input, state, error) VALUES ($1,'generate_episode',$2,'failed','503 simulado')`, [id, JSON.stringify({ scriptId: sid, subtitleLangs: ['en'], coverPhotoIds: [], regen: true, paidCents: 100 })]);
  await db.query(`UPDATE interviews SET production_status='failed' WHERE id=$1`, [id]);
  assert.equal(await regenerationsUsed(db, id), 3);
  const pf = await page();
  assert.match(pf, /<button class="accent" disabled>Gerar episódio<\/button>/);
  assert.match(pf, /<button class="ghost" disabled>Tentar de novo<\/button>/);
  assert.doesNotMatch(pf, /Carregar créditos|pagar 1 crédito|name="pagar"|Cada regeneração seguinte custa/);
  // a Ajuda aceita o pedido de uma conta sem pagamento; o administrador produz nesta entrevista sem contar nem ficar bloqueado
  const usedBefore = await F.freeProductionJobs(db, id);
  assert.match(msgOf(await post('/ajuda', { subject: 'Entrevista grátis', message: 'Os trabalhos de produção acabaram com falhas do serviço. Podem concluir a entrevista?' }, sa.ck)), /^\/ajuda\/[0-9a-f-]{36}\?ok=sent$/);
  assert.match(msgOf(await post(`/entrevistas/${id}/transcricoes/${take}`, { text: 'Revisão do administrador' }, admin)), /ok=Transcrição guardada/);
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/regenerar`, {}, admin)), /ok=Guião em regeneração/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, admin)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, admin)), /ok=Geração iniciada/); await drain();
  assert.equal(await statusOf(id), 'ready');
  assert.equal(await F.freeProductionJobs(db, id), usedBefore, 'os trabalhos do administrador não contam');
  // depois de a equipa concluir a produção (a saída prometida), o entrevistador vê o aviso neutro e aprova como sempre, sem
  // voltar a ser mandado pedir ajuda (7.ª revisão)
  const pDone = await page();
  assert.ok(pDone.includes(DONE));
  assert.doesNotMatch(pDone, /Para a concluir/);
  const ep2 = await db.one(`SELECT id FROM episodes WHERE interview_id=$1 AND status='preview' AND NOT stale`, [id]);
  assert.match(msgOf(await post(`/entrevistas/${id}/episodio/${ep2.id}/aprovar`, { video: '' }, sa.ck)), /ok=Versão aprovada/);
}));

// ---- 7.ª revisão ----
test('capítulos: um emoji a começar na posição 89 de uma pergunta não parte o título (corte por pontos de código) e o episódio sai à 1.ª tentativa, na grátis e na paga; um erro dos dados na gravação final é permanente e deixa as versões anteriores como estavam', () => manyFree(async () => {
  // Antes (revisões 1 e 2 da c2efa91): o título do capítulo era textEnglish.slice(0, 90), que deixava sozinho o substituto alto
  // do emoji; o JSON.stringify escrevia «\ud83d» e o INSERT INTO episodes falhava («invalid input syntax for type json») no fim
  // da geração, depois do whisper por segmento, das traduções e da capa, em cada uma das 3 tentativas (erro não permanente).
  const { firstChars } = await import('../src/lib.ts');
  const Q = 'a'.repeat(89) + '\u{1F600} and the question?';
  assert.equal(Q.slice(0, 90).at(-1), '\uD83D', 'o slice parte o emoji');
  assert.equal(firstChars(Q, 90), 'a'.repeat(89) + '\u{1F600}');
  assert.equal(firstChars('é\u{1F600}x', 2), 'é\u{1F600}');
  let last = '';
  for (const paid of [false, true]) {
    const tag = paid ? 'paga' : 'gratis';
    const u = await created(`Cátia Capítulo ${tag}`, `catia.capitulo.${tag}@example.com`);
    if (paid) await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [u.id]);
    const { id } = await submitted(u.ck, 'Capítulos', `conv-capitulo-${tag}@example.net`, paid);
    assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, u.ck)), /ok=Processamento iniciado/); await drain();
    const s = await db.one(`SELECT segments FROM scripts WHERE interview_id=$1 AND status='draft' ORDER BY revision DESC LIMIT 1`, [id]);
    const i = (s.segments as any[]).findIndex(x => x.transformationType === 'translated_question');
    assert.ok(i >= 0, 'uma pergunta no guião');
    assert.match(msgOf(await post(`/entrevistas/${id}/guiao`, { [`seg_${i}`]: Q }, u.ck)), /ok=Revisão \d+ guardada/);
    assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, u.ck)), /ok=Guião aprovado/);
    assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en', 'pt-PT'] }, u.ck)), /ok=Geração iniciada/);
    await drainAll();
    assert.deepEqual(Object.values(await db.one(`SELECT state, attempts FROM jobs WHERE interview_id=$1 AND kind='generate_episode'`, [id])), ['done', 1], tag);
    assert.ok((await db.one('SELECT chapters FROM episodes WHERE interview_id=$1', [id])).chapters.some((c: any) => c.title === 'a'.repeat(89) + '\u{1F600}'), `${tag}: o título com o emoji inteiro`);
    assert.equal(await statusOf(id), 'ready');
    if (!paid) assert.equal(await F.freeProductionJobs(db, id), 2);
    last = id;
  }
  // defesa: um erro dos dados na gravação final (SQLSTATE da classe 22 ou 23) é permanente — repetir-se-ia igual depois das
  // etapas pagas — e a transação deixa o episódio anterior como estava; uma falha da ligação (ou sem código) repete-se
  const sid = (await db.one(`SELECT id FROM scripts WHERE interview_id=$1 AND status='approved'`, [last])).id;
  const failing = (code?: string) => ({ ...db, tx: (fn: any) => db.tx((t: any) => fn({ ...t, one: (sql: string, p?: any[]) => /INSERT INTO episodes/.test(sql) ? Promise.reject(Object.assign(new Error('falha simulada'), code ? { code } : {})) : t.one(sql, p) })) });
  for (const [code, permanent] of [['22P02', true], ['23505', true], ['08006', false], [undefined, false]] as const) {
    await assert.rejects(handlers.generate_episode({ interview_id: last, input: { scriptId: sid, subtitleLangs: ['en'] } }, { db: failing(code), progress: async () => {} }),
      (e: any) => (e instanceof PermanentError) === permanent && (permanent ? e.message === 'Não foi possível gravar o episódio: falha simulada' : e.message === 'falha simulada'), String(code));
    assert.deepEqual((await db.query('SELECT status, stale FROM episodes WHERE interview_id=$1', [last])).map((e: any) => [e.status, e.stale]), [['preview', false]], `${code}: o episódio anterior ficou como estava`);
  }
}));

test('«Pedido adicional» na 1.ª entrevista grátis: com um guião ou um episódio e menos de 2 trabalhos de produção por usar, recusado (nada em questions nem em emails; o episódio pronto continua atual) e desligado na página, com a razão e a Ajuda; antes de haver um guião, pelo administrador e nas pagas, como antes', () => manyFree(async () => {
  // Antes (revisões 2 e 4 da c2efa91): a 7 de 8, «Pergunta adicional enviada»; o convidado respondia e submetia, a produção
  // ficava 'stale' e o episódio desatualizado, e depois /processar, /episodio/:id/aprovar e /gerar eram todos recusados.
  const pe = await created('Paula Pedido', 'paula.pedido@example.com');
  const { id } = await submitted(pe.ck, 'Pedido', 'conv-pedido@example.net');
  const ask = (ck: string, text: string) => post(`/entrevistas/${id}/adicional`, { text }, ck);
  const counts = async () => Object.values(await db.one(`SELECT (SELECT count(*)::int FROM questions WHERE interview_id=$1) q, (SELECT count(*)::int FROM emails WHERE interview_id=$1) e, (SELECT count(*)::int FROM invitations WHERE interview_id=$1) i`, [id]));
  const edit = async (qs = '') => (await get(`/entrevistas/${id}/editar${qs}`, pe.ck)).body;
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, pe.ck)), /ok=Processamento iniciado/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, pe.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, pe.ck)), /ok=Geração iniciada/); await drain();
  assert.equal(await statusOf(id), 'ready');
  assert.match(await edit(), /<textarea id="fq" name="text" required ><\/textarea><button class="accent" >Acrescentar e reenviar convite<\/button>/, 'a 2 de 8, disponível');
  // cinco falhas antes destes (por exemplo, do fornecedor): 7 de 8, e depois 8 de 8
  const failed = (n: number) => db.query(`INSERT INTO jobs(interview_id, kind, input, state, error, created_at) SELECT $1, 'prepare_script', '{}', 'failed', '503 simulado', now() - interval '1 hour' FROM generate_series(1, $2::int)`, [id, n]);
  await failed(5);
  for (const [n, msg, html] of [[7, F.FREE_JOBS_LOW, F.FREE_JOBS_LOW_HTML], [8, F.FREE_JOBS_USED, F.FREE_JOBS_USED_HTML]] as const) {
    if (n === 8) await failed(1);
    assert.equal(await F.freeProductionJobs(db, id), n);
    assert.match(msg, /«Pedido adicional»|nem pedidos adicionais/, 'a recusa diz que o pedido adicional também não está disponível');
    const c0 = await counts();
    assert.equal(msgOf(await ask(pe.ck, `Pergunta adicional a ${n} de 8?`)), `/entrevistas/${id}/editar?qe=${msg}#fq`);
    assert.deepEqual(await counts(), c0, `${n} de 8: nada em questions, em emails nem em invitations`);
    assert.deepEqual(Object.values(await db.one('SELECT stale, status FROM episodes WHERE interview_id=$1', [id])), [false, 'preview'], `${n} de 8: o episódio continua atual`);
    assert.deepEqual(Object.values(await db.one('SELECT collection_status, production_status FROM interviews WHERE id=$1', [id])), ['submitted', 'ready']);
    const pg = await edit();
    assert.ok(pg.includes(`<div class="flash bad">${html}</div>`), `${n} de 8: a razão, com a ligação à Ajuda`);
    assert.match(pg, /<textarea id="fq" name="text" required disabled><\/textarea><button class="accent" disabled>Acrescentar e reenviar convite<\/button>/);
    // a recusa vinda no endereço não se repete por cima da razão
    assert.ok(!(await edit(`?qe=${encodeURIComponent(msg)}`)).includes(msg));
  }
  // o administrador não conta nem fica bloqueado
  assert.match(msgOf(await ask(admin, 'Do administrador, a 8 de 8?')), /ok=Pergunta adicional enviada/);

  // antes de haver um guião, a resposta não desatualiza nada: o pedido sai, também com os trabalhos quase todos usados
  const sg = await created('Sílvio Sem Guião', 'silvio.semguiao@example.com');
  const S = await submitted(sg.ck, 'Sem guião', 'conv-silvio@example.net');
  await db.query(`INSERT INTO jobs(interview_id, kind, input, state, error) SELECT $1, 'process_submission', '{}', 'failed', '503 simulado' FROM generate_series(1, 7)`, [S.id]);
  assert.match(msgOf(await post(`/entrevistas/${S.id}/adicional`, { text: 'Sem guião, a 7 de 8?' }, sg.ck)), /ok=Pergunta adicional enviada/);

  // entrevista paga: sem este limite (como antes)
  const pa = await created('Pedro Pedido Pago', 'pedro.pedido.pago@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pa.id]);
  const P = await submitted(pa.ck, 'Pedido pago', 'conv-pedido-pago@example.net', true);
  await post(`/entrevistas/${P.id}/processar`, {}, pa.ck); await drain();
  await db.query(`INSERT INTO jobs(interview_id, kind, input, state, error, created_at) SELECT $1, 'prepare_script', '{}', 'failed', '503 simulado', now() - interval '1 hour' FROM generate_series(1, 8)`, [P.id]);
  assert.match(msgOf(await post(`/entrevistas/${P.id}/adicional`, { text: 'Paga?' }, pa.ck)), /ok=Pergunta adicional enviada/);
}));

test('«Tentar de novo» na 1.ª entrevista grátis sem tentativa possível (7 de 8 com um processamento falhado, 8 de 8 com uma geração falhada): o texto diz que já não é possível, sem «espere» nem «conta como uma regeneração», e o botão fica desligado; sem guião aprovado, o aviso do topo é vermelho e não promete gerar o episódio', () => manyFree(async () => {
  // Antes (revisões 3 e 4 da c2efa91): o conselho só dependia de haver um total («restam N: espere algum tempo antes de tentar
  // de novo…»), também ao lado do botão desligado, com «conta como uma regeneração»; e o FREE_JOBS_LOW dizia sempre que o trabalho
  // que restava chegava para gerar o episódio de um guião aprovado, também sem nenhum guião, com o estilo neutro.
  const real = { gen: handlers.generate_episode, proc: handlers.process_submission };
  const late = (label: string) => async (_job: any, ctx: any) => { await ctx.progress(1, 2, label); throw new Error('falha tardia simulada'); };
  const failed = (ivId: string, kind: string, n: number) => db.query(`INSERT INTO jobs(interview_id, kind, input, state, error, created_at) SELECT $1, $2, '{}', 'failed', '503 simulado', now() - interval '1 hour' FROM generate_series(1, $3::int)`, [ivId, kind, n]);
  const card = (pg: string, ivId: string, action: string) => new RegExp(`<form method="post" action="/entrevistas/${ivId}/${action}"><p class="hint">([^]*?)</p><button class="ghost" (disabled)?>Tentar de novo</button>`).exec(pg);
  try {
    // A. 7 de 8 com um processamento falhado, depois de um guião: processar de novo precisa de 2
    const ta = await created('Tânia Tentativa', 'tania.tentativa@example.com');
    const A1 = await submitted(ta.ck, 'Tentativa', 'conv-tania@example.net');
    assert.match(msgOf(await post(`/entrevistas/${A1.id}/processar`, {}, ta.ck)), /ok=Processamento iniciado/); await drain(); // 1
    await failed(A1.id, 'prepare_script', 5); // 6
    handlers.process_submission = late('A transcrever');
    assert.match(msgOf(await post(`/entrevistas/${A1.id}/processar`, {}, ta.ck)), /ok=Processamento iniciado/); await drainAll(); // 7
    handlers.process_submission = real.proc;
    assert.deepEqual([await statusOf(A1.id), await F.freeProductionJobs(db, A1.id)], ['failed', 7]);
    const pa = (await get(`/entrevistas/${A1.id}/producao`, ta.ck)).body;
    const ca = card(pa, A1.id, 'processar');
    assert.ok(ca, 'o cartão do «Tentar de novo»');
    assert.equal(ca[1], 'Falhou. Nesta 1.ª entrevista grátis já não é possível tentar de novo: resta 1 dos 8 trabalhos de produção, e processar de novo, que refaz o guião, precisa de 2 (o dele e o do episódio). Peça ajuda à equipa do portal em <a href="/ajuda">Ajuda</a>: a equipa pode terminar a produção desta entrevista.');
    assert.equal(ca[2], 'disabled');
    // o guião em rascunho do primeiro processamento ainda se aprova e gera: o aviso do topo é o neutro
    assert.ok(pa.includes(`<div class="flash" id="trabalhos-aviso">${F.FREE_JOBS_LOW_HTML}</div>`));
    assert.equal(msgOf(await post(`/entrevistas/${A1.id}/processar`, {}, ta.ck)), `/entrevistas/${A1.id}/producao?e=${F.FREE_JOBS_LOW}`);

    // A2. 7 processamentos falhados, sem nenhum guião: o aviso do topo é vermelho e não diz que o trabalho que resta gera o episódio
    const tb = await created('Tito Sem Guião', 'tito.semguiao@example.com');
    const B1 = await submitted(tb.ck, 'Sem guião', 'conv-tito@example.net');
    await failed(B1.id, 'process_submission', 7);
    await db.query(`UPDATE interviews SET production_status='failed' WHERE id=$1`, [B1.id]);
    const pb = (await get(`/entrevistas/${B1.id}/producao`, tb.ck)).body;
    assert.ok(pb.includes(`<div class="flash bad" id="trabalhos-aviso">${F.FREE_JOBS_LOW_NO_SCRIPT_HTML}</div>`));
    assert.match(F.FREE_JOBS_LOW_NO_SCRIPT_HTML, /resta 1 dos 8 trabalhos de produção e esta entrevista não tem um guião aprovado: fazer um guião novo e depois o episódio precisa de 2[^<]*Para a concluir, peça ajuda à equipa do portal em <a href="\/ajuda">Ajuda<\/a>/);
    assert.doesNotMatch(pb, /chega para gerar o episódio|espere algum tempo antes de tentar de novo/);
    const cb = card(pb, B1.id, 'processar');
    assert.ok(cb);
    assert.match(cb[1], /^Falhou\. Nesta 1\.ª entrevista grátis já não é possível tentar de novo: resta 1 dos 8 /);
    assert.equal(cb[2], 'disabled');

    // B. 8 de 8 com uma geração falhada e sem episódio: repetir precisa de 1
    const tc = await created('Telma Total', 'telma.total@example.com');
    const C1 = await submitted(tc.ck, 'Total', 'conv-telma@example.net');
    assert.match(msgOf(await post(`/entrevistas/${C1.id}/processar`, {}, tc.ck)), /ok=Processamento iniciado/); await drain(); // 1
    assert.match(msgOf(await post(`/entrevistas/${C1.id}/guiao/aprovar`, { reviewed: '1' }, tc.ck)), /ok=Guião aprovado/);
    await failed(C1.id, 'prepare_script', 6); // 7
    handlers.generate_episode = late('A criar a capa');
    assert.match(msgOf(await post(`/entrevistas/${C1.id}/gerar`, { subtitle_langs: 'en' }, tc.ck)), /ok=Geração iniciada/); await drainAll(); // 8
    handlers.generate_episode = real.gen;
    assert.deepEqual([await statusOf(C1.id), await F.freeProductionJobs(db, C1.id)], ['failed', 8]);
    const pc = (await get(`/entrevistas/${C1.id}/producao`, tc.ck)).body;
    const cc = card(pc, C1.id, 'gerar/repetir');
    assert.ok(cc);
    assert.equal(cc[1], 'Falhou. Nesta 1.ª entrevista grátis já não é possível tentar de novo: os 8 trabalhos de produção estão todos usados. Peça ajuda à equipa do portal em <a href="/ajuda">Ajuda</a>: a equipa pode terminar a produção desta entrevista.');
    assert.equal(cc[2], 'disabled');
    assert.ok(pc.includes(`<div class="flash bad" id="trabalhos-aviso">${F.FREE_JOBS_USED_HTML}</div>`), 'sem episódio, o aviso vermelho');
    assert.equal(msgOf(await post(`/entrevistas/${C1.id}/gerar/repetir`, {}, tc.ck)), `/entrevistas/${C1.id}/producao?e=${F.FREE_JOBS_USED}`);
    // com a tentativa possível (7 de 8 e a geração falhada), o conselho de sempre e o botão ativo
    await db.query(`DELETE FROM jobs WHERE id=(SELECT id FROM jobs WHERE interview_id=$1 AND kind='prepare_script' AND state='failed' LIMIT 1)`, [C1.id]);
    const c7 = card((await get(`/entrevistas/${C1.id}/producao`, tc.ck)).body, C1.id, 'gerar/repetir');
    assert.ok(c7);
    assert.match(c7[1], /^Falhou\. Na 1\.ª entrevista grátis, cada «Tentar de novo» conta para os 8 trabalhos de produção \(restam 1\): espere algum tempo antes de tentar de novo [^]*«Tentar de novo» volta a gerar o episódio do guião aprovado, com as mesmas legendas e fotografias \(não conta como regeneração\)\.$/);
    assert.equal(c7[2], undefined);
  } finally { handlers.generate_episode = real.gen; handlers.process_submission = real.proc; }
}));

// ---- 8.ª revisão ----
test('«Pedido adicional» na 1.ª entrevista grátis com um guião em curso: a 6 de 8, processar e pedir antes de o trabalho correr (na fila ou a correr) é recusado, sem nada em questions nem em emails; o guião sai e o episódio gera-se com o último trabalho', () => manyFree(async () => {
  // Antes (repro do juiz na 9c5de05): o pedido saía por ainda não haver guião, o email ia, o convidado respondia e submetia,
  // e o guião que o processamento dava ficava 'stale': /processar dava FREE_JOBS_LOW, aprovar «Não é possível aprovar» e
  // /gerar «Aprove primeiro o guião» (saída só pela Ajuda).
  const pc = await created('Clara Curso', 'clara.curso@example.com');
  const { id } = await submitted(pc.ck, 'Em curso', 'conv-curso@example.net');
  const counts = async () => Object.values(await db.one(`SELECT (SELECT count(*)::int FROM questions WHERE interview_id=$1) q, (SELECT count(*)::int FROM emails WHERE interview_id=$1) e, (SELECT count(*)::int FROM invitations WHERE interview_id=$1) i`, [id]));
  await db.query(`INSERT INTO jobs(interview_id, kind, input, state, error, created_at) SELECT $1, 'process_submission', '{}', 'failed', '503 simulado', now() - interval '1 hour' FROM generate_series(1, 6)`, [id]);
  assert.equal(await F.freeProductionJobs(db, id), 6);
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, pc.ck)), /ok=Processamento iniciado/);
  assert.equal(await F.freeProductionJobs(db, id), 7);
  assert.ok(!(await db.one('SELECT 1 FROM scripts WHERE interview_id=$1', [id])), 'ainda sem guião');
  const c0 = await counts();
  const refused = `/entrevistas/${id}/editar?qe=${F.FREE_JOBS_LOW}#fq`;
  assert.equal(msgOf(await post(`/entrevistas/${id}/adicional`, { text: 'Com o processamento na fila?' }, pc.ck)), refused);
  await db.query(`UPDATE jobs SET state='running' WHERE interview_id=$1 AND state='queued'`, [id]);
  assert.equal(msgOf(await post(`/entrevistas/${id}/adicional`, { text: 'Com o processamento a correr?' }, pc.ck)), refused);
  await db.query(`UPDATE jobs SET state='queued' WHERE interview_id=$1 AND state='running'`, [id]);
  assert.deepEqual(await counts(), c0, 'nada em questions, em emails nem em invitations');
  assert.match((await get(`/entrevistas/${id}/editar`, pc.ck)).body, /<textarea id="fq" name="text" required disabled><\/textarea><button class="accent" disabled>/);
  await drain();
  assert.equal((await db.one('SELECT status FROM scripts WHERE interview_id=$1', [id])).status, 'draft', 'o guião não ficou desatualizado');
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, pc.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, pc.ck)), /ok=Geração iniciada/); await drain();
  assert.equal(await statusOf(id), 'ready');
  assert.equal(await F.freeProductionJobs(db, id), 8);
}));

/** Respostas da OpenAI simuladas aqui (nada sai da máquina, chave falsa); `route` responde a cada pedido. */
let fakeKeyN = 0;
const fakeOpenAi = async (route: (url: string, body: any) => Response | Promise<Response>, fn: (bodies: { url: string; body: any }[]) => Promise<void>) => {
  const bodies: { url: string; body: any }[] = [];
  const realFetch = globalThis.fetch, realMock = config.openai.mock, realKey = process.env.OPENAI_API_KEY;
  globalThis.fetch = (async (u: any, init: any) => {
    const url = String(u?.url ?? u);
    if (!url.startsWith('https://api.openai.com/v1/')) throw new Error(`rede proibida nos testes: ${url}`);
    let body: any = null;
    try { body = typeof init?.body === 'string' ? JSON.parse(init.body) : null; } catch { body = null; }
    bodies.push({ url, body });
    return route(url, body);
  }) as any;
  config.openai.mock = false;
  // Uma chave por chamada: o cliente da OpenAI guarda o fetch com que foi criado e só se refaz quando a chave muda.
  process.env.OPENAI_API_KEY = `sk-teste-falso-traducoes-${++fakeKeyN}`;
  try { await fn(bodies); } finally {
    globalThis.fetch = realFetch; config.openai.mock = realMock;
    if (realKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = realKey;
  }
};
const jsonRes = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatRes = (content: string, finish = 'stop', usage = { prompt_tokens: 1000, completion_tokens: 2000 }) =>
  jsonRes({ id: 'chatcmpl-teste', object: 'chat.completion', created: 0, model: 'gpt-4.1', usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens }, choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content } }] });
const ledgerOf = async (id: string) => Object.fromEntries((await db.query(`SELECT kind, sum(quantity)::float q, sum(cost_usd)::float usd FROM usage_ledger WHERE interview_id=$1 GROUP BY kind`, [id])).map((r: any) => [r.kind, { q: r.q, usd: r.usd }]));
const systemOf = (b: { body: any }) => String(b.body?.messages?.[0]?.content ?? '');

test('traduções das legendas: teto de tokens proporcional ao bloco; uma resposta cortada pelo teto (ou sem JSON válido) deixa o bloco em inglês, com o alerta, sem repetir; sem resposta do fornecedor, o erro sobe', async () => {
  const cues = Array.from({ length: 130 }, (_, i) => ({ id: `c${i}`, text: `Cue number ${i} of the episode.` }));
  // tetos: crescem com o texto e nunca passam o máximo do modelo
  assert.ok(subtitleMaxTokens(cues.slice(0, 60)) < subtitleMaxTokens(cues.slice(0, 60).map(c => ({ ...c, text: c.text.repeat(4) }))));
  assert.equal(subtitleMaxTokens(Array.from({ length: 60 }, () => ({ text: 'x'.repeat(4000) }))), TEXT_MODEL_MAX_OUT);
  assert.ok(scriptMaxTokens({ title: 't', objective: 'o', items: [] }) < scriptMaxTokens({ title: 't', objective: 'o', items: [{ questionId: 'q', question: 'Q?', status: 'answered', answer: 'a'.repeat(9000) }] }));
  assert.ok(coverMaxTokens('t', 'o') >= 800 && coverMaxTokens('t', 'o'.repeat(3000)) > coverMaxTokens('t', 'o'));
  let n = 0;
  await fakeOpenAi(async (_url, body) => {
    n++;
    const block = JSON.parse(/<interview_data>\n([^]*)\n<\/interview_data>/.exec(body.messages[1].content)![1]);
    if (n === 1) return chatRes('{"cues":[{"sourceCueId":"c0","translatedText":"Legenda', 'length');
    if (n === 2) return chatRes(JSON.stringify({ cues: block.map((c: any) => ({ sourceCueId: c.id, translatedText: `[de] ${c.text}`, reviewFlags: [] })) }));
    return chatRes('{"cues": [nul');
  }, async bodies => {
    const meter = newMeter();
    const tr = await translateSubtitleCues(cues, 'de', meter);
    assert.equal(bodies.length, 3, 'um pedido por bloco, nenhum repetido');
    bodies.forEach((b, k) => assert.equal(b.body.max_completion_tokens, subtitleMaxTokens(cues.slice(k * 60, k * 60 + 60)), `bloco ${k}: o teto`));
    assert.equal(tr.length, 130);
    assert.deepEqual(tr.slice(0, 60).map(x => [x.translatedText, x.reviewFlags]), cues.slice(0, 60).map(c => [c.text, [UNTRANSLATED]]), 'bloco cortado: o inglês, com o alerta');
    assert.deepEqual(tr.slice(60, 120).map(x => x.translatedText), cues.slice(60, 120).map(c => `[de] ${c.text}`));
    assert.ok(tr.slice(120).every(x => x.reviewFlags.includes(UNTRANSLATED)), 'JSON inválido: o inglês, com o alerta');
    assert.deepEqual(meter, { input: 3000, output: 6000 }, 'os tokens das três respostas pagas, também das que falharam');
  });
  // sem resposta do fornecedor (5xx): o erro sobe (o trabalho repete-se, sem custo)
  await fakeOpenAi(() => jsonRes({ error: { message: 'Service unavailable', type: 'server_error' } }, 503), async () => {
    await assert.rejects(translateSubtitleCues(cues.slice(0, 5), 'de', newMeter()));
  });
});

test('episódio com a tradução das legendas cortada pelo teto: sai à 1.ª tentativa, com essa língua em inglês e o alerta no controlo de qualidade; a capa vai com a qualidade média; o usage_ledger regista os tempos das legendas, as traduções, o resumo da capa e a verificação; o guião cortado falha de vez à 1.ª tentativa', () => manyFree(async () => {
  // Antes: a resposta cortada lançava um erro comum, e o trabalho repetia-se até 3 vezes, pagando outra vez o whisper por
  // segmento e as traduções; o usage_ledger só tinha a transcrição, o guião, a voz e a imagem.
  const tc = await created('Tiago Corte', 'tiago.corte@example.com');
  const { id } = await submitted(tc.ck, 'Corte', 'conv-corte@example.net');
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, tc.ck)), /ok=Processamento iniciado/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/verificar`, {}, tc.ck)), /ok=Sem alertas/);
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, tc.ck)), /ok=Guião aprovado/);
  const before = await ledgerOf(id);
  assert.ok(before.text_tokens?.q > 0 && before.review_tokens?.q > 0, 'o guião e a verificação ficam registados');
  const png = (await sharp({ create: { width: 64, height: 64, channels: 3, background: '#335577' } }).png().toBuffer()).toString('base64');
  await fakeOpenAi(async (url, body) => {
    if (url.endsWith('/audio/speech')) return new Response(makeToneWav(1.5), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    if (url.endsWith('/audio/transcriptions')) return jsonRes({ text: '', words: [] });
    if (url.endsWith('/images/generations')) return jsonRes({ created: 0, data: [{ b64_json: png }] });
    const sys = String(body?.messages?.[0]?.content ?? '');
    if (sys.startsWith('You are an audiovisual translator')) return chatRes('{"cues":[{"sourceCueId":"c0","translatedText":"Will', 'length', { prompt_tokens: 500, completion_tokens: 900 });
    if (sys.startsWith('You are an art director')) return chatRes(JSON.stringify({ backgroundPromptEnglish: 'soft gradient', palette: ['#112233'], layoutHints: 'x', negativeConstraints: [] }), 'stop', { prompt_tokens: 100, completion_tokens: 50 });
    return chatRes('{"titleEnglish":"T","segments":[{"id":"s0","speakerRole":"host","textEnglish":"Hel', 'length', { prompt_tokens: 700, completion_tokens: 300 });
  }, async bodies => {
    assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: ['en', 'de'] }, tc.ck)), /ok=Geração iniciada/);
    await drain();
    const job = await db.one(`SELECT state, attempts, error FROM jobs WHERE interview_id=$1 AND kind='generate_episode' ORDER BY created_at DESC LIMIT 1`, [id]);
    assert.deepEqual([job.state, job.attempts], ['done', 1], `uma tentativa (${job.error})`);
    const tr = bodies.filter(b => systemOf(b).startsWith('You are an audiovisual translator'));
    assert.equal(tr.length, 1, 'a tradução não se repetiu');
    assert.ok(tr[0].body.max_completion_tokens > 0);
    const cover = bodies.find(b => systemOf(b).startsWith('You are an art director'))!;
    assert.ok(cover.body.max_completion_tokens >= 800, 'o resumo da capa leva teto');
    assert.equal(bodies.find(b => b.url.endsWith('/images/generations'))!.body.quality, 'medium');
    const ep = await db.one(`SELECT subtitles, technical FROM episodes WHERE interview_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]);
    assert.deepEqual(ep.subtitles.de.map((c: any) => c.text), ep.subtitles.en.map((c: any) => c.text), 'o alemão ficou em inglês');
    assert.ok(ep.technical.qcIssues.some((m: string) => /^de: \d+ legendas ficaram em inglês/.test(m)), 'o alerta no controlo de qualidade');
    const after = await ledgerOf(id);
    assert.equal(after.subtitle_tokens.q, 1400, 'a tradução cortada foi paga e fica registada');
    assert.equal(after.cover_tokens.q, 150);
    assert.ok(after.timestamps_min.q > 0 && after.timestamps_min.usd > 0, 'os tempos das legendas (whisper por segmento)');
    assert.ok(after.image.q === 1 && after.tts_chars.q > 0);
    // guião cortado: erro permanente, uma tentativa (e não três), com os tokens registados
    const textBefore = after.text_tokens.q;
    await enqueue(db, { kind: 'prepare_script', interviewId: id });
    await drain();
    const ps = await db.one(`SELECT state, attempts, error FROM jobs WHERE interview_id=$1 AND kind='prepare_script' ORDER BY created_at DESC LIMIT 1`, [id]);
    assert.deepEqual([ps.state, ps.attempts], ['failed', 1]);
    assert.match(ps.error, /O guião da IA não pôde ser lido: resposta da IA cortada pelo teto de tokens/);
    const scriptBody = bodies.filter(b => systemOf(b) && !/^You are an (audiovisual|art)/.test(systemOf(b))).at(-1)!;
    assert.ok(scriptBody.body.max_completion_tokens > 1500, 'o guião leva teto');
    assert.equal((await ledgerOf(id)).text_tokens.q - textBefore, 1000);
  });
}));

test('1.ª entrevista grátis: o vídeo com fotografias tem um total próprio (3 gerações, contam as que falham), contado com a entrevista bloqueada; acima dele, nada entra na fila, a página não mostra «Gerar de novo» e dá a saída pela Ajuda; o administrador gera sem contar; as pagas como antes; termos e FAQ', () => manyFree(async () => {
  // Antes (4.ª ronda da 8.ª revisão): o POST /video só recusava com um vídeo já na fila; no teste do revisor, 12 renderizações
  // seguidas numa conta sem pagamento, todas aceites, cada uma com a via única do worker e um episode_video novo no disco.
  if (!admin) admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  assert.equal(F.FREE_VIDEO_RENDERS, 3);
  const vv = await created('Vitor Vídeo', 'vitor.video@example.com');
  const { id } = await submitted(vv.ck, 'Vídeo', 'conv-video@example.net');
  assert.match(msgOf(await post(`/entrevistas/${id}/processar`, {}, vv.ck)), /ok=Processamento iniciado/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, vv.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, vv.ck)), /ok=Geração iniciada/); await drain();
  const ep = await db.one('SELECT id FROM episodes WHERE interview_id=$1 AND NOT stale', [id]);
  const video = (ck = vv.ck) => post(`/entrevistas/${id}/episodio/${ep.id}/video`, { engine: 'still', lang: 'en' }, ck);
  const page = async (ck = vv.ck, qs = '') => (await get(`/entrevistas/${id}/producao${qs}`, ck)).body;
  const form = `action="/entrevistas/${id}/episodio/${ep.id}/video" `;
  const p0 = await page();
  assert.match(p0, /· Vídeo com fotografias: <strong id="videos">0 de 3<\/strong> gerações usadas \(contam também as que falharam\)/);
  assert.ok(p0.includes(form) && !p0.includes('id="videos-aviso"'));
  // 1.ª geração; a 2.ª falhou (por exemplo, no FFmpeg) e conta
  assert.match(msgOf(await video()), /ok=Geração do vídeo iniciada/); await drainAll();
  await db.query(`INSERT INTO jobs(interview_id, kind, input, state, error, created_at) VALUES ($1,'render_video',$2,'failed','ffmpeg simulado', now() - interval '1 minute')`, [id, JSON.stringify({ episodeId: ep.id, lang: 'en', requestedBy: vv.id })]);
  assert.equal(await F.freeVideoRenders(db, id), 2);
  assert.match(await page(), /<strong id="videos">2 de 3<\/strong>/);
  // dois pedidos em simultâneo na última: só um entra na fila
  const before = await jobsOf(id, 'render_video');
  const both = await Promise.all([video(), video()]);
  assert.equal(both.filter(r => /ok=Geração do vídeo iniciada/.test(msgOf(r))).length, 1, both.map(msgOf).join(' | '));
  assert.equal(await jobsOf(id, 'render_video'), before + 1);
  await drainAll();
  assert.equal(await F.freeVideoRenders(db, id), 3);
  // 3 de 3: recusado antes de entrar na fila, com a saída pela Ajuda; nada novo nos trabalhos nem nos vídeos
  const videoAssets = async () => Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='episode_video'`, [id])).n);
  const assets = await videoAssets();
  const r4 = msgOf(await video());
  assert.ok(r4.includes(`e=${F.FREE_VIDEOS_USED}`), r4);
  assert.match(F.FREE_VIDEOS_USED, /inclui 3 gerações do vídeo com fotografias \(contam também as que falharam\) e já as usou todas: o episódio fica como está \(com o vídeo atual, se houver\) e pode aprová-lo e publicá-lo como sempre\. Para gerar outro[^.]*, peça ajuda à equipa do portal em «Ajuda»\./);
  assert.equal(await jobsOf(id, 'render_video'), before + 1);
  assert.equal(await videoAssets(), assets);
  // a página: sem o formulário (nem «Gerar de novo»), com o aviso e as ligações à Ajuda e à Conta; a recusa no endereço não se repete
  const p3 = await page(vv.ck, `?e=${encodeURIComponent(F.FREE_VIDEOS_USED)}`);
  assert.match(p3, /<strong id="videos">3 de 3<\/strong>/);
  assert.ok(!p3.includes(form) && !p3.includes('Gerar de novo</button>'));
  assert.ok(p3.includes(`<div class="flash" id="videos-aviso">${F.FREE_VIDEOS_USED_HTML}</div>`));
  assert.ok(F.FREE_VIDEOS_USED_HTML.includes('<a href="/ajuda">Ajuda</a>') && F.FREE_VIDEOS_USED_HTML.includes('<a href="/account">Conta</a>'));
  assert.ok(!p3.includes('já as usou todas: o episódio fica como está (com o vídeo atual, se houver) e pode aprová-lo e publicá-lo como sempre. Para gerar outro (por exemplo, com outra língua nas legendas), peça ajuda à equipa do portal em «Ajuda»'), 'a recusa vinda no endereço não se repete');
  // não conta para os trabalhos de produção (nem como regeneração)
  assert.equal(await F.freeProductionJobs(db, id), 2);
  // o administrador gera sem contar (marcado como dele) e não fica bloqueado; a página dele não mostra o total
  assert.match(msgOf(await video(admin)), /ok=Geração do vídeo iniciada/);
  assert.equal((await db.one(`SELECT input FROM jobs WHERE interview_id=$1 AND kind='render_video' ORDER BY created_at DESC LIMIT 1`, [id])).input.admin, true);
  await drainAll();
  assert.equal(await F.freeVideoRenders(db, id), 3);
  const pa = await page(admin);
  assert.ok(pa.includes(form) && !pa.includes('id="videos"'));

  // entrevista paga: sem este total (o 4.º vídeo entra na fila, a página não mostra o contador)
  const pg = await created('Paulo Vídeo', 'paulo.video@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [pg.id]);
  const P = await submitted(pg.ck, 'Vídeo pago', 'conv-video-pago@example.net', true);
  assert.match(msgOf(await post(`/entrevistas/${P.id}/processar`, {}, pg.ck)), /ok=Processamento iniciado/); await drain();
  assert.match(msgOf(await post(`/entrevistas/${P.id}/guiao/aprovar`, { reviewed: '1' }, pg.ck)), /ok=Guião aprovado/);
  assert.match(msgOf(await post(`/entrevistas/${P.id}/gerar`, { subtitle_langs: 'en' }, pg.ck)), /ok=Geração iniciada/); await drain();
  const pep = await db.one('SELECT id FROM episodes WHERE interview_id=$1 AND NOT stale', [P.id]);
  for (let k = 0; k < 4; k++) { assert.match(msgOf(await post(`/entrevistas/${P.id}/episodio/${pep.id}/video`, { engine: 'still', lang: 'en' }, pg.ck)), /ok=Geração do vídeo iniciada/, `pago ${k}`); await drainAll(); }
  assert.doesNotMatch((await get(`/entrevistas/${P.id}/producao`, pg.ck)).body, /id="videos"/);

  // termos 2-C, FAQ (entrevista grátis e vídeo com fotografias, só com a oferta ligada), condições onde a oferta se pede e landing
  const t = (await get('/termos')).body;
  assert.ok(t.includes('À parte desse total, o vídeo com fotografias pode ser gerado até 3 vezes nessa entrevista (contam também as que falham); depois, o episódio e o vídeo já gerado ficam como estão.'));
  const e = FAQ_SEED.find(x => x.key === 'entrevista-gratis')!;
  assert.ok(A.fillVars(e.pt[1]).includes('O vídeo com fotografias fica fora desse total, mas pode ser gerado até 3 vezes (contam também as que falham).'));
  assert.ok(A.fillVars(e.en[1]).includes('The video with photos is outside that total, but it can be generated up to 3 times (failed ones also count).'));
  const vf = FAQ_SEED.find(x => x.key === 'video-fotografias')!;
  assert.ok(A.fillVars(vf.pt[1]).includes('Na 1.ª entrevista grátis, pode gerá-lo até 3 vezes (contam também as que falham); depois, o vídeo já gerado fica e, para outro, peça ajuda à equipa em «Ajuda».'));
  assert.ok(A.fillVars(vf.en[1]).includes('In the free first interview, you can generate it up to 3 times (failed ones also count);'));
  await withLimits({ freePerMonth: 0 }, async () => assert.doesNotMatch(A.fillVars(vf.pt[1]) + A.fillVars(vf.en[1]), /até 3 vezes|up to 3 times/));
  assert.ok(A.FAQ_VAR_HELP.freeVideos);
  assert.ok(F.FREE_JOBS_PT.startsWith('até 8 trabalhos de produção e 3 gerações do vídeo com fotografias (contam os que falham'));
  assert.match((await get('/')).body, /within a total of 8 production jobs: processing, regenerating the script and generating the episode, counting failed jobs and each «Try again», and up to 3 generations of the video with photos\./);
}));
