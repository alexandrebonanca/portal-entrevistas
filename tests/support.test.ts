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
const { flushOutbox } = await import('../src/mail.ts');
const { openThread, cleanSubject, cleanBody } = await import('../src/support.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
// Cada utilizador do teste vem de um IP próprio (o limite por IP é testado à parte).
const post = (url: string, body: any, cookie = '', ip = '10.0.0.1') =>
  app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'x-forwarded-for': ip } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const PW = 'uma-palavra-passe-longa';
const nEmails = async () => Number((await db.one('SELECT count(*)::int n FROM emails')).n);
const threadOf = (loc: string) => /\/([0-9a-f-]{36})\?ok=sent$/.exec(loc)![1];

let admin = '', ana = '', bruno = '', gestora = '', tcId = '';
let anaThread = '', guest = '', guestPt = '', guestThread = '', ivEn = '', ivPt = '', tokenEn = '';

let logins = 0; // o início de sessão tem limite por IP: cada um vem de um IP diferente
const login = async (email: string) => `sid=${cookies(await post('/entrar', { email, password: PW }, '', `10.8.0.${++logins}`)).sid}`;
const newUser = async (name: string, email: string, extra: Record<string, string> = {}) => {
  await post('/admin/utilizadores', { name, email, password: PW, role: 'interviewer', ...extra }, admin);
  return login(email);
};
/** Entrevista do administrador com convite enviado; devolve o token do email e a sessão do convidado. */
const invite = async (title: string, lang: 'en' | 'pt-PT', guestName: string, guestEmail: string) => {
  const c = await post('/entrevistas', { title }, admin);
  const id = /\/entrevistas\/([0-9a-f-]{36})\/editar/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Qual é o maior desafio?' }, admin);
  await post(`/entrevistas/${id}/guardar`, { title, objective_text: 'Perceber o mercado', objective_shared: '1', host_name: 'Admin', guest_name: guestName, guest_email: guestEmail, interaction_lang: lang, answer_lang: 'auto', planned_visibility: 'private', subtitle_langs: ['en'], review_policy: 'guest_preview' }, admin);
  await post(`/entrevistas/${id}/convidar`, {}, admin);
  await flushOutbox(db);
  const mail = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [id]);
  const token = /\/i\/([A-Za-z0-9_-]{40,})/.exec(mail.text_body)![1];
  const gs = `gs=${cookies(await post(`/i/${token}/abrir`, {}, '', '10.9.9.9')).gs}`;
  return { id, token, gs };
};

test('preparação: administrador, entrevistadores, gestora e dois convidados', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  tcId = (await db.one(`SELECT id FROM entities WHERE slug='telecert-formacao'`)).id;
  ana = await newUser('Ana', 'ana@example.com', { entity_id: tcId });
  bruno = await newUser('Bruno', 'bruno@example.com');
  gestora = await newUser('Gestora', 'gestora@example.com', { role: 'entity_admin', entity_id: tcId });
  ({ id: ivEn, token: tokenEn, gs: guest } = await invite('Fibra ótica em Portugal', 'en', 'Rui', 'rui@example.com'));
  ({ id: ivPt, gs: guestPt } = await invite('Energia solar', 'pt-PT', 'Marta', 'marta@example.com'));
  assert.ok(ana && bruno && gestora && guest && guestPt);
});

