import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Suporte por mensagens internas para visitantes sem conta (formulário /contact → caixa do administrador → link privado)
// e o email pessoal do dono (SUPPORT_EMAIL) fora de tudo o que se vê ou recebe. IA em modo simulado, sem rede.
const SENTINEL = 'dono.pessoal.sentinela@pessoal-teste.pt';
process.env.SUPPORT_EMAIL = SENTINEL;
// Teto global do formulário bem acima do que este ficheiro envia (dezenas de pedidos, alguns com o relógio adiantado):
// os tetos por omissão (30 por hora, 100 por dia) testam-se em contacto-teto.test.ts.
process.env.CONTACT_PER_HOUR = '1000';
process.env.CONTACT_PER_DAY = '1000';
process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { runOne } = await import('../src/jobs.ts');
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox, replyTo } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const { sha256, isEmail } = await import('../src/lib.ts');
const { contactStamp, oneLine, CONTACT_BODY_LIMIT } = await import('../src/support.ts');
const { seller } = await import('../src/legal.ts');
const { S } = await import('../src/settings.ts');
const { config } = await import('../src/config.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any = {}, cookie = '', ip = '10.0.0.1', headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'x-forwarded-for': ip, ...headers } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const msgOf = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const PW = 'uma-palavra-passe-longa';
const count = async (sql: string, p: any[] = []) => Number((await db.one(`SELECT count(*)::int AS n FROM ${sql}`, p)).n);
/** Carimbo de um formulário aberto há 10 s (o tempo mínimo de preenchimento já passou). */
const opened = (ago = 10_000) => contactStamp(Date.now() - ago);
let ipN = 0; // cada envio de um IP próprio, salvo nos testes dos limites
const send = (o: Record<string, any> = {}, ip = `10.50.${Math.floor(++ipN / 250)}.${ipN % 250}`) =>
  post('/contact', { ts: opened(), name: 'Joana Visitante', email: 'joana@exemplo.pt', topic: 'sales', message: 'Quanto custa o plano Pro?', accept: '1', ...o }, '', ip);
const tokenOf = (text: string) => /\/contact\/t\/([A-Za-z0-9_-]{43})/.exec(text)![1];
const mailsTo = (to: string) => db.query(`SELECT * FROM emails WHERE to_email=$1 ORDER BY created_at, id`, [to]);
// (pelo email: no teste dos limites o relógio vai horas à frente, também o do PGlite, e created_at deixa de dar a ordem)
const visitorOf = (email: string) => db.one(`SELECT * FROM support_threads WHERE origin='visitor' AND visitor_email=$1 ORDER BY created_at DESC LIMIT 1`, [email]);

let admin = '', ana = '', joanaToken = '', joanaId = '';
let logins = 0;
const login = async (email: string) => `sid=${cookies(await post('/entrar', { email, password: PW }, '', `10.8.0.${++logins}`)).sid}`;

test('preparação: administrador e uma entrevistadora', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  await post('/admin/utilizadores', { name: 'Ana', email: 'ana@example.com', password: PW, role: 'interviewer' }, admin);
  ana = await login('ana@example.com');
  assert.ok(admin && ana);
});

test('formulário de contacto: página pública em inglês, campos, proteções e ligações no rodapé e na landing', async () => {
  const r = await get('/contact');
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /lang="en"/);
  assert.match(r.body, /<h1>Contact us<\/h1>/);
  for (const f of ['name', 'email', 'message', 'episode']) assert.match(r.body, new RegExp(`name="${f}"`), f);
  assert.match(r.body, /<select id="c-t" name="topic"><option value="sales" >Sales and plans<\/option><option value="interview" >Help with an interview<\/option><option value="episode" >Correction or withdrawal of a published episode<\/option><option value="privacy" >Privacy request<\/option><option value="other" selected>Other<\/option><\/select>/);
  assert.match(r.body, /<div class="hp" aria-hidden="true">[^]*name="website" type="text" tabindex="-1" autocomplete="off"/, 'campo-armadilha fora do ecrã');
  assert.match(r.body, /<input type="hidden" name="ts" value="\d+\.[A-Za-z0-9_-]{43}">/, 'carimbo assinado da hora de abertura');
  assert.match(r.body, /<input type="checkbox" name="accept" value="1" required> <span>I agree that quietinterview uses these details only to answer this request, as described in the <a href="\/privacy">privacy notice<\/a>\.<\/span>/);
  assert.match(r.body, /maxlength="5000"/);
  assert.match(r.body, /lang="pt-PT">Pode escrever em português/);
  // vindo de um episódio: tema e endereço preenchidos
  const ep = await get('/contact?topic=episode&episode=um-episodio');
  assert.match(ep.body, /<option value="episode" selected>/);
  assert.match(ep.body, /name="episode" type="text" maxlength="200" value="http:\/\/test\.local\/e\/um-episodio"/);
  assert.match((await get('/contact?topic=<b>x</b>')).body, /<option value="other" selected>/, 'tema desconhecido: «Other»');
  // quem tem sessão vê o caminho mais direto (a ajuda do portal)
  assert.match((await get('/contact', ana)).body, /<a href="\/ajuda">Help<\/a> answers inside the portal/);
  // rodapé de todas as páginas e landing
  const home = (await get('/')).body;
  assert.match(home, /<footer><div class="wrap"><p>quietinterview · <a href="\/privacy">Privacy<\/a> · <a href="\/contact">Contact<\/a><\/p>/);
  assert.match(home, /<a href="\/contact\?topic=sales">Write to us<\/a>/);
  assert.match((await get('/painel', ana)).body, /<a href="\/contact">Contact<\/a>/);
  // pedidos de outra origem recusados, como em todos os POST
  const n = await count('support_threads');
  assert.equal((await post('/contact', { ts: opened(), name: 'X', email: 'x@exemplo.pt', message: 'x', accept: '1' }, '', '10.1.1.1', { 'sec-fetch-site': 'cross-site' })).statusCode, 403);
  assert.equal((await post('/contact', { ts: opened(), name: 'X', email: 'x@exemplo.pt', message: 'x', accept: '1' }, '', '10.1.1.1', { origin: 'https://outro-site.example' })).statusCode, 403);
  assert.equal(await count('support_threads'), n);
});