test('utilizador ↔ administrador: pedido, resposta, contadores de por ler e nenhum email', async () => {
  const emails = await nEmails();
  const help = await get('/ajuda', ana);
  assert.equal(help.statusCode, 200);
  assert.match(help.body, /<a href="\/ajuda">Ajuda<\/a>/, 'ligação «Ajuda» na navegação, sem contador');
  assert.match(help.body, /Falar com o suporte/);
  assert.match(help.body, /não por email/);
  assert.match(help.body, /Ainda não fez nenhum pedido/);
  assert.match((await get('/painel', ana)).body, /<a href="\/ajuda">Ajuda<\/a>/, 'no painel também');
  assert.match((await get('/account', ana)).body, /<a href="\/ajuda">Help<\/a>/, 'na conta (em inglês)');

  const r = await post('/ajuda', { subject: 'Convite <img src=x onerror=alert(1)>', message: 'Linha 1\r\nLinha 2 <script>alert(1)</script>\n\n  indentada' }, ana);
  assert.equal(r.statusCode, 302);
  anaThread = threadOf(r.headers.location as string);
  const th = await db.one('SELECT * FROM support_threads WHERE id=$1', [anaThread]);
  assert.equal(th.status, 'open'); assert.equal(th.origin, 'portal'); assert.equal(th.unread_admin, true); assert.equal(th.unread_user, false);
  assert.equal(th.entity_id, tcId, 'entidade do utilizador'); assert.equal(th.interview_id, null);

  const page = await get(r.headers.location as string, ana);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Pedido enviado/);
  assert.match(page.body, /Convite &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page.body, /<p class="msgbody">Linha 1\nLinha 2 &lt;script&gt;alert\(1\)&lt;\/script&gt;\n\n  indentada<\/p>/, 'escapado e com as quebras de linha');
  assert.doesNotMatch(page.body, /<script>alert|<img src=x/);

  // administrador: contador na navegação, caixa de entrada e contexto
  assert.match((await get('/painel', admin)).body, /<a href="\/admin\/suporte">Suporte <span class="badge" aria-hidden="true">1<\/span><span class="vh"> \(1 pedido por ler\)<\/span><\/a>/);
  assert.match((await get('/admin/utilizadores', admin)).body, /href="\/admin\/suporte">Suporte <span class="badge"/);
  const inbox = await get('/admin/suporte', admin);
  assert.equal(inbox.statusCode, 200);
  assert.match(inbox.body, /Convite &lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(inbox.body, /<img src=x/);
  assert.match(inbox.body, /ana@example\.com/);
  assert.match(inbox.body, /Telecert Formação/);
  assert.match(inbox.body, /aria-current="page">Abertos \(1\)/);
  const at = await get(`/admin/suporte/${anaThread}`, admin);
  assert.equal(at.statusCode, 200);
  assert.match(at.body, /<strong>Utilizador:<\/strong> <a href="\/admin\/utilizadores\/[0-9a-f-]{36}">Ana<\/a> · ana@example\.com/);
  assert.match(at.body, /<strong>Perfil:<\/strong> Entrevistador · <strong>Entidade:<\/strong> Telecert Formação/);
  assert.match(at.body, /<p class="msgbody">Linha 1\nLinha 2 &lt;script&gt;/);
  assert.doesNotMatch(at.body, /<span class="badge"/, 'lido ao abrir: o contador desta página já desconta');
  assert.equal((await db.one('SELECT unread_admin FROM support_threads WHERE id=$1', [anaThread])).unread_admin, false);

  const rep = await post(`/admin/suporte/${anaThread}/responder`, { message: 'Olá Ana,\nveja em Definições <b>MailerSend</b>.' }, admin);
  assert.match(rep.headers.location as string, /\?ok=reply$/);
  const after1 = await db.one('SELECT * FROM support_threads WHERE id=$1', [anaThread]);
  assert.equal(after1.status, 'answered'); assert.equal(after1.unread_user, true); assert.equal(after1.unread_admin, false);

  // utilizador: «Ajuda» com 1 resposta por ler, até abrir o pedido
  assert.match((await get('/painel', ana)).body, /<a href="\/ajuda">Ajuda <span class="badge" aria-hidden="true">1<\/span><span class="vh"> \(1 resposta por ler\)<\/span><\/a>/);
  const list = await get('/ajuda', ana);
  assert.match(list.body, /Nova resposta/);
  assert.match(list.body, /href="#pedidos">1 resposta por ler/);
  const seen = await get(`/ajuda/${anaThread}`, ana);
  assert.match(seen.body, /<strong>Suporte<\/strong>/);
  assert.match(seen.body, /<p class="msgbody">Olá Ana,\nveja em Definições &lt;b&gt;MailerSend&lt;\/b&gt;\.<\/p>/);
  assert.match(seen.body, /Respondido/);
  assert.doesNotMatch(seen.body, /<span class="badge"/);
  assert.match((await get('/painel', ana)).body, /<a href="\/ajuda">Ajuda<\/a>/, 'contador limpo');

  // nova mensagem do utilizador volta a abrir o pedido para o administrador
  await post(`/ajuda/${anaThread}/responder`, { message: 'Obrigada, já funciona.' }, ana);
  const after2 = await db.one('SELECT * FROM support_threads WHERE id=$1', [anaThread]);
  assert.equal(after2.status, 'open'); assert.equal(after2.unread_admin, true);
  assert.match((await get('/painel', admin)).body, /Suporte <span class="badge" aria-hidden="true">1</);

  // fechar: sem formulário de resposta; responder a um pedido fechado é recusado; reabrir
  await post(`/ajuda/${anaThread}/fechar`, {}, ana);
  assert.equal((await db.one('SELECT status FROM support_threads WHERE id=$1', [anaThread])).status, 'closed');
  const closed = await get(`/ajuda/${anaThread}`, ana);
  assert.match(closed.body, /Reabrir pedido/);
  assert.doesNotMatch(closed.body, /\/responder"/);
  const n = Number((await db.one('SELECT count(*)::int n FROM support_messages WHERE thread_id=$1', [anaThread])).n);
  assert.match((await post(`/ajuda/${anaThread}/responder`, { message: 'mais uma' }, ana)).headers.location as string, /\?e=closed$/);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM support_messages WHERE thread_id=$1', [anaThread])).n), n);
  await post(`/ajuda/${anaThread}/reabrir`, {}, ana);
  assert.equal((await db.one('SELECT status FROM support_threads WHERE id=$1', [anaThread])).status, 'open');
  await post(`/admin/suporte/${anaThread}/fechar`, {}, admin);
  assert.equal((await db.one('SELECT status FROM support_threads WHERE id=$1', [anaThread])).status, 'closed');
  assert.match((await get('/admin/suporte?estado=closed', admin)).body, /aria-current="page">Fechados \(1\)/);

  assert.equal(await nEmails(), emails, 'nenhum email é enviado pelo suporte');
  const acts = (await db.query(`SELECT action FROM audit_events WHERE action LIKE 'support.%'`)).map((a: any) => a.action);
  for (const a of ['support.thread_opened', 'support.admin_reply', 'support.message', 'support.closed', 'support.reopened', 'support.admin_closed']) assert.ok(acts.includes(a), a);
  assert.ok(!JSON.stringify(await db.query(`SELECT meta FROM audit_events WHERE action LIKE 'support.%'`)).includes('Linha 1'), 'a auditoria não guarda o texto');
});

test('convidado ↔ administrador: na língua do convidado, com o contexto da entrevista', async () => {
  const emails = await nEmails();
  const iv = await get('/entrevista', guest);
  assert.match(iv.body, /<a href="\/entrevista\/ajuda">Help<\/a>/, 'ligação «Help» nas páginas do convidado (inglês)');
  assert.match((await get('/entrevista', guestPt)).body, /<a href="\/entrevista\/ajuda">Ajuda<\/a>/, 'e «Ajuda» em português');
  const help = await get('/entrevista/ajuda', guest);
  assert.equal(help.statusCode, 200);
  assert.match(help.body, /lang="en"/);
  assert.match(help.body, /Contact support/);
  assert.match(help.body, /not by email/);

  const r = await post('/entrevista/ajuda', { subject: '', message: 'My microphone does not work\non my phone.' }, guest, '10.0.0.7');
  assert.equal(r.statusCode, 302);
  guestThread = threadOf(r.headers.location as string);
  const th = await db.one('SELECT * FROM support_threads WHERE id=$1', [guestThread]);
  assert.equal(th.subject, 'My microphone does not work', 'sem assunto: a primeira linha');
  assert.equal(th.origin, 'guest'); assert.equal(th.lang, 'en'); assert.equal(th.interview_id, ivEn); assert.equal(th.user_id, null);
  assert.match((await get(r.headers.location as string, guest)).body, /Request sent/);

  const at = await get(`/admin/suporte/${guestThread}`, admin);
  assert.match(at.body, /<strong>Convidado:<\/strong> Rui · rui@example\.com/);
  assert.match(at.body, /<strong>Entrevista:<\/strong> <a href="\/entrevistas\/[0-9a-f-]{36}">Fibra ótica em Portugal<\/a> · <strong>Estado:<\/strong> Iniciada/);
  assert.match(at.body, /<strong>Língua:<\/strong> Inglês/);
  assert.match(at.body, /Responder \(em inglês/);
  assert.match(at.body, /<strong>Convidado \(Rui\)<\/strong>/);
  assert.match((await get('/admin/suporte', admin)).body, /Convidado: Rui<br><span class="hint">«Fibra ótica em Portugal»/);

  await post(`/admin/suporte/${guestThread}/responder`, { message: 'Please allow the microphone in the browser settings.' }, admin);
  const back = await get('/entrevista/ajuda', guest);
  assert.match(back.body, /<a href="\/entrevista\/ajuda">Help <span class="badge" aria-hidden="true">1<\/span><span class="vh"> \(1 unread reply\)<\/span><\/a>/);
  assert.match(back.body, /New reply/);
  const seen = await get(`/entrevista/ajuda/${guestThread}`, guest);
  assert.match(seen.body, /<strong>Support<\/strong>/);
  assert.match(seen.body, /<strong>You<\/strong>/);
  assert.match(seen.body, /Please allow the microphone/);
  assert.doesNotMatch(seen.body, /<span class="badge"/);
  assert.equal((await db.one('SELECT unread_user FROM support_threads WHERE id=$1', [guestThread])).unread_user, false);

  // ao voltar pelo seu link (nova sessão), o convidado continua a ver o pedido
  const again = `gs=${cookies(await post(`/i/${tokenEn}/abrir`, {}, '', '10.9.9.9')).gs}`;
  assert.notEqual(again, guest);
  assert.match((await get('/entrevista/ajuda', again)).body, /My microphone does not work/);
  await post(`/entrevista/ajuda/${guestThread}/responder`, { message: 'It works now, thanks!' }, again, '10.0.0.7');
  assert.equal((await db.one('SELECT status FROM support_threads WHERE id=$1', [guestThread])).status, 'open');
  await post(`/entrevista/ajuda/${guestThread}/fechar`, {}, again);
  assert.equal((await db.one('SELECT status FROM support_threads WHERE id=$1', [guestThread])).status, 'closed');
  assert.match((await get('/entrevista/obrigado', again)).body + (await get('/entrevista', again)).body, /href="\/entrevista\/ajuda"/);
  assert.equal(await nEmails(), emails, 'nenhum email');
});

test('isolamento: cada um só vê os seus pedidos; só o administrador vê a caixa de entrada', async () => {
  const m = await db.one('SELECT count(*)::int n FROM support_messages');
  for (const c of [bruno, gestora]) { // nem outro entrevistador nem a gestora da mesma entidade
    assert.equal((await get(`/ajuda/${anaThread}`, c)).statusCode, 404);
    assert.equal((await post(`/ajuda/${anaThread}/responder`, { message: 'intruso' }, c)).statusCode, 404);
    assert.equal((await post(`/ajuda/${anaThread}/reabrir`, {}, c)).statusCode, 404);
    assert.doesNotMatch((await get('/ajuda', c)).body, /Convite &lt;img/);
    assert.equal((await get('/admin/suporte', c)).statusCode, 403);
    assert.equal((await get(`/admin/suporte/${anaThread}`, c)).statusCode, 403);
    assert.equal((await post(`/admin/suporte/${anaThread}/responder`, { message: 'x' }, c)).statusCode, 403);
  }
  assert.equal((await get(`/ajuda/${guestThread}`, ana)).statusCode, 404, 'o pedido de um convidado não é de nenhum utilizador');
  assert.equal((await get(`/entrevista/ajuda/${guestThread}`, guestPt)).statusCode, 404, 'outro convidado não o vê');
  assert.equal((await post(`/entrevista/ajuda/${guestThread}/reabrir`, {}, guestPt)).statusCode, 404);
  assert.doesNotMatch((await get('/entrevista/ajuda', guestPt)).body, /microphone/);
  assert.equal((await get(`/entrevista/ajuda/${anaThread}`, guest)).statusCode, 404);
  assert.equal((await get(`/ajuda/${anaThread}`, guest)).headers.location, '/entrar', 'a sessão de convidado não abre as páginas do utilizador');
  assert.equal((await get('/entrevista/ajuda', ana)).headers.location, '/', 'nem a do utilizador as do convidado');
  assert.equal((await get('/ajuda')).headers.location, '/entrar');
  assert.equal((await get('/admin/suporte')).headers.location, '/entrar');
  assert.equal((await get('/ajuda/nao-e-um-uuid', ana)).statusCode, 404);
  assert.equal((await get('/admin/suporte/00000000-0000-0000-0000-000000000000', admin)).statusCode, 404);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM support_messages')).n), m.n, 'nada foi escrito');
  // o administrador não abre pedidos a si próprio: a página de ajuda leva-o à caixa de entrada
  assert.match((await get('/ajuda', admin)).body, /href="\/admin\/suporte">Suporte</);
  assert.equal((await post('/ajuda', { message: 'teste' }, admin)).headers.location, '/admin/suporte');
});

test('limites: mensagem vazia ou longa demais, 10 mensagens por hora por remetente e 30 por IP', async () => {
  const before = Number((await db.one('SELECT count(*)::int n FROM support_messages')).n);
  const empty = await post('/ajuda', { subject: 'x', message: '   \r\n ' }, bruno, '10.1.0.1');
  assert.equal(empty.statusCode, 422);
  assert.match(empty.body, /Escreva a sua mensagem/);
  const long = await post('/ajuda', { subject: 'Longa', message: 'a'.repeat(5001) }, bruno, '10.1.0.1');
  assert.equal(long.statusCode, 422);
  assert.match(long.body, /mais de 5000 caracteres/);
  assert.match(long.body, /value="Longa"/, 'o texto escrito não se perde');
  const ok = await post('/ajuda', { subject: 'Limite', message: 'b'.repeat(5000) }, bruno, '10.1.0.1');
  assert.equal(ok.statusCode, 302, 'exatamente 5000 caracteres passa');
  const id = threadOf(ok.headers.location as string);
  for (let i = 2; i <= 10; i++) assert.equal((await post(`/ajuda/${id}/responder`, { message: `mensagem ${i}` }, bruno, '10.1.0.1')).statusCode, 302, `mensagem ${i}`);
  const over = await post(`/ajuda/${id}/responder`, { message: 'a décima primeira' }, bruno, '10.1.0.2');
  assert.equal(over.statusCode, 429, 'o limite é do remetente, mesmo noutro IP');
  assert.match(over.body, /muitas mensagens na última hora/);
  assert.match(over.body, /a décima primeira/, 'a mensagem fica no formulário');
  assert.equal((await post('/ajuda', { message: 'novo pedido' }, bruno, '10.1.0.3')).statusCode, 429);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM support_messages')).n), before + 10);

  // por IP: três utilizadores esgotam as 30 mensagens; o quarto, do mesmo IP, é recusado
  const ip = '10.2.0.1';
  for (const [i, who] of ['c1', 'c2', 'c3'].entries()) {
    const c = await newUser(`Pessoa ${i}`, `${who}@example.com`);
    for (let k = 0; k < 10; k++) assert.equal((await post('/ajuda', { message: `pedido ${k}` }, c, ip)).statusCode, 302);
  }
  const fourth = await newUser('Quarta', 'c4@example.com');
  assert.equal((await post('/ajuda', { message: 'pedido' }, fourth, ip)).statusCode, 429);
  assert.equal((await post('/ajuda', { message: 'pedido' }, fourth, '10.2.0.2')).statusCode, 302, 'noutro IP passa');

  // convidado: o mesmo limite por entrevista
  for (let k = 0; k < 10; k++) assert.equal((await post('/entrevista/ajuda', { message: `ajuda ${k}` }, guestPt, '10.3.0.1')).statusCode, 302);
  const g = await post('/entrevista/ajuda', { message: 'ajuda 11' }, guestPt, '10.3.0.2');
  assert.equal(g.statusCode, 429);
  assert.match(g.body, /lang="pt-PT"/);
  assert.match(g.body, /Enviou muitas mensagens/);
  // o administrador recusa respostas vazias ou longas, sem gravar
  const n = Number((await db.one('SELECT count(*)::int n FROM support_messages WHERE thread_id=$1', [id])).n);
  assert.match((await post(`/admin/suporte/${id}/responder`, { message: 'z'.repeat(5001) }, admin)).headers.location as string, /\?e=long$/);
  assert.match((await post(`/admin/suporte/${id}/responder`, { message: '' }, admin)).headers.location as string, /\?e=empty$/);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM support_messages WHERE thread_id=$1', [id])).n), n);
});

test('pedidos apagados com o utilizador ou com a entrevista; assunto e corpo normalizados', async () => {
  const temp = await newUser('Temporário', 'temp@example.com');
  const t1 = threadOf((await post('/ajuda', { message: 'apagar comigo' }, temp, '10.4.0.1')).headers.location as string);
  await db.query(`DELETE FROM users WHERE email='temp@example.com'`);
  assert.equal(await db.one('SELECT 1 FROM support_threads WHERE id=$1', [t1]), undefined);
  assert.equal(await db.one('SELECT 1 FROM support_messages WHERE thread_id=$1', [t1]), undefined);

  const n = Number((await db.one('SELECT count(*)::int n FROM support_threads WHERE interview_id=$1', [ivPt])).n);
  assert.ok(n >= 10);
  await db.query('DELETE FROM interviews WHERE id=$1', [ivPt]);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM support_threads WHERE interview_id=$1', [ivPt])).n), 0);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM support_messages m LEFT JOIN support_threads t ON t.id=m.thread_id WHERE t.id IS NULL')).n), 0, 'sem mensagens órfãs');

  assert.equal(cleanSubject('  Várias\n linhas\t aqui ', ''), 'Várias linhas aqui');
  assert.equal([...cleanSubject('😀'.repeat(200), '')].length, 140, 'cortado por caracteres, sem partir emojis');
  assert.equal(cleanSubject('', '\n'), '—');
  assert.deepEqual(cleanBody('a\u0000b\r\nc\u0007'), { ok: true, text: 'ab\nc' });
});