test('envio: pedido por ler na caixa do administrador, email só com o link privado e só o hash do token na base', async () => {
  const e0 = await count('emails');
  const r = await send({ name: 'Joana <img src=x onerror=alert(1)>\r\nBcc: intruso@exemplo.pt', email: ' Joana@Exemplo.pt ', topic: 'episode', episode: 'http://test.local/e/nao-existe',
    message: 'Linha 1\r\nLinha 2 <script>alert(1)</script>' });
  assert.equal(r.statusCode, 303);
  assert.equal(r.headers.location, '/contact?ok=sent');
  const ok = await get('/contact?ok=sent');
  assert.match(ok.body, /<h1>Message sent<\/h1>/); assert.match(ok.body, /emailed you a private link/);
  const th = await visitorOf('joana@exemplo.pt');
  joanaId = th.id;
  assert.deepEqual([th.status, th.unread_admin, th.unread_user, th.user_id, th.interview_id, th.entity_id, th.lang, th.topic], ['open', true, false, null, null, null, 'en', 'episode']);
  assert.equal(th.visitor_name, 'Joana <img src=x onerror=alert(1)> Bcc: intruso@exemplo.pt', 'nome numa só linha');
  assert.equal(th.visitor_email, 'joana@exemplo.pt');
  assert.equal(th.episode_ref, 'http://test.local/e/nao-existe');
  assert.equal(th.subject, 'Linha 1');
  assert.match(th.visitor_token_hash, /^[0-9a-f]{64}$/);
  assert.deepEqual((await db.query('SELECT author, body FROM support_messages WHERE thread_id=$1', [th.id])).map((m: any) => [m.author, m.body]), [['visitor', 'Linha 1\nLinha 2 <script>alert(1)</script>']]);

  // um só email, para o visitante, com o link privado e sem nada do que ele escreveu
  assert.equal(await count('emails'), e0 + 1);
  const [m] = await mailsTo('joana@exemplo.pt');
  assert.equal(m.dedupe_key, `contact:${th.id}`);
  assert.equal(m.subject, 'We received your message — quietinterview');
  assert.doesNotMatch(m.subject, /[\r\n]/);
  joanaToken = tokenOf(m.text_body);
  assert.equal(sha256(joanaToken), th.visitor_token_hash, 'na base, só o hash do token');
  assert.ok(m.html.includes(`href="http://test.local/contact/t/${joanaToken}"`));
  assert.doesNotMatch(m.subject + m.html + m.text_body, /Joana|Linha|script|alert|Bcc|intruso|nao-existe/, 'nada escrito pelo visitante');
  assert.match(m.html, /href="http:\/\/test\.local\/contact" style="color:#b4691f">Contact us<\/a>/, 'rodapé com o formulário de contacto');
  assert.ok(!JSON.stringify(await db.query('SELECT * FROM support_threads')).includes(joanaToken), 'o token não fica na base');
  const audit = JSON.stringify(await db.query(`SELECT actor, meta FROM audit_events WHERE action='support.thread_opened'`));
  assert.match(audit, /"via":"contact"/); assert.doesNotMatch(audit, /joana|Linha/i, 'a auditoria não guarda nome, email nem texto');

  // administrador: contador, caixa de entrada (com o filtro dos visitantes) e o pedido, tudo escapado
  assert.match((await get('/painel', admin)).body, /<a href="\/admin\/suporte">Suporte <span class="badge" aria-hidden="true">1<\/span>/);
  const inbox = (await get('/admin/suporte', admin)).body;
  assert.match(inbox, /Visitante: Joana &lt;img src=x onerror=alert\(1\)&gt; Bcc: intruso@exemplo\.pt<br><span class="hint">joana@exemplo\.pt<\/span>/);
  assert.match(inbox, /<span class="hint">Correção ou retirada de um episódio publicado<\/span>/);
  assert.match(inbox, /<td>Formulário de contacto \(visitante\)<\/td>/);
  assert.match(inbox, />Visitantes \(1\)<\/a>/);
  assert.doesNotMatch(inbox, /<img src=x/);
  assert.match((await get('/admin/suporte?estado=visitor', admin)).body, /aria-current="page">Visitantes \(1\)/);
  const at = (await get(`/admin/suporte/${th.id}`, admin)).body;
  assert.match(at, /<strong>Visitante:<\/strong> Joana &lt;img src=x onerror=alert\(1\)&gt; Bcc: intruso@exemplo\.pt &lt;joana@exemplo\.pt&gt;<br>/);
  assert.match(at, /<strong>Tema:<\/strong> Correção ou retirada de um episódio publicado · <strong>Episódio indicado:<\/strong> «http:\/\/test\.local\/e\/nao-existe» \(não corresponde a nenhum episódio\)/);
  assert.match(at, /<strong>Origem:<\/strong> Formulário de contacto \(visitante\)/);
  assert.match(at, /<p class="msgbody">Linha 1\nLinha 2 &lt;script&gt;alert\(1\)&lt;\/script&gt;<\/p>/);
  assert.match(at, /<strong>Visitante \(Joana &lt;img/);
  assert.doesNotMatch(at, /<script>alert|<img src=x/);
  assert.match(at, /O email não foi verificado/);
  assert.match(at, /action="\/admin\/suporte\/[0-9a-f-]{36}\/apagar" onsubmit="return confirm\(/);
  assert.match(at, /é-lhe enviado um email curto \(«You have a reply»\) com o link, sem o texto da resposta/);
  assert.equal((await db.one('SELECT unread_admin FROM support_threads WHERE id=$1', [th.id])).unread_admin, false, 'lido ao abrir');
});

test('proteções: campo-armadilha, tempo mínimo, carimbo, aceitação obrigatória e campos; nenhuma recusa grava ou envia', async () => {
  const t0 = await count('support_threads'), e0 = await count('emails');
  // robô: o campo escondido preenchido parece ter corrido bem, mas nada é gravado
  const hp = await send({ website: 'http://spam.example' });
  assert.equal(hp.statusCode, 303); assert.equal(hp.headers.location, '/contact?ok=sent');
  // enviado logo depois de abrir: recusado, com o texto e o mesmo carimbo (quem corrige não espera de novo)
  const fresh = contactStamp();
  const fast = await send({ ts: fresh, message: 'Escrevi muito depressa.' });
  assert.equal(fast.statusCode, 422);
  assert.match(fast.body, /That was very quick/);
  assert.match(fast.body, /Escrevi muito depressa\./); assert.match(fast.body, /value="Joana Visitante"/);
  assert.ok(fast.body.includes(`name="ts" value="${fresh}"`));
  // carimbo forjado, em falta ou com mais de 24 horas
  for (const ts of [`${Date.now() - 60_000}.${'A'.repeat(43)}`, '', 'abc', contactStamp(Date.now() - 25 * 3600_000), contactStamp(Date.now() + 3600_000)]) {
    const r = await send({ ts });
    assert.equal(r.statusCode, 422, ts); assert.match(r.body, /This form has expired/);
    assert.doesNotMatch(r.body, new RegExp(`value="${ts || 'x^'}"`), 'um carimbo inválido não volta ao formulário');
  }
  const noAccept = await send({ accept: '' });
  assert.equal(noAccept.statusCode, 422); assert.match(noAccept.body, /Please tick the box/);
  assert.match(noAccept.body, /<input type="checkbox" name="accept" value="1" required>/, 'a caixa volta por assinalar');
  for (const [o, re] of [
    [{ email: 'nao-e-email' }, /valid email address/], [{ email: 'a@b.pt\r\nBcc: c@d.pt' }, /valid email address/], [{ email: '' }, /valid email address/],
    [{ name: ' \r\n ' }, /Please write your name/], [{ message: '  \n ' }, /Please write your message/], [{ message: 'a'.repeat(5001) }, /longer than 5000 characters/],
  ] as const) {
    const r = await send(o);
    assert.equal(r.statusCode, 422, JSON.stringify(o).slice(0, 60)); assert.match(r.body, re);
  }
  assert.equal(await count('support_threads'), t0, 'nada gravado');
  assert.equal(await count('emails'), e0, 'nada enviado');
  // limites de tamanho: nome e referência cortados numa linha; 5000 caracteres de mensagem passam
  assert.equal((await send({ email: 'longo@exemplo.pt', name: 'N'.repeat(150), episode: 'E'.repeat(300), message: 'm'.repeat(5000) })).statusCode, 303);
  const th = await visitorOf('longo@exemplo.pt');
  assert.equal(th.visitor_name.length, 100); assert.equal(th.episode_ref.length, 200);
});

test('tamanho: campos de vários MB cortados sem custo, corpo acima de 64 KB recusado (413), email enorme recusado logo', async () => {
  const t0 = await count('support_threads'), e0 = await count('emails');
  const ms = (t: number) => `${Math.round(performance.now() - t)} ms`;
  // nome e referência de vários MB: cortados antes de qualquer tratamento (espalhar a cadeia inteira por caracteres
  // custava centenas de MB de memória a um pedido anónimo, antes do campo-armadilha e do carimbo; 32 MB, 200 ms e 270 MB)
  const MB = 1024 * 1024, names = 'N'.repeat(32 * MB), refs = ` \r\n${'É'.repeat(8 * MB)}`, faces = '😀'.repeat(4 * MB);
  let t = performance.now();
  assert.equal(oneLine(names, 100), 'N'.repeat(100));
  assert.equal(oneLine(refs, 200), 'É'.repeat(200));
  assert.equal(oneLine(faces, 3), '😀😀😀', 'cortado por caracteres');
  assert.ok(performance.now() - t < 100, `oneLine: ${ms(t)}`);
  assert.equal(oneLine(' '.repeat(27) + '😀', 3), '', 'o corte em bruto não deixa meio emoji');
  // pelo formulário: o corpo passa do limite da rota e é recusado antes de ser lido; o mesmo no link privado
  t = performance.now();
  assert.equal((await send({ name: 'N'.repeat(3 * 1024 * 1024), episode: 'E'.repeat(3 * 1024 * 1024) })).statusCode, 413);
  assert.ok(performance.now() - t < 1000, `413: ${ms(t)}`);
  assert.equal((await post(`/contact/t/${joanaToken}/responder`, { message: 'x'.repeat(CONTACT_BODY_LIMIT) })).statusCode, 413);
  // logo abaixo do limite: o nome e a referência voltam ao formulário cortados (200 caracteres cada)
  const near = await send({ name: 'N'.repeat(60_000), episode: 'E'.repeat(2000), accept: '' });
  assert.equal(near.statusCode, 422); assert.match(near.body, /Please tick the box/);
  assert.ok(near.body.includes(`value="${'N'.repeat(200)}"`) && !near.body.includes('N'.repeat(201)), 'nome cortado');
  assert.ok(near.body.includes(`value="${'E'.repeat(200)}"`) && !near.body.includes('E'.repeat(201)), 'referência cortada');
  // o maior envio legítimo cabe: 5000 caracteres de mensagem com 3 bytes cada em UTF-8 (9 no formulário)
  const max = { email: 'maximo@exemplo.pt', name: 'Ç'.repeat(100), episode: '界'.repeat(200), message: '界'.repeat(5000) };
  const size = form({ ts: opened(), topic: 'sales', accept: '1', ...max }).length;
  assert.ok(size > 45_000 && size < CONTACT_BODY_LIMIT, `${size} bytes`);
  assert.equal((await send(max)).statusCode, 303);
  assert.equal((await visitorOf('maximo@exemplo.pt')).visitor_name, 'Ç'.repeat(100));

  // email enorme: o comprimento confere-se antes da expressão (o retrocesso dela crescia com o quadrado do tamanho)
  const evil = (n: number) => 'a@' + '.a'.repeat(n) + '@';
  const e100 = evil(50_000); // 100 KB
  t = performance.now();
  assert.equal(isEmail(e100), false);
  assert.ok(performance.now() - t < 50, `isEmail: ${ms(t)}`);
  assert.equal(isEmail(`${'a'.repeat(64)}@${'b'.repeat(186)}.pt`), true, '254 caracteres passam');
  assert.equal(isEmail(`${'a'.repeat(64)}@${'b'.repeat(187)}.pt`), false, '255 não');
  t = performance.now();
  const r = await send({ email: evil(30_000) }); // 60 KB, dentro do limite da rota
  assert.equal(r.statusCode, 422); assert.match(r.body, /valid email address/);
  assert.ok(performance.now() - t < 500, `/contact: ${ms(t)}`);
  assert.ok(r.body.includes(`value="${evil(30_000).slice(0, 300)}"`) && !r.body.includes('.a'.repeat(150)), 'volta cortado a 300 caracteres');
  // o /registar (aberto por omissão) tinha o mesmo defeito
  t = performance.now();
  const reg = await post('/registar', { name: 'Robô', email: e100, password: PW, terms: 1 }, '', '10.70.0.1');
  assert.equal(reg.statusCode, 302); assert.match(msgOf(reg), /Please complete all fields/);
  assert.ok(performance.now() - t < 500, `/registar: ${ms(t)}`);

  assert.equal(await count('support_threads'), t0 + 1, 'só o envio legítimo foi gravado');
  assert.equal(await count('emails'), e0 + 1, 'e só ele mandou o email com o link');
});

test('limites: 3 pedidos novos por hora e 10 por dia por email; 10 por hora por IP; as recusas não gastam o limite', async () => {
  const t0 = await count('support_threads');
  for (let k = 0; k < 3; k++) assert.equal((await send({ email: 'limite@exemplo.pt' })).statusCode, 303, `pedido ${k + 1}`);
  const over = await send({ email: 'LIMITE@exemplo.pt', message: 'o quarto' });
  assert.equal(over.statusCode, 429, 'o limite é do email (sem distinguir maiúsculas), mesmo noutro IP');
  assert.match(over.body, /Too many messages/); assert.match(over.body, /o quarto/);
  // as horas seguintes (relógio adiantado): mais 3 por hora, até 10 no dia
  const real = Date.now;
  try {
    for (let h = 1; h <= 3; h++) {
      Date.now = () => real() + h * 3600_000 + 1000;
      const allowed = h < 3 ? 3 : 1;
      for (let k = 0; k < allowed; k++) assert.equal((await send({ email: 'limite@exemplo.pt' })).statusCode, 303, `hora ${h}, pedido ${k + 1}`);
      assert.equal((await send({ email: 'limite@exemplo.pt' })).statusCode, 429, `hora ${h}: no limite`);
    }
  } finally { Date.now = real; }
  assert.equal(await count('support_threads'), t0 + 10, '10 no dia');
  // por IP: 10 emails diferentes; o 11.º do mesmo IP é recusado, e a recusa não gasta o limite do email
  const ip = '10.60.0.1';
  for (let k = 0; k < 10; k++) assert.equal((await send({ email: `pessoa${k}@exemplo.pt` }, ip)).statusCode, 303);
  assert.equal((await send({ email: 'onze@exemplo.pt' }, ip)).statusCode, 429);
  for (let k = 0; k < 3; k++) assert.equal((await send({ email: 'onze@exemplo.pt' }, `10.61.0.${k}`)).statusCode, 303, 'noutro IP passa');
  assert.equal(await count('support_threads'), t0 + 23);
});

test('link privado: acesso certo e errado, resposta do visitante, resposta do administrador com aviso por email, fechado só de leitura e apagado', async () => {
  assert.equal((await send({ name: 'Rita Leitora', email: 'rita@exemplo.pt', topic: 'privacy', message: 'Quero saber que dados têm sobre mim.' })).statusCode, 303);
  const th = await visitorOf('rita@exemplo.pt');
  const token = tokenOf((await mailsTo('rita@exemplo.pt'))[0].text_body);
  const base = `/contact/t/${token}`;
  const pg = await get(base);
  assert.equal(pg.statusCode, 200);
  assert.match(pg.body, /Quero saber que dados têm sobre mim\./);
  assert.match(pg.body, /<strong>You<\/strong>/);
  assert.match(pg.body, /Private conversation with the quietinterview team · Privacy request/);
  assert.match(pg.body, /<meta name="robots" content="noindex,nofollow"><meta name="referrer" content="same-origin">/);
  assert.equal(pg.headers['cache-control'], 'no-store');
  assert.doesNotMatch(pg.body, /rita@exemplo\.pt|Rita Leitora/, 'o link não mostra o email nem o nome');
  assert.match(pg.body, new RegExp(`action="/contact/t/${token}/responder"`));
  // tokens errados: outro qualquer, malformado, com um carácter trocado; o de outro visitante só abre o pedido dele
  const other = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
  for (const t of [other, 'abc', 'A'.repeat(43), `${token}x`]) {
    const r = await get(`/contact/t/${t}`);
    assert.equal(r.statusCode, 404, t); assert.match(r.body, /This link is not valid/);
  }
  assert.equal((await post(`/contact/t/${other}/responder`, { message: 'intruso' })).statusCode, 404);
  const joana = await get(`/contact/t/${joanaToken}`);
  assert.match(joana.body, /Linha 2 &lt;script&gt;/); assert.doesNotMatch(joana.body, /Quero saber/);

  // o visitante responde pelo link: o pedido volta a «por ler» para o administrador
  assert.equal((await post(`${base}/responder`, { message: '   ' })).statusCode, 422);
  const vr = await post(`${base}/responder`, { message: 'Acrescento: o meu nome é Rita.' });
  assert.equal(vr.statusCode, 303); assert.equal(vr.headers.location, `${base}?ok=reply`);
  assert.match((await get(`${base}?ok=reply`)).body, /Message sent\./);
  let t1 = await db.one('SELECT * FROM support_threads WHERE id=$1', [th.id]);
  assert.deepEqual([t1.status, t1.unread_admin], ['open', true]);
  assert.deepEqual((await db.query('SELECT author FROM support_messages WHERE thread_id=$1 ORDER BY created_at, id', [th.id])).map((m: any) => m.author), ['visitor', 'visitor']);

  // o administrador responde: o visitante recebe um email curto com o mesmo link, sem o texto da resposta
  const n0 = (await mailsTo('rita@exemplo.pt')).length;
  const ar = await post(`/admin/suporte/${th.id}/responder`, { message: 'Olá Rita, a resposta secreta é 4321.' }, admin);
  assert.match(ar.headers.location as string, /\?ok=reply$/);
  const mails = await mailsTo('rita@exemplo.pt');
  assert.equal(mails.length, n0 + 1);
  const m = mails[mails.length - 1];
  assert.match(m.dedupe_key, new RegExp(`^contact-reply:${th.id}:[0-9a-f-]{36}$`));
  assert.equal(m.subject, 'You have a reply — quietinterview');
  assert.equal(tokenOf(m.text_body), token, 'o mesmo link');
  assert.doesNotMatch(m.html + m.text_body, /secreta|4321|Rita/, 'sem o texto da resposta');
  t1 = await db.one('SELECT * FROM support_threads WHERE id=$1', [th.id]);
  assert.deepEqual([t1.status, t1.unread_user], ['answered', true]);
  const seen = await get(base);
  assert.match(seen.body, /<strong>Support<\/strong>/); assert.match(seen.body, /a resposta secreta é 4321/);
  assert.equal((await db.one('SELECT unread_user FROM support_threads WHERE id=$1', [th.id])).unread_user, false, 'lida');

  // utilizadores e convidados continuam sem email
  const ua = await post('/ajuda', { message: 'Dúvida da Ana' }, ana, '10.70.0.1');
  const uid = /\/ajuda\/([0-9a-f-]{36})/.exec(ua.headers.location as string)![1];
  const e1 = await count('emails');
  await post(`/admin/suporte/${uid}/responder`, { message: 'Resposta à Ana' }, admin);
  assert.equal(await count('emails'), e1, 'resposta a um utilizador: nenhum email');

  // fechado: só de leitura para o visitante; reabrir volta a deixar escrever
  await post(`/admin/suporte/${th.id}/fechar`, {}, admin);
  const closed = await get(base);
  assert.match(closed.body, /This request is closed\. If you need more help, send a new message through the <a href="\/contact">contact form<\/a>/);
  assert.doesNotMatch(closed.body, /\/responder"/);
  const nm = await count('support_messages WHERE thread_id=$1', [th.id]);
  const late = await post(`${base}/responder`, { message: 'Mais uma coisa' });
  assert.equal(late.statusCode, 303); assert.equal(late.headers.location, `${base}?e=closed`);
  assert.match((await get(`${base}?e=closed`)).body, /This request is closed\./);
  assert.equal(await count('support_messages WHERE thread_id=$1', [th.id]), nm);
  await post(`/admin/suporte/${th.id}/reabrir`, {}, admin);
  assert.match((await get(base)).body, /\/responder"/);

  // apagar: só o administrador e só pedidos de visitantes; o link deixa de funcionar e os emails do pedido desaparecem
  assert.equal((await post(`/admin/suporte/${th.id}/apagar`, {}, ana)).statusCode, 403);
  assert.equal((await post(`/admin/suporte/${uid}/apagar`, {}, admin)).statusCode, 400);
  assert.ok(await db.one('SELECT 1 FROM support_threads WHERE id=$1', [uid]), 'o pedido da Ana fica');
  const del = await post(`/admin/suporte/${th.id}/apagar`, {}, admin);
  assert.equal(del.headers.location, '/admin/suporte?ok=deleted');
  assert.match((await get('/admin/suporte?ok=deleted', admin)).body, /Pedido apagado\./);
  assert.equal(await db.one('SELECT 1 FROM support_threads WHERE id=$1', [th.id]), undefined);
  assert.equal(await count('support_messages WHERE thread_id=$1', [th.id]), 0);
  assert.equal((await mailsTo('rita@exemplo.pt')).length, 0, 'os emails do pedido também');
  assert.equal((await get(base)).statusCode, 404);
  assert.equal((await post(`${base}/responder`, { message: 'ainda aqui?' })).statusCode, 404);
  assert.ok(await db.one('SELECT 1 FROM support_threads WHERE id=$1', [joanaId]), 'os outros pedidos ficam');
});

// ---------- o SUPPORT_EMAIL fora de tudo o que se vê: páginas, emails e a vendedora ----------
const tokenOfInvite = (text: string) => /\/i\/([A-Za-z0-9_-]{40,})/.exec(text)![1];
const inviteMails = (id: string) => db.query(`SELECT * FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC`, [id]);
const guestOf = async (token: string) => `gs=${cookies(await post(`/i/${token}/abrir`, {}, '', '10.9.9.9')).gs}`;
const interview = async (title: string, lang: 'en' | 'pt-PT', policy = 'guest_preview') => {
  const c = await post('/entrevistas', { title }, admin);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Qual foi o maior desafio?' }, admin);
  await post(`/entrevistas/${id}/guardar`, { title, objective_text: 'Objetivo', host_name: 'Admin', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: lang, review_policy: policy, subtitle_langs: 'en' }, admin);
  assert.match(msgOf(await post(`/entrevistas/${id}/convidar`, {}, admin)), /ok=/);
  await flushOutbox(db);
  const token = tokenOfInvite((await inviteMails(id))[0].text_body);
  seen.push([`/i/… (${title})`, (await get(`/i/${token}`)).body]);
  return { id, guest: await guestOf(token) };
};

/** Páginas do convidado vistas enquanto valiam (o link seguinte revoga o anterior): a sentinela verifica-as no fim. */
const seen: [string, string][] = [];
const keep = async (label: string, url: string, cookie: string) => { const r = await get(url, cookie); assert.equal(r.statusCode, 200, label); seen.push([label, r.body]); return r.body; };
let slug = '';
test('episódio publicado: correções pelo formulário de contacto na página pública e na do convidado; o administrador abre o episódio', async () => {
  const { id, guest } = await interview('Pescadores da Nazaré', 'en');
  assert.match(await keep('/entrevista (consentimentos)', '/entrevista', guest), /<p class="hint">Questions or corrections\? <a href="\/entrevista\/ajuda">Contact support<\/a><\/p>/);
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, guest);
  await keep('/entrevista', '/entrevista', guest);
  const q = await db.one('SELECT id FROM questions WHERE interview_id=$1', [id]);
  assert.equal((await app.inject({ method: 'POST', url: `/api/g/respostas/${q.id}`, payload: makeToneWav(2), headers: { 'content-type': 'audio/wav', cookie: guest } })).statusCode, 200);
  const gt = /\/entrevista\/ajuda\/([0-9a-f-]{36})/.exec((await post('/entrevista/ajuda', { message: 'Uma dúvida do convidado.' }, guest, '10.71.0.1')).headers.location as string)![1];
  await post(`/admin/suporte/${gt}/responder`, { message: 'Resposta ao convidado.' }, admin);
  await keep('/entrevista/ajuda', '/entrevista/ajuda', guest);
  await keep('/entrevista/ajuda/:id', `/entrevista/ajuda/${gt}`, guest);
  await post('/entrevista/submeter', {}, guest);
  assert.match(await keep('/entrevista/obrigado', '/entrevista/obrigado', guest), /Questions or corrections\? <a href="\/entrevista\/ajuda">Contact support<\/a>/);
  await post(`/entrevistas/${id}/processar`, {}, admin); await drain();
  await post(`/entrevistas/${id}/guiao/aprovar`, { reviewed: '1' }, admin);
  await post(`/entrevistas/${id}/gerar`, { subtitle_langs: 'en' }, admin); await drain();
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND status='preview' AND NOT stale`, [id]);
  assert.ok(ep, 'episódio gerado');
  await post(`/entrevistas/${id}/episodio/${ep.id}/aprovar`, { video: '' }, admin);
  await post(`/entrevistas/${id}/episodio/${ep.id}/enviar-previa`, {}, admin);
  await flushOutbox(db);
  const pv = await guestOf(tokenOfInvite((await inviteMails(id))[0].text_body));
  await post('/entrevista/episodio/decisao', { decision: 'approved', video: '', episode: ep.id, audio: ep.audio_asset_id }, pv);
  assert.match(msgOf(await post(`/entrevistas/${id}/episodio/${ep.id}/publicar`, { visibility: 'public', gallery: '1' }, admin)), /Publicado/);
  slug = ep.slug;
  const pub = (await get(`/e/${slug}`)).body;
  assert.ok(pub.includes(`To ask for a correction or the withdrawal of this episode, use the <a href="/contact?topic=episode&amp;episode=${slug}">contact form</a>.`));
  const view = await keep('/entrevista/episodio (publicado)', '/entrevista/episodio', pv);
  assert.match(view, /Published on \d{1,2} \w+ \d{4}\. <a href="\/contact\?topic=episode&amp;episode=[a-z0-9-]+">Ask for a correction or the withdrawal of the episode<\/a>/);
  // pelo formulário, com o endereço do episódio: o administrador vê a entrevista e a página pública
  const form = await get(`/contact?topic=episode&episode=${slug}`);
  assert.ok(form.body.includes(`value="http://test.local/e/${slug}"`));
  assert.equal((await send({ name: 'Rui', email: 'rui.visitante@exemplo.pt', topic: 'episode', episode: `http://test.local/e/${slug}`, message: 'Corrijam o meu apelido, por favor.' })).statusCode, 303);
  const th = await visitorOf('rui.visitante@exemplo.pt');
  const at = (await get(`/admin/suporte/${th.id}`, admin)).body;
  assert.ok(at.includes(`→ <a href="/entrevistas/${id}">Pescadores da Nazaré</a> (episódio «`), 'liga à entrevista');
  assert.ok(at.includes(`<a href="/e/${slug}">página pública</a>`));
});

test('sentinela: o SUPPORT_EMAIL não aparece em nenhuma página nem em nenhum email; Reply-To e vendedora sem ele', async () => {
  assert.equal(config.supportEmail, SENTINEL, 'a configuração interna continua a existir, com o valor da sentinela');
  // convidado cujo convite deixou de valer (entrevista cancelada): ajuda só de leitura, com o formulário de contacto
  const { id, guest } = await interview('Entrevista a cancelar', 'pt-PT');
  const tid = /\/entrevista\/ajuda\/([0-9a-f-]{36})/.exec((await post('/entrevista/ajuda', { message: 'Apaguem os meus dados.' }, guest, '10.72.0.1')).headers.location as string)![1];
  await post(`/entrevistas/${id}/cancelar`, {}, admin);
  await post(`/admin/suporte/${tid}/responder`, { message: 'Apagados.' }, admin);
  assert.match(await keep('/entrevista/ajuda (só leitura)', '/entrevista/ajuda', guest), /contacte quem o convidou ou use o <a href="\/contact">formulário de contacto<\/a>\./);
  assert.match(await keep('/entrevista/ajuda/:id (só leitura)', `/entrevista/ajuda/${tid}`, guest), /use o <a href="\/contact">formulário de contacto<\/a>/);

  const anaThread = (await db.one(`SELECT t.id FROM support_threads t JOIN users u ON u.id=t.user_id WHERE u.email='ana@example.com' LIMIT 1`)).id;
  const vis = await visitorOf('rui.visitante@exemplo.pt');
  await post(`/admin/suporte/${vis.id}/responder`, { message: 'Já corrigimos o apelido.' }, admin); // aviso «You have a reply»
  const vtoken = tokenOf((await mailsTo(vis.visitor_email))[0].text_body);
  for (const [label, body] of seen) assert.ok(!body.toLowerCase().includes(SENTINEL), `${label} mostra o SUPPORT_EMAIL`);
  assert.ok(seen.length >= 9, `${seen.length} páginas do convidado`);
  const all: [string, string][] = [
    ['/', ''], ['/termos', ''], ['/privacidade-pagamentos', ''], ['/privacy', ''], ['/podcasts', ''], [`/e/${slug}`, ''], ['/contact', ''], ['/contact?ok=sent', ''], [`/contact/t/${vtoken}`, ''],
    ['/entrar', ''], ['/registar', ''],
    ['/ajuda', ana], [`/ajuda/${anaThread}`, ana], ['/painel', ana], ['/account', ana], ['/conta/creditos', ana], ['/contact', ana], ['/privacy', ana], ['/privacidade-pagamentos', ana],
    ['/painel', admin], ['/admin/definicoes', admin], ['/admin/suporte', admin], [`/admin/suporte/${vis.id}`, admin], [`/admin/suporte/${tid}`, admin], ['/admin/faturacao', admin], ['/ajuda', admin],
  ];
  for (const [url, c] of all) {
    const r = await get(url, c);
    assert.equal(r.statusCode, 200, url);
    assert.ok(!r.body.toLowerCase().includes(SENTINEL), `${url} mostra o SUPPORT_EMAIL`);
  }
  assert.match((await get('/podcasts')).body, new RegExp(`href="/e/${slug}"`), 'a galeria tem o episódio');
  // todos os emails gerados neste ficheiro: convites, pré-visualização, entrevista concluída, contacto, respostas
  await drain();
  const mails = await db.query('SELECT dedupe_key, subject, html, text_body FROM emails');
  assert.ok(mails.length >= 20, `${mails.length} emails`);
  for (const k of ['invite:', 'submitted:', 'contact:', 'contact-reply:']) assert.ok(mails.some((m: any) => m.dedupe_key.startsWith(k)), k);
  for (const m of mails) assert.ok(!`${m.subject}\n${m.html}\n${m.text_body}`.toLowerCase().includes(SENTINEL), `email ${m.dedupe_key} com o SUPPORT_EMAIL`);
  const done = mails.find((m: any) => m.dedupe_key.startsWith('submitted:'));
  assert.match(done.html, /quietinterview · <a href="http:\/\/test\.local\/contact" style="color:#b4691f">Contacto<\/a> · <a href="http:\/\/test\.local\/privacy" style="color:#b4691f">Privacidade<\/a><\/p>/, 'rodapé por omissão: o formulário de contacto e a privacidade');
  const inv = mails.find((m: any) => m.dedupe_key.startsWith('invite:') && /Pescadores/.test(m.subject));
  assert.match(inv.text_body, /Need help\? Open your personal link and use the “Help” page: the portal team replies there\./);
  // os convites têm rodapé próprio, também com a página de privacidade (no HTML e no texto)
  assert.match(inv.html, /<a href="http:\/\/test\.local\/privacy" style="color:#b4691f">Privacy<\/a><\/p>/);
  assert.match(inv.text_body, /\nPrivacy: http:\/\/test\.local\/privacy$/);
  for (const m of mails) assert.ok(m.html.includes('http://test.local/privacy'), `email ${m.dedupe_key} sem a ligação à privacidade`);
  assert.equal(replyTo(), 'certifinternational@gmail.com', 'Reply-To: o email da entidade gestora');

  // vendedora: sem email definido, o da entidade gestora, com aviso nas Definições
  assert.equal(seller().email, 'certifinternational@gmail.com');
  assert.match((await get('/termos')).body, /Contacto: <a href="mailto:certifinternational@gmail\.com">/);
  const warn = /Empresa vendedora \(definições globais\): o email de contacto da vendedora não está definido e usa-se o da entidade gestora \(certifinternational@gmail\.com\)/;
  assert.match((await get('/admin/definicoes', admin)).body, warn);
  assert.match((await get('/admin/faturacao', admin)).body, warn);
  // um SELLER_EMAIL igual ao SUPPORT_EMAIL (a omissão antiga, gravada pelo formulário) é ignorado em todo o lado
  process.env.SELLER_EMAIL = SENTINEL;
  try {
    assert.equal(seller().email, 'certifinternational@gmail.com');
    for (const url of ['/termos', '/privacidade-pagamentos', '/privacy', '/account', '/conta/creditos']) assert.ok(!(await get(url, ana)).body.toLowerCase().includes(SENTINEL), url);
    const def = (await get('/admin/definicoes', admin)).body;
    assert.ok(!def.toLowerCase().includes(SENTINEL), 'nem no formulário das Definições');
    assert.match(def, /o que estava guardado era o email de apoio interno, que não se mostra ao público/);
    assert.match(def, /<input id="f_SELLER_EMAIL" name="SELLER_EMAIL"[^>]+value="certifinternational@gmail\.com">/);
  } finally { delete process.env.SELLER_EMAIL; }
  // e não se pode voltar a gravar
  const bad = await post('/admin/definicoes', { SELLER_EMAIL: SENTINEL.toUpperCase() }, admin);
  assert.match(msgOf(bad), /Nada foi guardado: O email de apoio interno \(SUPPORT_EMAIL\) não se mostra ao público/);
  assert.equal(S('SELLER_EMAIL'), '');
  // com o email da vendedora definido, o aviso desaparece
  await post('/admin/definicoes', { SELLER_EMAIL: 'vendas@telecert.pt', signups_open: '1' }, admin);
  assert.equal(seller().email, 'vendas@telecert.pt');
  assert.doesNotMatch((await get('/admin/definicoes', admin)).body, /o email de contacto da vendedora não está definido/);
  assert.match((await get('/termos')).body, /mailto:vendas@telecert\.pt/);
});

test('sentinela: emails da fila com o rodapé antigo saem sem o SUPPORT_EMAIL; guardar as Definições só repõe os falhados das últimas 48 h', async () => {
  // como a 727855d os gerava: rodapé por omissão «marca · SUPPORT_EMAIL» (HTML) e, nos convites, «Dúvidas: …» ou
  // «Need help? …» (HTML e texto)
  const html = (help: string) => `<p>Convite</p><p style="font-size:14px;color:#6b655c">Se não quiser participar, abra o link. ${help} ${SENTINEL}</p>
<p style="font:13px Arial,sans-serif;color:#6b655c;margin-top:32px">${config.brand} · ${SENTINEL}</p>`;
  const text = (help: string) => `Convite\n\nSe não quiser participar, abra o link.\n${help} ${SENTINEL}\n\n${config.brand} — entrevistas gravadas no seu tempo · test.local`;
  const old = (key: string, help: string, state: string, attempts: number, age: string) =>
    db.query(`INSERT INTO emails(dedupe_key, to_email, subject, html, text_body, state, attempts, next_attempt_at, created_at)
      VALUES ($1,$2,'Convite antigo',$3,$4,$5,$6, now(), now() - $7::interval)`, [`antigo:${key}`, `${key}@exemplo.org`, html(help), text(help), state, attempts, age]);
  await old('pendente', 'Dúvidas:', 'pending', 0, '3 days');
  await old('falhado', 'Need help?', 'failed', 2, '1 hour');
  await old('esgotado-recente', 'Dúvidas:', 'failed', 6, '47 hours');
  await old('esgotado-antigo', 'Dúvidas:', 'failed', 6, '30 days');
  // um email ao próprio dono com o endereço dele fora destes padrões: sai como está
  const own = { html: `<p>A sua conta: ${SENTINEL}</p>`, text: `A sua conta: ${SENTINEL}` };
  await db.query(`INSERT INTO emails(dedupe_key, to_email, subject, html, text_body) VALUES ('antigo:ao-dono',$1,'A sua conta',$2,$3)`, [SENTINEL, own.html, own.text]);
  const sent: any[] = [], realFetch = globalThis.fetch;
  const to = (key: string) => sent.filter(b => b.to[0].email === `${key}@exemplo.org`);
  const row = (key: string) => db.one(`SELECT state, attempts, html, text_body FROM emails WHERE dedupe_key=$1`, [`antigo:${key}`]);
  process.env.MAILERSEND_API_KEY = 'chave-falsa-dos-testes'; // nunca sai daqui: o fetch é substituído
  globalThis.fetch = (async (_u: any, init: any) => {
    sent.push(JSON.parse(init.body));
    return new Response('', { status: 202, headers: { 'x-message-id': `m${sent.length}` } });
  }) as any;
  try {
    await flushOutbox(db);
    const footer = `${config.brand} · <a href="http://test.local/contact" style="color:#b4691f">Contacto</a> · <a href="http://test.local/privacy" style="color:#b4691f">Privacidade</a></p>`;
    for (const [key, help] of [['pendente', 'Dúvidas? Abra o seu link pessoal e use a página «Ajuda»: a equipa do portal responde lá.'],
      ['falhado', 'Need help? Open your personal link and use the “Help” page: the portal team replies there.']]) {
      const [m] = to(key);
      assert.ok(m, `${key} enviado`);
      assert.ok(!JSON.stringify(m).toLowerCase().includes(SENTINEL), `${key} sem o SUPPORT_EMAIL`);
      assert.ok(m.html.includes(`abra o link. ${help}</p>`) && m.html.endsWith(footer), `${key}: a ajuda e o rodapé de agora no HTML`);
      assert.ok(m.text.includes(`abra o link.\n${help}\n\n`), `${key}: a ajuda de agora no texto`);
      const r = await row(key);
      assert.deepEqual([r.state, r.html, r.text_body], ['sent', m.html, m.text], `${key}: a cópia guardada é a que saiu`);
    }
    const [mine] = sent.filter(b => b.to[0].email === SENTINEL);
    assert.deepEqual([mine.html, mine.text], [own.html, own.text], 'o email ao dono sai como estava');
    assert.equal(to('esgotado-recente').length + to('esgotado-antigo').length, 0, 'sem tentativas: não saem');

    // guardar as Definições (o formulário envia sempre o remetente) repõe só os falhados das últimas 48 h
    const saved = await post('/admin/definicoes', { MAIL_FROM: 'noreply@quietinterview.test', signups_open: '1' }, admin);
    assert.match(msgOf(saved), /Definições guardadas\./);
    assert.deepEqual([(await row('esgotado-recente')).state, (await row('esgotado-antigo')).state], ['pending', 'failed']);
    await flushOutbox(db);
    const [late] = to('esgotado-recente');
    assert.ok(late && !JSON.stringify(late).toLowerCase().includes(SENTINEL), 'o falhado de há 47 h sai sem o SUPPORT_EMAIL');
    assert.equal(to('esgotado-antigo').length, 0, 'o de há 30 dias fica por enviar');
    const r = await row('esgotado-antigo');
    assert.deepEqual([r.state, r.attempts], ['failed', 6]);
    assert.ok(r.html.includes(SENTINEL), 'e não foi tocado');
  } finally {
    globalThis.fetch = realFetch; delete process.env.MAILERSEND_API_KEY;
    await post('/admin/definicoes', { MAIL_FROM: '-', signups_open: '1' }, admin);
  }
});

test('migração 035 sobre dados antigos: pedidos de utilizadores e convidados intactos; regras dos pedidos de visitantes', async () => {
  const d2 = await openDb();
  try {
    await migrate(d2, { until: '034_metricas.sql' });
    const u = await d2.one(`INSERT INTO users(email, name, password_hash, role) VALUES ('u@x.pt','U','x','interviewer') RETURNING id`);
    const iv = await d2.one(`INSERT INTO interviews(owner_id, title) VALUES ($1,'Antiga') RETURNING id`, [u.id]);
    const t1 = await d2.one(`INSERT INTO support_threads(user_id, subject, origin) VALUES ($1,'Pedido antigo','portal') RETURNING id`, [u.id]);
    const t2 = await d2.one(`INSERT INTO support_threads(interview_id, subject, origin, lang, status) VALUES ($1,'Do convidado','guest','en','answered') RETURNING id`, [iv.id]);
    await d2.query(`INSERT INTO support_messages(thread_id, author, body) VALUES ($1,'user','Olá'), ($2,'guest','Hello'), ($2,'admin','Hi')`, [t1.id, t2.id]);
    await assert.rejects(d2.query(`INSERT INTO support_messages(thread_id, author, body) VALUES ($1,'visitor','x')`, [t1.id]), 'antes da 035 não há visitantes');
    const before = await d2.query('SELECT * FROM support_threads ORDER BY subject');
    await migrate(d2);
    const after = await d2.query('SELECT * FROM support_threads ORDER BY subject');
    assert.deepEqual(after.map((r: any) => [r.id, r.user_id, r.interview_id, r.origin, r.status, r.lang, r.subject]), before.map((r: any) => [r.id, r.user_id, r.interview_id, r.origin, r.status, r.lang, r.subject]));
    for (const r of after) assert.deepEqual([r.visitor_name, r.visitor_email, r.visitor_token_hash, r.visitor_token_nonce, r.topic, r.episode_ref], [null, null, null, null, null, null]);
    assert.equal(Number((await d2.one('SELECT count(*)::int n FROM support_messages')).n), 3);
    // visitante: com o nome, o email, o hash do token e o valor aleatório
    const h = 'a'.repeat(64);
    const vt = await d2.one(`INSERT INTO support_threads(subject, origin, lang, visitor_name, visitor_email, visitor_token_hash, visitor_token_nonce, topic, episode_ref) VALUES ('V','visitor','en','Vi','v@x.pt',$1,'n','episode','/e/x') RETURNING id`, [h]);
    await d2.query(`INSERT INTO support_messages(thread_id, author, body) VALUES ($1,'visitor','Olá')`, [vt.id]);
    const ins = (cols: string, vals: string, p: any[] = []) => d2.query(`INSERT INTO support_threads(subject, origin, lang, ${cols}) VALUES ('X', ${vals}) RETURNING id`, p);
    const bad: [string, string, any[]][] = [
      ['user_id, visitor_name, visitor_email, visitor_token_hash, visitor_token_nonce', `'visitor','en',$1,'Vi','v@x.pt',$2,'n'`, [u.id, 'b'.repeat(64)]], // dois donos
      ['visitor_name, visitor_email', `'visitor','en','Vi','v@x.pt'`, []], // sem token
      ['user_id', `'visitor','pt-PT',$1`, [u.id]], // origem de visitante sem visitante
      ['user_id, visitor_email', `'portal','pt-PT',$1,'v@x.pt'`, [u.id]], // email de visitante num pedido de utilizador
      ['visitor_name, visitor_email, visitor_token_hash, visitor_token_nonce', `'visitor','en','Vi','v@x.pt','nao-hex','n'`, []],
      ['visitor_name, visitor_email, visitor_token_hash, visitor_token_nonce', `'visitor','en','Vi','v@x.pt',$1,'n'`, [h]], // token repetido
      ['visitor_name, visitor_email, visitor_token_hash, visitor_token_nonce, topic', `'visitor','en','Vi','v@x.pt',$1,'n','spam'`, ['c'.repeat(64)]],
      ['visitor_name, visitor_email, visitor_token_hash, visitor_token_nonce', `'visitor','en','','v@x.pt',$1,'n'`, ['d'.repeat(64)]], // nome vazio
      ['interview_id', `'portal','pt-PT',NULL`, []], // sem dono
    ];
    for (const [cols, vals, p] of bad) await assert.rejects(ins(cols, vals, p), `${cols} = ${vals}`);
    assert.equal(Number((await d2.one(`SELECT count(*)::int n FROM support_threads WHERE origin='visitor'`)).n), 1);
  } finally { await d2.close(); }
});