test('preparação do assistente: um pedido aberto a partir dele guarda a resposta como mensagem do assistente', async () => {
  const u = await db.one(`SELECT id, entity_id FROM users WHERE email='ana@example.com'`);
  const id = await openThread(db, { userId: u.id, entityId: u.entity_id, subject: 'Como convido?', body: 'Como convido o entrevistado?', origin: 'assistant', author: 'user', authorUserId: u.id, lang: 'pt-PT', assistantBody: 'Em «Rever e convidar».' });
  const msgs = await db.query('SELECT author FROM support_messages WHERE thread_id=$1 ORDER BY created_at, id', [id]);
  assert.deepEqual(msgs.map((m: any) => m.author), ['user', 'assistant']);
  const pg = await get(`/ajuda/${id}`, ana);
  assert.ok(pg.body.indexOf('<strong>Você</strong>') < pg.body.indexOf('<strong>Assistente virtual</strong>'));
  assert.match((await get(`/admin/suporte/${id}`, admin)).body, /Origem:<\/strong> Assistente virtual/);
  // o lugar do assistente na página de ajuda fica antes do formulário
  const help = (await get('/ajuda', ana)).body;
  assert.ok(help.indexOf('<h1>Ajuda</h1>') < help.indexOf('id="suporte"') && help.indexOf('id="suporte"') < help.indexOf('id="pedidos"'));
});
