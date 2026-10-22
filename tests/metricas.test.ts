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
const M = await import('../src/metrics.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
let ipN = 0;
const post = (url: string, body: any, cookie = '', headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'x-forwarded-for': `10.40.0.${++ipN}`, ...headers } });
const visit = (url: string, headers: Record<string, string> = {}, method = 'GET') => app.inject({ method, url, headers: { 'user-agent': UA, ...headers } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie, 'user-agent': UA } });
const PW = 'uma-palavra-passe-longa';
const today = M.utcDay();
/** Contador de hoje para uma página e etiquetas (0 se não houver linha). */
const count = async (path: string, t: Partial<Record<'source' | 'medium' | 'campaign' | 'content' | 'term' | 'referrer_host', string>> = {}) =>
  Number((await db.one(`SELECT n FROM campaign_visits WHERE day=$1 AND path=$2 AND source=$3 AND medium=$4 AND campaign=$5 AND content=$6 AND term=$7 AND referrer_host=$8`,
    [today, path, t.source ?? '', t.medium ?? '', t.campaign ?? '', t.content ?? '', t.term ?? '', t.referrer_host ?? '']))?.n ?? 0);
const total = async () => Number((await db.one('SELECT COALESCE(sum(n),0)::int AS n FROM campaign_visits')).n);

let admin = '', ana = '';

test('preparação: administrador (primeiro registo, não conta como registo) e um entrevistador criado pelo administrador', async () => {
  const r = await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1, utm_source: 'linkedin' });
  admin = `sid=${cookies(r).sid}`;
  const a = await db.one(`SELECT role, self_signup, utm_source FROM users WHERE email='admin@example.com'`);
  assert.equal(a.role, 'admin'); assert.equal(a.self_signup, false, 'a primeira conta (administradora) não é um registo');
  await post('/admin/utilizadores', { name: 'Ana', email: 'ana@example.com', password: PW, role: 'interviewer' }, admin);
  const u = await db.one(`SELECT self_signup, utm_source, utm_medium, utm_campaign, utm_content, utm_term, signup_referrer_host FROM users WHERE email='ana@example.com'`);
  assert.deepEqual(u, { self_signup: false, utm_source: null, utm_medium: null, utm_campaign: null, utm_content: null, utm_term: null, signup_referrer_host: null }, 'criada pelo administrador: sem etiquetas');
  ana = `sid=${cookies(await post('/entrar', { email: 'ana@example.com', password: PW })).sid}`;
  assert.ok(admin && ana);
});

test('normalização das etiquetas e dos domínios', () => {
  assert.equal(M.normTag('  LinkedIn '), 'linkedin');
  assert.equal(M.normTag('QI Lançamento  Outubro'), 'qi-lancamento-outubro');
  assert.equal(M.normTag('"><script>alert(1)</script>'), 'scriptalert1script');
  assert.equal(M.normTag('a.b_c-d/e?f=g'), 'a.b_c-defg');
  assert.equal(M.normTag('x'.repeat(300)).length, 100);
  assert.equal(M.normTag(['First', 'second']), 'first', 'parâmetro repetido: o primeiro');
  assert.equal(M.normTag(undefined), ''); assert.equal(M.normTag({ a: 1 }), '');
  const own = M.ownHosts('test.local');
  assert.equal(M.refHost('https://www.LinkedIn.com/feed/?x=1', own), 'linkedin.com');
  assert.equal(M.refHost('https://quietinterview.com/', own), '');
  assert.equal(M.refHost('https://www.quietinterview.com/precos', own), '');
  assert.equal(M.refHost('https://portal-entrevistas.onrender.com/', own), '');
  assert.equal(M.refHost('http://test.local/podcasts', own), '', 'BASE_URL');
  assert.equal(M.refHost('javascript:alert(1)', own), '');
  assert.equal(M.refHost('android-app://com.linkedin.android/', own), '');
  assert.equal(M.refHost('not a url', own), '');
  assert.equal(M.refHost('news.example', own), 'news.example', 'campo ref com o domínio');
  assert.deepEqual(M.tagsFrom({ utm_campaign: 'só-campanha' }, undefined, own), M.NO_TAGS, 'sem utm_source não é uma campanha');
  assert.equal(M.tagsFrom({ utm_source: 'x' }, 'https://linkedin.com/', own).ref, '', 'com utm_source o site de origem não conta');
  assert.equal(M.campaignQuery(M.tagsFrom({ utm_source: 'LinkedIn', utm_medium: 'Paid Social', utm_campaign: 'qi-a', utm_term: '' }, undefined, own)), 'utm_source=linkedin&utm_medium=paid-social&utm_campaign=qi-a');
  assert.equal(M.campaignQuery(M.tagsFrom({}, 'https://www.instagram.com/', own)), 'ref=instagram.com');
  assert.equal(M.campaignQuery(M.NO_TAGS), '');
});

test('contagem das visitas: com e sem etiquetas, normalizadas, por dia e página', async () => {
  const q = '/?utm_source=LinkedIn&utm_medium=Paid_Social&utm_campaign=QI%20Lan%C3%A7amento&utm_content=Video%201&utm_term=Entrevistas';
  assert.equal((await visit(q)).statusCode, 200);
  await visit(q);
  const t = { source: 'linkedin', medium: 'paid_social', campaign: 'qi-lancamento', content: 'video-1', term: 'entrevistas' };
  assert.equal(await count('/', t), 2, 'duas visitas na mesma linha do dia');
  await visit('/');
  await visit('/?utm_campaign=sem-origem');
  assert.equal(await count('/'), 2, 'sem utm_source: visita direta');
  await visit('/?utm_source=a&utm_source=b');
  assert.equal(await count('/', { source: 'a' }), 1);
  await visit(`/?utm_source=${encodeURIComponent('"><img src=x onerror=alert(1)>')}`);
  assert.equal(await count('/', { source: 'img-srcx-onerroralert1' }), 1, 'só [a-z0-9._-]');
  const row = await db.one(`SELECT * FROM campaign_visits WHERE source='linkedin' AND path='/'`);
  assert.deepEqual(Object.keys(row).sort(), ['campaign', 'content', 'day', 'medium', 'n', 'path', 'referrer_host', 'source', 'term'], 'nada que identifique quem visitou (sem IP nem agente)');
  assert.ok(!(await visit(q)).headers['set-cookie'], 'sem cookies');
});

test('robôs, pré-visualizações, HEAD, pré-carregamento e sessões iniciadas não contam', async () => {
  const before0 = await total();
  for (const ua of ['LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)', 'WhatsApp/2.23.20.0', 'Twitterbot/1.0', 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
    'curl/8.4.0', 'python-requests/2.31', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0 Safari/537.36', ''])
    assert.equal((await visit('/?utm_source=linkedin', { 'user-agent': ua })).statusCode, 200, ua);
  assert.equal((await visit('/?utm_source=linkedin', {}, 'HEAD')).statusCode, 200);
  await visit('/?utm_source=linkedin', { 'sec-purpose': 'prefetch;prerender' });
  await visit('/?utm_source=linkedin', { purpose: 'prefetch' });
  await visit('/?utm_source=linkedin', { cookie: admin });
  await visit('/registar?utm_source=linkedin', { 'user-agent': 'LinkedInBot/1.0' });
  assert.equal(await total(), before0, 'nada contado');
  // Navegadores das apps (LinkedIn, Instagram, Facebook) contam.
  await visit('/?utm_source=inapp', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]' });
  await visit('/?utm_source=inapp', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 300.0.0.0 (iPhone14,5)' });
  await visit('/?utm_source=inapp', { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/440.0]' });
  assert.equal(await count('/', { source: 'inapp' }), 3);
});

test('site de origem: outro site conta como referência; os domínios do portal não', async () => {
  await visit('/', { referer: 'https://www.linkedin.com/feed/' });
  await visit('/', { referer: 'https://l.instagram.com/?u=https%3A%2F%2Fquietinterview.com' });
  assert.equal(await count('/', { referrer_host: 'linkedin.com' }), 1);
  assert.equal(await count('/', { referrer_host: 'l.instagram.com' }), 1);
  const direct = await count('/');
  for (const referer of ['https://quietinterview.com/podcasts', 'https://www.quietinterview.com/', 'https://portal-entrevistas.onrender.com/privacy', 'http://test.local/entrar'])
    await visit('/', { referer });
  assert.equal(await count('/'), direct, 'domínios do portal: navegação interna, não conta outra vez');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM campaign_visits WHERE referrer_host LIKE '%quietinterview%' OR referrer_host LIKE '%onrender%' OR referrer_host='test.local'`)).n), 0);
  await visit('/?utm_source=linkedin&utm_campaign=qi-ref', { referer: 'https://www.linkedin.com/' });
  assert.equal(await count('/', { source: 'linkedin', campaign: 'qi-ref' }), 1, 'com utm_source, sem site de origem');
});

test('navegação interna de volta à landing (logótipo, sair, outras páginas) não conta e mantém as etiquetas', async () => {
  const before0 = await total();
  const landed = await visit('/?utm_source=linkedin&utm_medium=paid_social&utm_campaign=qi-nav');
  assert.equal(await count('/', { source: 'linkedin', medium: 'paid_social', campaign: 'qi-nav' }), 1);
  // Logótipo da própria landing com etiquetas: não conta, e os links para o registo continuam com as etiquetas.
  const logo = await visit('/', { referer: 'http://test.local/?utm_source=linkedin&utm_medium=paid_social&utm_campaign=qi-nav' });
  assert.match(logo.body, /href="\/registar\?utm_source=linkedin&amp;utm_medium=paid_social&amp;utm_campaign=qi-nav">Get started/);
  assert.match(logo.body, /href="\/registar\?plan=start&amp;utm_source=linkedin&amp;utm_medium=paid_social&amp;utm_campaign=qi-nav">Choose Start/);
  // /podcasts → / , /entrar → / e sair da conta (POST /sair redireciona para / com o Referer da página onde estava).
  await visit('/', { referer: 'http://test.local/podcasts' });
  await visit('/', { referer: 'http://test.local/entrar' });
  const s = await post('/entrar', { email: 'ana@example.com', password: PW });
  const out = await post('/sair', {}, `sid=${cookies(s).sid}`, { referer: 'http://test.local/account' });
  assert.equal(out.headers.location, '/');
  await visit('/', { referer: 'http://test.local/account' });
  assert.equal(await total(), before0 + 1, 'só a chegada de fora conta');
  assert.equal(await count('/', { source: 'linkedin', medium: 'paid_social', campaign: 'qi-nav' }), 1);
  assert.ok(landed.statusCode === 200);
  // Registo aberto a partir da landing com etiquetas, sem elas no link: os campos escondidos vêm do Referer interno.
  const reg = (await visit('/registar', { referer: 'http://test.local/?utm_source=linkedin&utm_medium=paid_social&utm_campaign=qi-nav' })).body;
  assert.match(reg, /<input type="hidden" name="utm_source" value="linkedin"><input type="hidden" name="utm_medium" value="paid_social"><input type="hidden" name="utm_campaign" value="qi-nav">/);
  assert.equal(await total(), before0 + 1, 'nem o registo vindo do próprio site');
  // Etiquetas hostis no Referer interno: normalizadas como as outras.
  assert.deepEqual(M.tagsFrom({}, 'http://test.local/?utm_source=%3Cb%3EX&ref=evil', M.ownHosts('test.local')), { ...M.NO_TAGS, source: 'bx' });
  assert.deepEqual(M.tagsFrom({}, 'http://test.local/?ref=news.example', M.ownHosts('test.local')), { ...M.NO_TAGS, ref: 'news.example' });
  assert.deepEqual(M.tagsFrom({}, 'http://test.local/podcasts', M.ownHosts('test.local')), M.NO_TAGS);
});

test('normalização corta o texto em bruto antes de o tratar (valores enormes não bloqueiam o servidor)', () => {
  assert.equal(M.normTag(' '.repeat(500) + 'abc'), '', 'só os primeiros 400 caracteres são lidos');
  assert.equal(M.normTag('ab' + 'c'.repeat(398) + 'zzz').length, 100);
  let t = Date.now();
  assert.equal(M.normTag('Ã'.repeat(20_000_000)), 'a'.repeat(100));
  assert.ok(Date.now() - t < 500, `normTag demorou ${Date.now() - t} ms`);
  t = Date.now();
  assert.equal(M.refHost('https://news.example/' + 'Ã'.repeat(20_000_000), M.ownHosts('test.local')), 'news.example');
  assert.equal(M.refHost(' '.repeat(2000) + 'news.example', M.ownHosts('test.local')), '');
  assert.ok(Date.now() - t < 500, `refHost demorou ${Date.now() - t} ms`);
});

test('teto de combinações por dia: as novas depois do teto contam em «(outros)»', async () => {
  const d = '2026-08-01';
  const t = (source: string) => ({ ...M.NO_TAGS, source });
  for (const src of ['a1', 'a2', 'a3', 'a4', 'a5']) await M.countVisit(db, '/', t(src), d, 3);
  await M.countVisit(db, '/', t('a1'), d, 3); // já existe: soma na própria linha
  await M.countVisit(db, '/', { ...M.NO_TAGS, ref: 'x.example' }, d, 3);
  const rows = (await db.query(`SELECT source, referrer_host, n FROM campaign_visits WHERE day=$1`, [d])).map((r: any) => [r.source, r.referrer_host, r.n]).sort((x: any, y: any) => (x[0] < y[0] ? -1 : 1));
  assert.deepEqual(rows, [['(outros)', '', 3], ['a1', '', 2], ['a2', '', 1], ['a3', '', 1]]);
  const m = await M.campaignMetrics(db, { from: d, to: d, days: 1, preset: 'custom' });
  assert.deepEqual(m.rows.map(r => [M.rowLabel(r), r.visits]), [['a1 / — / —', 2], ['a2 / — / —', 1], ['a3 / — / —', 1], ['(outros)', 3]]);
  assert.equal(M.normTag(M.OTHER), 'outros', 'nenhuma etiqueta normalizada é igual a «(outros)»');
  // Pelo site, com o teto normal (500 por dia), a contagem continua a ser uma linha por combinação.
  assert.equal(M.MAX_VISIT_ROWS_PER_DAY, 500);
});

test('a página e o CSV mostram no máximo MAX_TABLE_ROWS linhas; o resto junta-se em «(outros)»', async () => {
  const d = '2026-08-10';
  const vals = Array.from({ length: M.MAX_TABLE_ROWS + 49 }, (_, i) => `('${d}','/','flood${String(i).padStart(4, '0')}',1)`);
  await db.query(`INSERT INTO campaign_visits(day, path, source, n) VALUES ${vals.join(',')}, ('${d}','/','big',100)`);
  const P1 = { from: d, to: d, days: 1, preset: 'custom' as const };
  const m = await M.campaignMetrics(db, P1);
  assert.equal(m.rows.length, M.MAX_TABLE_ROWS + 1);
  assert.equal(M.rowLabel(m.rows[0]), 'big / — / —');
  assert.deepEqual([M.rowLabel(m.rows.at(-1)!), m.rows.at(-1)!.visits], ['(outros)', 50]);
  assert.equal(m.totals.visits, 100 + M.MAX_TABLE_ROWS + 49, 'o total não perde nada');
  assert.equal(m.daily[0].visits, m.totals.visits);
  const csv = (await get(`/admin/metricas.csv?p=custom&from=${d}&to=${d}`, admin)).body.slice(1).split('\r\n');
  assert.equal(csv.length, 1 + M.MAX_TABLE_ROWS + 1 + 1 + 1, 'cabeçalho, linhas, «(outros)», total e fim');
  assert.ok(csv.includes('(outros);;;;50;0;0,0;0;0;0;0,00;0,00;;;'));
  const html = (await get(`/admin/metricas?p=custom&from=${d}&to=${d}`, admin)).body;
  assert.equal((html.match(/<tr><td>flood/g) ?? []).length, M.MAX_TABLE_ROWS - 1);
  assert.match(html, /<tr><td>\(outros\)<\/td><td class="n">50<\/td>/);
});

test('a contagem nunca estraga a página', async () => {
  await db.query('ALTER TABLE campaign_visits RENAME TO campaign_visits_x');
  try {
    const r = await visit('/?utm_source=linkedin');
    assert.equal(r.statusCode, 200); assert.match(r.body, /Great interviews/);
    assert.equal((await visit('/registar?utm_source=linkedin')).statusCode, 200);
  } finally { await db.query('ALTER TABLE campaign_visits_x RENAME TO campaign_visits'); }
});

test('etiquetas passadas da landing para o registo (links, campos escondidos) e visitas do registo', async () => {
  const plain = (await visit('/')).body;
  assert.match(plain, /href="\/registar">Get started<\/a>/); assert.match(plain, /href="\/registar\?plan=start">Choose Start/);
  const r = (await visit('/?utm_source=LinkedIn&utm_medium=paid_social&utm_campaign=QI%20Teste&utm_content=v1')).body;
  const cq = 'utm_source=linkedin&amp;utm_medium=paid_social&amp;utm_campaign=qi-teste&amp;utm_content=v1';
  assert.match(r, new RegExp(`<a class="btn accent" href="/registar\\?${cq}">Get started</a>`), 'navegação');
  assert.match(r, new RegExp(`href="/registar\\?${cq}">Start from`), 'botão principal');
  assert.match(r, new RegExp(`href="/registar\\?plan=start&amp;${cq}">Choose Start`), 'planos');
  assert.match(r, new RegExp(`href="/registar\\?${cq}">Create your account`), 'fim da página');
  assert.doesNotMatch(r, /href="\/registar"/, 'nenhum link para o registo sem as etiquetas');
  assert.match((await visit('/', { referer: 'https://www.facebook.com/' })).body, /href="\/registar\?ref=facebook\.com">Get started/);
  // Página de registo: campos escondidos normalizados.
  const reg = (await visit('/registar?utm_source=LinkedIn&utm_medium=paid_social&utm_campaign=QI%20Teste&utm_term=%22%3E%3Cb%3E')).body;
  assert.match(reg, /<input type="hidden" name="utm_source" value="linkedin"><input type="hidden" name="utm_medium" value="paid_social"><input type="hidden" name="utm_campaign" value="qi-teste"><input type="hidden" name="utm_term" value="b">/);
  assert.doesNotMatch(reg, /name="utm_content"/, 'vazio: sem campo');
  assert.match((await visit('/registar?ref=news.example')).body, /<input type="hidden" name="ref" value="news\.example">/);
  assert.match((await visit('/registar', { referer: 'https://news.example/artigo' })).body, /<input type="hidden" name="ref" value="news\.example">/, 'link direto de outro site');
  assert.doesNotMatch((await visit('/registar', { referer: 'http://test.local/' })).body, /type="hidden" name="(ref|utm_)/);
  // Visitas do registo: só quem chega de fora (vindo da landing, já foi contado lá).
  const r0 = await count('/registar', { source: 'linkedin', medium: 'paid_social', campaign: 'qi-x' });
  await visit('/registar?utm_source=linkedin&utm_medium=paid_social&utm_campaign=qi-x', { referer: 'http://test.local/?utm_source=linkedin' });
  assert.equal(await count('/registar', { source: 'linkedin', medium: 'paid_social', campaign: 'qi-x' }), r0, 'navegação interna: não conta');
  await visit('/registar?utm_source=linkedin&utm_medium=paid_social&utm_campaign=qi-x');
  await visit('/registar?utm_source=linkedin&utm_medium=paid_social&utm_campaign=qi-x', { referer: 'https://www.linkedin.com/' });
  assert.equal(await count('/registar', { source: 'linkedin', medium: 'paid_social', campaign: 'qi-x' }), r0 + 2, 'link da campanha direto para o registo');
});

test('o registo guarda as etiquetas na conta (normalizadas de novo) e mantém-nas depois de um erro', async () => {
  const bad = await post('/registar', { name: 'Rita', email: 'rita@example.com', password: 'curta', terms: 1, utm_source: 'LinkedIn', utm_medium: 'paid_social', utm_campaign: 'QI Teste' });
  assert.match(String(bad.headers.location), /^\/registar\?e=[^&]+&utm_source=linkedin&utm_medium=paid_social&utm_campaign=qi-teste$/);
  await post('/registar', { name: 'Rita', email: 'rita@example.com', password: PW, terms: 1, utm_source: ' LinkedIn ', utm_medium: 'Paid Social', utm_campaign: '<b>QI Teste</b>', utm_content: 'v1', utm_term: 'x'.repeat(500), ref: 'evil.example' });
  const u = await db.one(`SELECT self_signup, utm_source, utm_medium, utm_campaign, utm_content, utm_term, signup_referrer_host FROM users WHERE email='rita@example.com'`);
  assert.equal(u.self_signup, true);
  assert.equal(u.utm_source, 'linkedin'); assert.equal(u.utm_medium, 'paid-social'); assert.equal(u.utm_campaign, 'bqi-testeb'); assert.equal(u.utm_content, 'v1');
  assert.equal(u.utm_term.length, 100); assert.equal(u.signup_referrer_host, null, 'com utm_source o site de origem não fica');
  await post('/registar', { name: 'Rui', email: 'rui@example.com', password: PW, terms: 1, ref: 'https://www.news.example/x' });
  assert.deepEqual(await db.one(`SELECT utm_source, utm_campaign, signup_referrer_host FROM users WHERE email='rui@example.com'`), { utm_source: null, utm_campaign: null, signup_referrer_host: 'news.example' });
  await post('/registar', { name: 'Sara', email: 'sara@example.com', password: PW, terms: 1, ref: 'quietinterview.com', utm_campaign: 'sem-origem' });
  assert.deepEqual(await db.one(`SELECT self_signup, utm_source, utm_campaign, signup_referrer_host FROM users WHERE email='sara@example.com'`), { self_signup: true, utm_source: null, utm_campaign: null, signup_referrer_host: null }, 'direto');
});

test('acesso: só o administrador', async () => {
  for (const url of ['/admin/metricas', '/admin/metricas.csv']) {
    const g = await get(url);
    assert.equal(g.statusCode, 302); assert.equal(g.headers.location, '/entrar');
    assert.equal((await get(url, ana)).statusCode, 403);
    assert.equal((await get(url, admin)).statusCode, 200);
  }
  assert.equal((await post('/admin/metricas/custos', { period_from: '2026-01-01', period_to: '2026-01-02', source: 'linkedin', amount: '10' }, ana)).statusCode, 403);
  assert.equal((await post('/admin/metricas/custos', { period_from: '2026-01-01', period_to: '2026-01-02', source: 'linkedin', amount: '10' })).statusCode, 302);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM campaign_spend')).n), 0);
  const page = (await get('/admin/metricas', admin)).body;
  assert.match(page, /<a href="\/admin\/assistente">Assistente<\/a><a href="\/admin\/metricas">Métricas<\/a>/, 'navegação do administrador');
  assert.match(page, /datas em UTC/);
});

// ---------- dados semeados: janeiro de 2026 ----------
const P = { from: '2026-01-01', to: '2026-01-10', days: 10, preset: 'custom' as const };
let n = 0;
const mkUser = async (o: { at: string; self?: boolean; source?: string; medium?: string; campaign?: string; ref?: string }) =>
  (await db.one(`INSERT INTO users(email, name, password_hash, role, created_at, self_signup, utm_source, utm_medium, utm_campaign, signup_referrer_host) VALUES ($1,'Semente','x','interviewer',$2,$3,$4,$5,$6,$7) RETURNING id`,
    [`semente${++n}@example.com`, o.at, o.self ?? true, o.source ?? null, o.medium ?? null, o.campaign ?? null, o.ref ?? null])).id;
const mkInterview = async (owner: string, at: string, invite?: string) => {
  const iv = (await db.one(`INSERT INTO interviews(owner_id, title, created_at) VALUES ($1,'Teste',$2) RETURNING id`, [owner, at])).id;
  if (invite) await db.query(`INSERT INTO invitations(interview_id, token_hash, question_version, expires_at, created_at, purpose) VALUES ($1,$2,1,$3,$3,'invite')`, [iv, `h${++n}`, invite]);
  return iv;
};
const pay = (user: string, at: string, net: number, kind = 'subscription') =>
  db.query(`INSERT INTO invoice_queue(kind, user_id, stripe_ref, description, net_cents, vat_cents, total_cents, paid_at) VALUES ($1,$2,$3,'teste',$4,$5,$6,$7)`,
    [kind, user, `ref_${++n}`, net, Math.round(net * 0.23), net + Math.round(net * 0.23), at]);

test('métricas de um conjunto semeado: visitas, registos, ativação, convites, pagantes, receita, custos, CPA e ROAS', async () => {
  // Contagem das visitas desde antes dos dados semeados (a migração marca o dia em que corre).
  await db.query(`UPDATE campaign_tracking SET started_on='2025-01-01'`);
  const v = (day: string, source: string, medium: string, campaign: string, ref: string, k: number, path = '/') =>
    db.query(`INSERT INTO campaign_visits(day, path, source, medium, campaign, referrer_host, n) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [day, path, source, medium, campaign, ref, k]);
  await v('2026-01-02', 'linkedin', 'paid_social', 'qi-a', '', 40);
  await v('2026-01-05', 'linkedin', 'paid_social', 'qi-a', '', 50);
  await v('2026-01-05', 'linkedin', 'paid_social', 'qi-a', '', 10, '/registar');
  await v('2026-01-06', 'instagram', 'paid_social', 'qi-b', '', 50);
  await v('2026-01-03', '', '', '', '', 30);
  await v('2026-01-04', '', '', '', 'news.example', 20);
  await v('2025-12-31', 'linkedin', 'paid_social', 'qi-a', '', 999);
  await v('2026-01-11', 'linkedin', 'paid_social', 'qi-a', '', 999);
  const L = { source: 'linkedin', medium: 'paid_social', campaign: 'qi-a' };
  const u1 = await mkUser({ at: '2026-01-02T10:00:00Z', ...L });
  await mkInterview(u1, '2026-01-02T11:00:00Z', '2026-01-03T09:00:00Z');
  await pay(u1, '2026-01-03T12:00:00Z', 1900);
  await pay(u1, '2026-01-04T12:00:00Z', 2500, 'topup');
  await pay(u1, '2026-01-06T12:00:00Z', -1000, 'topup_refund');
  const u2 = await mkUser({ at: '2026-01-03T10:00:00Z', ...L });
  await mkInterview(u2, '2026-01-04T10:00:00Z');
  await mkUser({ at: '2026-01-05T23:59:59Z', ...L });
  const u4 = await mkUser({ at: '2026-01-06T08:00:00Z', source: 'instagram', medium: 'paid_social', campaign: 'qi-b' });
  await mkInterview(u4, '2026-01-06T09:00:00Z', '2026-01-07T09:00:00Z');
  await pay(u4, '2026-01-07T12:00:00Z', 4900);
  await pay(u4, '2026-01-20T12:00:00Z', 4900); // depois do período
  // Conta direta com um carregamento cuja disputa foi perdida: receita 0, não é pagante.
  const u5 = await mkUser({ at: '2026-01-08T10:00:00Z' });
  await pay(u5, '2026-01-08T12:00:00Z', 2500, 'topup');
  const w = (await db.one(`INSERT INTO wallets(user_id) VALUES ($1) RETURNING id`, [u5])).id;
  await db.query(`INSERT INTO wallet_entries(wallet_id, kind, available_delta, debt_delta, stripe_ref, created_at) VALUES ($1,'dispute',-2000,500,'dp_1','2026-01-09T10:00:00Z')`, [w]);
  await db.query(`INSERT INTO wallet_entries(wallet_id, kind, stripe_ref, created_at) VALUES ($1,'dispute_lost','dp_1','2026-01-09T12:00:00Z')`, [w]);
  await mkUser({ at: '2026-01-09T10:00:00Z', ref: 'news.example' });
  // Fora da coorte: registo antes do período (a receita conta só em «todas as contas») e conta criada pelo administrador.
  const u7 = await mkUser({ at: '2025-12-31T23:00:00Z', ...L });
  await pay(u7, '2026-01-05T12:00:00Z', 1000);
  const u8 = await mkUser({ at: '2026-01-05T10:00:00Z', self: false, ...L });
  await mkInterview(u8, '2026-01-05T11:00:00Z', '2026-01-05T12:00:00Z');
  await pay(u8, '2026-01-05T13:00:00Z', 700);
  // Custos: 200 € em 20 dias (10 no período → 100 €), 50 € num dia, 30 € sem visitas nem registos, e um fora do período.
  const sp = (from: string, to: string, source: string, campaign: string, cents: number) =>
    db.query(`INSERT INTO campaign_spend(period_from, period_to, source, campaign, amount_cents, created_by) VALUES ($1,$2,$3,$4,$5,'semente')`, [from, to, source, campaign, cents]);
  await sp('2026-01-01', '2026-01-20', 'linkedin', 'qi-a', 20000);
  await sp('2026-01-06', '2026-01-06', 'instagram', 'qi-b', 5000);
  await sp('2026-01-01', '2026-01-10', 'google', 'qi-c', 3000);
  await sp('2025-11-01', '2025-11-30', 'linkedin', 'qi-a', 99999);

  const m = await M.campaignMetrics(db, P);
  const by = Object.fromEntries(m.rows.map(r => [M.rowLabel(r), r]));
  const pick = (r: any) => ({ visits: r.visits, signups: r.signups, activated: r.activated, invited: r.invited, paying: r.paying, revenueCents: r.revenueCents, spendCents: r.spendCents });
  assert.deepEqual(pick(by['linkedin / paid_social / qi-a']), { visits: 100, signups: 3, activated: 2, invited: 1, paying: 1, revenueCents: 3400, spendCents: 10000 });
  assert.deepEqual(pick(by['instagram / paid_social / qi-b']), { visits: 50, signups: 1, activated: 1, invited: 1, paying: 1, revenueCents: 4900, spendCents: 5000 });
  assert.deepEqual(pick(by['(direto)']), { visits: 30, signups: 1, activated: 0, invited: 0, paying: 0, revenueCents: 0, spendCents: 0 });
  assert.deepEqual(pick(by['(referência) news.example']), { visits: 20, signups: 1, activated: 0, invited: 0, paying: 0, revenueCents: 0, spendCents: 0 });
  assert.deepEqual(pick(by['google / — / qi-c']), { visits: 0, signups: 0, activated: 0, invited: 0, paying: 0, revenueCents: 0, spendCents: 3000 });
  assert.equal(m.rows[0], by['linkedin / paid_social / qi-a'], 'ordenado pelas visitas');
  assert.deepEqual(pick(m.totals), { visits: 200, signups: 6, activated: 3, invited: 2, paying: 2, revenueCents: 8300, spendCents: 18000 });
  assert.equal(m.allRevenueCents, 3400 + 4900 + 0 + 1000 + 700, 'todas as contas: inclui as de fora da coorte; a disputa perdida abate');
  const x = M.ratios(by['linkedin / paid_social / qi-a']);
  assert.equal(x.conversion, 0.03); assert.ok(Math.abs(x.cpa! - 10000 / 3) < 1e-9); assert.equal(x.cpp, 10000); assert.equal(x.roas, 0.34);
  assert.equal(M.ratios(by['instagram / paid_social / qi-b']).roas, 0.98);
  assert.equal(M.ratios(by['(direto)']).cpa, null, 'sem custo: sem CPA');
  assert.deepEqual(m.daily.find(d => d.day === '2026-01-05'), { day: '2026-01-05', visits: 60, signups: 1 });
  assert.equal(m.daily.length, 10);
  assert.deepEqual(m.spend.map(e => [e.source, Math.round(e.inPeriodCents)]).sort(), [['google', 3000], ['instagram', 5000], ['linkedin', 10000]]);

  // A página mostra os mesmos números.
  const html = (await get('/admin/metricas?p=custom&from=2026-01-01&to=2026-01-10', admin)).body;
  assert.match(html, /<td>linkedin \/ paid_social \/ qi-a<\/td><td class="n">100<\/td><td class="n">3<\/td><td class="n">3,0 %<\/td><td class="n">2<\/td><td class="n">1<\/td><td class="n">1<\/td>\s*<td class="n">34,00 €<\/td><td class="n">100,00 €<\/td><td class="n">33,33 €<\/td><td class="n">100,00 €<\/td><td class="n">0,34×<\/td>/);
  assert.match(html, /<p class="l">Receita das contas novas<\/p><p class="v">83,00 €<\/p>/);
  assert.match(html, /<p class="l">Custo<\/p><p class="v">180,00 €<\/p>/);
  assert.match(html, /<p class="l">ROAS<\/p><p class="v">0,46×<\/p>/);
  assert.match(html, /<p class="l">Receita de todas as contas<\/p><p class="v">100,00 €<\/p>/);
  assert.match(html, /<svg class="mt-chart"[^>]*aria-label="Visitas e registos por dia, de 01\/01\/2026 a 10\/01\/2026: 200 visitas e 6 registos"/);
  assert.match(html, /<title>05\/01\/2026: 60 visitas<\/title>/);
  assert.match(html, /style="fill:var\(--accent\)"/, 'cores do tema (modo escuro incluído)');
  assert.match(html, /Como se calcula/);
});

test('conversão: os registos anteriores ao início da contagem das visitas não entram (nunca passa dos 100 % por isso)', async () => {
  await db.query(`UPDATE campaign_tracking SET started_on='2026-06-05'`);
  try {
    for (const at of ['2026-06-01T10:00:00Z', '2026-06-02T10:00:00Z', '2026-06-03T10:00:00Z', '2026-06-05T10:00:00Z']) await mkUser({ at });
    await db.query(`INSERT INTO campaign_visits(day, path, n) VALUES ('2026-06-05','/',2)`);
    const PP = { from: '2026-05-08', to: '2026-06-06', days: 30, preset: 'custom' as const };
    const m = await M.campaignMetrics(db, PP);
    assert.equal(m.trackingSince, '2026-06-05');
    assert.deepEqual([m.totals.visits, m.totals.signups, m.totals.signupsTracked], [2, 4, 1]);
    assert.equal(M.ratios(m.totals).conversion, 0.5);
    assert.equal(M.ratios(m.rows.find(r => r.key === 'direct')!).conversion, 0.5);
    const html = (await get('/admin/metricas?p=custom&from=2026-05-08&to=2026-06-06', admin)).body;
    assert.match(html, /<p class="l">Conversão<\/p><p class="v">50,0 %<\/p><p class="s">visita → registo, desde 05\/06\/2026<\/p>/);
    assert.match(html, /As visitas só se contam desde 05\/06\/2026\./);
    assert.match(html, /início da contagem<\/text>/, 'marca no gráfico');
    assert.match(html, /<p class="l">Registos<\/p><p class="v">4<\/p>/);
    // Um período todo depois do início: sem aviso.
    assert.doesNotMatch((await get('/admin/metricas?p=custom&from=2026-06-05&to=2026-06-06', admin)).body, /As visitas só se contam desde/);
  } finally { await db.query(`UPDATE campaign_tracking SET started_on='2025-01-01'`); }
});

test('total: custo por registo, custo por pagante e ROAS só das linhas com custo (não se misturam com «(direto)»)', async () => {
  const L = { source: 'linkedin', medium: 'paid_social', campaign: 'qi-d' };
  await db.query(`INSERT INTO campaign_visits(day, path, source, medium, campaign, n) VALUES ('2026-07-02','/','linkedin','paid_social','qi-d',20), ('2026-07-02','/','','','',10)`);
  await mkUser({ at: '2026-07-02T10:00:00Z', ...L });
  const org = await mkUser({ at: '2026-07-03T10:00:00Z' });
  await pay(org, '2026-07-03T12:00:00Z', 49000);
  await db.query(`INSERT INTO campaign_spend(period_from, period_to, source, campaign, amount_cents) VALUES ('2026-07-01','2026-07-05','linkedin','qi-d',10000)`);
  const m = await M.campaignMetrics(db, { from: '2026-07-01', to: '2026-07-05', days: 5, preset: 'custom' });
  assert.deepEqual([m.totals.revenueCents, m.totals.signups, m.totals.paying], [49000, 2, 1]);
  assert.deepEqual([m.paid.revenueCents, m.paid.signups, m.paid.paying, m.paid.spendCents], [0, 1, 0, 10000]);
  assert.deepEqual(M.totalRatios(m), { conversion: 2 / 30, cpa: 10000, cpp: null, roas: 0 });
  const html = (await get('/admin/metricas?p=custom&from=2026-07-01&to=2026-07-05', admin)).body;
  assert.match(html, /<p class="l">ROAS<\/p><p class="v">0,00×<\/p><p class="s">receita ÷ custo, só campanhas com custo<\/p>/);
  assert.match(html, /<p class="l">Custo por registo<\/p><p class="v">100,00 €<\/p>/);
  assert.match(html, /<p class="l">Custo por pagante<\/p><p class="v">—<\/p>/);
  assert.match(html, /<tfoot><tr><td>Total<\/td>[\s\S]*?<td class="n">490,00 €<\/td><td class="n">100,00 €<\/td><td class="n">100,00 €<\/td><td class="n">—<\/td><td class="n">0,00×<\/td><\/tr><\/tfoot>/);
  const csv = (await get('/admin/metricas.csv?p=custom&from=2026-07-01&to=2026-07-05', admin)).body.slice(1).split('\r\n');
  assert.equal(csv.at(-2), 'Total;;;;30;2;6,7;0;0;1;490,00;100,00;100,00;;0,00');
});

test('datas fora de 2000–2100 recusadas (o ano 9999 não bloqueia o servidor; 0000 não dá erro 500)', { timeout: 20_000 }, async () => {
  for (const [from, to] of [['9999-12-31', '9999-12-31'], ['0000-01-01', '0000-01-02'], ['1999-12-31', '2000-01-01'], ['2026-01-01', '2101-01-01']]) {
    assert.match(M.parsePeriod({ p: 'custom', from, to }, '2026-10-22').error!, /entre 2000 e 2100/, `${from}..${to}`);
    const r = await get(`/admin/metricas?p=custom&from=${from}&to=${to}`, admin);
    assert.equal(r.statusCode, 200); assert.match(r.body, /entre 2000 e 2100/); assert.match(r.body, /\(30 dias\)/);
    assert.equal((await get(`/admin/metricas.csv?p=custom&from=${from}&to=${to}`, admin)).statusCode, 200);
  }
  assert.equal(M.validDay('2000-01-01'), true); assert.equal(M.validDay('2100-12-31'), true);
  const r = await post('/admin/metricas/custos', { p: '7', period_from: '9999-12-31', period_to: '9999-12-31', source: 'linkedin', amount: '10' }, admin);
  assert.match(decodeURIComponent(String(r.headers.location)), /e=Indique as datas de início e de fim do custo \(entre 2000 e 2100\)/);
  // O ciclo dos dias percorre o número de dias do período.
  const m = await M.campaignMetrics(db, { from: '2100-12-30', to: '2100-12-31', days: 2, preset: 'custom' });
  assert.deepEqual(m.daily.map(d => d.day), ['2100-12-30', '2100-12-31']);
});

test('custos com vários meios na mesma origem e campanha: repartidos pelas visitas', async () => {
  await db.query(`INSERT INTO campaign_visits(day, path, source, medium, campaign, n) VALUES ('2026-02-01','/','linkedin','paid_social','qi-x',30), ('2026-02-01','/','linkedin','social','qi-x',10)`);
  await db.query(`INSERT INTO campaign_spend(period_from, period_to, source, campaign, amount_cents) VALUES ('2026-02-01','2026-02-01','linkedin','qi-x',4000)`);
  const m = await M.campaignMetrics(db, { from: '2026-02-01', to: '2026-02-01', days: 1, preset: 'custom' });
  assert.deepEqual(m.rows.map(r => [M.rowLabel(r), r.spendCents]), [['linkedin / paid_social / qi-x', 3000], ['linkedin / social / qi-x', 1000]]);
  assert.equal(M.prorate({ period_from: '2026-01-01', period_to: '2026-01-31', amount_cents: 31000 }, { from: '2026-01-31', to: '2026-02-05', days: 6, preset: 'custom' }), 1000);
  assert.equal(M.prorate({ period_from: '2026-03-01', period_to: '2026-03-31', amount_cents: 31000 }, { from: '2026-01-31', to: '2026-02-05', days: 6, preset: 'custom' }), 0);
});

test('CSV: valores, escapes e proteção contra fórmulas', async () => {
  const r = await get('/admin/metricas.csv?p=custom&from=2026-01-01&to=2026-01-10', admin);
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-type']), /^text\/csv; charset=utf-8/);
  assert.equal(r.headers['content-disposition'], 'attachment; filename="metricas-2026-01-01-2026-01-10.csv"');
  assert.equal(r.body.charCodeAt(0), 0xfeff, 'BOM para o Excel');
  const lines = r.body.slice(1).split('\r\n');
  assert.equal(lines[0], 'Origem;Meio;Campanha;Site de referência;Visitas;Registos;Conversão (%);Ativados;Com convite;Pagantes;Receita sem IVA (EUR);Custo (EUR);Custo por registo (EUR);Custo por pagante (EUR);ROAS');
  assert.equal(lines[1], 'linkedin;paid_social;qi-a;;100;3;3,0;2;1;1;34,00;100,00;33,33;100,00;0,34');
  assert.ok(lines.includes('(referência);;;news.example;20;1;5,0;0;0;0;0,00;0,00;;;'));
  assert.ok(lines.includes('(direto);;;;30;1;3,3;0;0;0;0,00;0,00;;;'));
  assert.equal(lines.at(-2), 'Total;;;;200;6;3,0;3;2;2;83,00;180,00;45,00;90,00;0,46', 'custo por registo, por pagante e ROAS do total: só as linhas com custo');
  assert.equal(lines.at(-1), '');
  // Células de texto hostis (gravadas diretamente na base: o site já as normaliza).
  assert.equal(M.csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  assert.equal(M.csvCell('+1'), "'+1"); assert.equal(M.csvCell('-2+3'), "'-2+3"); assert.equal(M.csvCell('@SUM(A1)'), "'@SUM(A1)"); assert.equal(M.csvCell('\tx'), "'\tx");
  assert.equal(M.csvCell('a;b'), '"a;b"'); assert.equal(M.csvCell('x"y'), '"x""y"'); assert.equal(M.csvCell('l1\nl2'), '"l1\nl2"');
  assert.equal(M.csvCell(-5), '-5', 'números negativos não levam apóstrofo'); assert.equal(M.csvCell('-12,50', false), '-12,50'); assert.equal(M.csvCell(null), '');
  await db.query(`INSERT INTO campaign_visits(day, path, source, medium, campaign, n) VALUES ('2026-03-01','/','=cmd|''/c calc''!A1','-x','a;"b"',5)`);
  const c = (await get('/admin/metricas.csv?p=custom&from=2026-03-01&to=2026-03-01', admin)).body.slice(1).split('\r\n');
  assert.equal(c[1], `'=cmd|'/c calc'!A1;'-x;"a;""b""";;5;0;0,0;0;0;0;0,00;0,00;;;`);
});

test('valores hostis escapados na página (nada de HTML vindo das etiquetas)', async () => {
  await db.query(`INSERT INTO campaign_visits(day, path, source, medium, campaign, referrer_host, n) VALUES ('2026-03-01','/','<img src=x onerror=alert(1)>','"><script>alert(2)</script>','x',''  ,3), ('2026-03-01','/','','','','<b>evil</b>',2)`);
  await mkUser({ at: '2026-03-01T10:00:00Z', source: '<svg onload=alert(3)>', campaign: "'><i>" });
  await db.query(`INSERT INTO campaign_spend(period_from, period_to, source, campaign, amount_cents, note) VALUES ('2026-03-01','2026-03-01','<u>s</u>','c','100','<script>alert(4)</script>')`);
  const html = (await get('/admin/metricas?p=custom&from=2026-03-01&to=2026-03-01', admin)).body;
  for (const bad of ['<img src=x', '<script>alert(2)', '<b>evil', '<svg onload', "'><i>", '<u>s</u>', '<script>alert(4)']) assert.ok(!html.includes(bad), bad);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; \/ &quot;&gt;&lt;script&gt;alert\(2\)&lt;\/script&gt; \/ x/);
  assert.match(html, /\(referência\) &lt;b&gt;evil&lt;\/b&gt;/);
  assert.match(html, /&lt;script&gt;alert\(4\)&lt;\/script&gt;/);
});

test('custos: validação, registo e apagar', async () => {
  const base = { p: 'custom', from: '2026-04-01', to: '2026-04-30' };
  const err = async (body: any, re: RegExp) => {
    const r = await post('/admin/metricas/custos', { ...base, ...body }, admin);
    assert.equal(r.statusCode, 302);
    const loc = String(r.headers.location);
    assert.match(loc, /^\/admin\/metricas\?p=custom&from=2026-04-01&to=2026-04-30&e=/, 'volta ao mesmo período');
    assert.match(decodeURIComponent(loc), re);
  };
  const before0 = Number((await db.one('SELECT count(*)::int n FROM campaign_spend')).n);
  const ok = { period_from: '2026-04-01', period_to: '2026-04-30', source: 'LinkedIn', campaign: 'QI Abril', amount: '250,50', note: 'Fatura\nLinkedIn' };
  await err({ ...ok, period_from: '' }, /Indique as datas/);
  await err({ ...ok, period_to: '2026-02-30' }, /Indique as datas/);
  await err({ ...ok, period_from: '2026-05-01' }, /depois da data de fim/);
  await err({ ...ok, period_from: '2020-01-01' }, /mais de 1100 dias/);
  await err({ ...ok, source: '  ' }, /Indique a origem/);
  await err({ ...ok, source: '<>' }, /Indique a origem/);
  for (const amount of ['', '0', '0,00', '-5', 'abc', '1e5', '12,345', '99999999']) await err({ ...ok, amount }, /Valor inválido/);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM campaign_spend')).n), before0, 'nada gravado');
  const r = await post('/admin/metricas/custos', { ...base, ...ok }, admin);
  assert.match(decodeURIComponent(String(r.headers.location)), /^\/admin\/metricas\?p=custom&from=2026-04-01&to=2026-04-30&ok=Custo de 250,50 € registado \(linkedin \/ qi-abril, de 01\/04\/2026 a 30\/04\/2026\)\.#custos$/);
  const e = await db.one(`SELECT * FROM campaign_spend WHERE campaign='qi-abril'`);
  assert.equal(e.source, 'linkedin'); assert.equal(e.amount_cents, 25050); assert.equal(e.note, 'Fatura LinkedIn'); assert.equal(e.created_by, 'admin@example.com');
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='admin.campaign_spend_added' AND meta->>'id'=$1`, [e.id]));
  await post('/admin/metricas/custos', { ...base, ...ok, campaign: '', amount: '12' }, admin);
  assert.equal((await db.one(`SELECT amount_cents FROM campaign_spend WHERE source='linkedin' AND campaign='' AND period_from='2026-04-01'`)).amount_cents, 1200, 'campanha opcional; euros inteiros');
  const html = (await get('/admin/metricas?p=custom&from=2026-04-01&to=2026-04-30', admin)).body;
  assert.match(html, new RegExp(`action="/admin/metricas/custos/${e.id}/apagar"`));
  assert.match(html, /linkedin \/ qi-abril<\/td><td class="n">250,50 €<\/td><td class="n">250,50 €<\/td>/);
  // Pedido de outro site (CSRF): recusado.
  assert.equal((await post(`/admin/metricas/custos/${e.id}/apagar`, base, admin, { origin: 'https://evil.example' })).statusCode, 403);
  assert.equal((await post(`/admin/metricas/custos/${e.id}/apagar`, base, ana)).statusCode, 403);
  assert.ok(await db.one('SELECT 1 FROM campaign_spend WHERE id=$1', [e.id]));
  const d = await post(`/admin/metricas/custos/${e.id}/apagar`, base, admin);
  assert.match(decodeURIComponent(String(d.headers.location)), /^\/admin\/metricas\?p=custom&from=2026-04-01&to=2026-04-30&ok=Custo apagado\./);
  assert.equal(await db.one('SELECT 1 FROM campaign_spend WHERE id=$1', [e.id]), undefined);
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='admin.campaign_spend_deleted' AND meta->>'id'=$1`, [e.id]));
  assert.match(decodeURIComponent(String((await post(`/admin/metricas/custos/${e.id}/apagar`, base, admin)).headers.location)), /e=Custo inexistente/);
  assert.match(decodeURIComponent(String((await post('/admin/metricas/custos/nao-e-um-id/apagar', base, admin)).headers.location)), /e=Custo inexistente/);
});

test('custos: a mensagem fica junto ao formulário, os valores voltam depois de um erro e um custo fora do período fica à vista', async () => {
  const base = { p: '7' };
  const bad = await post('/admin/metricas/custos', { ...base, period_from: '2026-09-01', period_to: '2026-09-30', source: 'LinkedIn', campaign: 'qi-setembro', amount: '0', note: '"><b>x' }, admin);
  const loc = String(bad.headers.location);
  assert.match(loc, /^\/admin\/metricas\?p=7&e=[^&]+&s_from=2026-09-01&s_to=2026-09-30&s_source=LinkedIn&s_campaign=qi-setembro&s_amount=0&s_note=%22%3E%3Cb%3Ex#custos$/);
  const html = (await get(loc.replace(/#.*$/, ''), admin)).body;
  const iCard = html.indexOf('id="custos"'), iMsg = html.indexOf('<div class="flash bad" role="status">Valor inválido'), iForm = html.indexOf('action="/admin/metricas/custos"');
  assert.ok(iCard > 0 && iCard < iMsg && iMsg < iForm, 'mensagem dentro do cartão dos custos, antes do formulário');
  assert.match(html, /id="sf" name="period_from" type="date" required value="2026-09-01"/);
  assert.match(html, /id="st" name="period_to" type="date" required value="2026-09-30"/);
  assert.match(html, /id="ss" name="source"[^>]*value="LinkedIn"/);
  assert.match(html, /id="sc" name="campaign"[^>]*value="qi-setembro"/);
  assert.match(html, /id="sa" name="amount"[^>]*value="0"/);
  assert.match(html, /id="sn" name="note"[^>]*value="&quot;&gt;&lt;b&gt;x"/);
  assert.ok(!html.includes('"><b>x'));
  // Sucesso com o custo fora dos 7 dias em vista: volta-se ao período do custo, onde ele aparece.
  const ok = await post('/admin/metricas/custos', { ...base, period_from: '2026-09-01', period_to: '2026-09-30', source: 'linkedin', campaign: 'qi-setembro', amount: '300' }, admin);
  const okLoc = decodeURIComponent(String(ok.headers.location));
  assert.match(okLoc, /^\/admin\/metricas\?p=custom&from=2026-09-01&to=2026-09-30&ok=Custo de 300,00 € registado \(linkedin \/ qi-setembro, de 01\/09\/2026 a 30\/09\/2026\)\. Fica fora do período que estava a ver: mostra-se agora o período do custo\.#custos$/);
  const shown = (await get(String(ok.headers.location).replace(/#.*$/, ''), admin)).body;
  assert.ok(shown.indexOf('<div class="flash ok" role="status">Custo de 300,00 €') > shown.indexOf('id="custos"'));
  assert.match(shown, /linkedin \/ qi-setembro<\/td><td class="n">300,00 €<\/td><td class="n">300,00 €<\/td>/);
  assert.match(shown, /id="sa" name="amount"[^>]*value=""/, 'depois do sucesso o formulário fica vazio');
  // Telemóvel: a tabela dos custos rola dentro do seu invólucro, não a página.
  assert.match(shown, /<div style="overflow-x:auto"><table class="mt-table"><thead><tr><th>Período<\/th>/);
});

test('filtros do período', async () => {
  const t = '2026-10-22';
  assert.deepEqual(M.parsePeriod({}, t), { period: { from: '2026-09-23', to: t, days: 30, preset: '30' } });
  assert.deepEqual(M.parsePeriod({ p: '7' }, t).period, { from: '2026-10-16', to: t, days: 7, preset: '7' });
  assert.deepEqual(M.parsePeriod({ p: '90' }, t).period, { from: '2026-07-25', to: t, days: 90, preset: '90' });
  assert.deepEqual(M.parsePeriod({ p: '30', from: '2026-01-01', to: '2026-01-02' }, t).period.preset, '30', 'um período fixo ignora as datas');
  assert.deepEqual(M.parsePeriod({ p: 'custom', from: '2026-01-01', to: '2026-01-31' }, t), { period: { from: '2026-01-01', to: '2026-01-31', days: 31, preset: 'custom' } });
  assert.deepEqual(M.parsePeriod({ from: '2026-01-01', to: '2026-01-01' }, t).period.days, 1, 'só com as datas: personalizado');
  for (const [q, re] of [[{ p: 'custom', from: '2026-01-10', to: '2026-01-01' }, /depois/], [{ p: 'custom', from: '2026-02-30', to: '2026-03-01' }, /Indique/], [{ p: 'custom', from: 'x' }, /Indique/], [{ p: 'custom', from: '2020-01-01', to: '2026-01-01' }, /mais de 1100/]] as const) {
    const r = M.parsePeriod(q, t);
    assert.match(r.error!, re); assert.equal(r.period.preset, '30');
  }
  // Pela página: hoje conta nos 7 dias; o período inválido avisa e mostra os 30 dias.
  const p7 = (await get('/admin/metricas?p=7', admin)).body;
  assert.match(p7, /<option value="7" selected>/); assert.match(p7, /\(7 dias\), datas em UTC/);
  const m7 = await M.campaignMetrics(db, M.parsePeriod({ p: '7' }).period);
  assert.ok(m7.totals.visits > 0 && m7.totals.signups >= 3, 'visitas e registos de hoje (dos testes acima)');
  assert.equal(m7.rows.some(r => r.source === 'linkedin' && r.campaign === 'qi-a'), false, 'nada de janeiro');
  const bad = (await get('/admin/metricas?p=custom&from=2026-01-10&to=2026-01-01', admin)).body;
  assert.match(bad, /A data inicial é depois da data final/); assert.match(bad, /\(30 dias\)/);
  assert.match((await get('/admin/metricas.csv?p=7', admin)).headers['content-disposition'], new RegExp(`metricas-${M.addDaysUtc(today, -6)}-${today}\\.csv`));
});

test('construtor de links', async () => {
  const html = (await get('/admin/metricas?p=7&link=1&l_source=linkedin&l_medium=paid_social&l_campaign=QI%20Lan%C3%A7amento&l_content=Video%201', admin)).body;
  assert.match(html, /<input id="lk" class="grow mt-link" type="text" readonly value="http:\/\/test\.local\/\?utm_source=linkedin&amp;utm_medium=paid_social&amp;utm_campaign=qi-lancamento&amp;utm_content=video-1"/);
  assert.match(html, /id="lk-copy">Copiar<\/button>/);
  assert.match(html, /<input type="hidden" name="p" value="7">/, 'mantém o período');
  assert.match((await get('/admin/metricas?link=1&l_source=other&l_other=Podcast%20X&l_medium=referral&l_campaign=qi-a', admin)).body, /value="http:\/\/test\.local\/\?utm_source=podcast-x&amp;utm_medium=referral&amp;utm_campaign=qi-a"/);
  assert.match((await get('/admin/metricas?link=1&l_source=other&l_other=&l_medium=cpc&l_campaign=qi-a', admin)).body, /Escreva o nome da outra origem/);
  assert.match((await get('/admin/metricas?link=1&l_source=linkedin&l_medium=tv&l_campaign=qi-a', admin)).body, /Escolha o meio/);
  assert.match((await get('/admin/metricas?link=1&l_source=evil&l_medium=cpc&l_campaign=qi-a', admin)).body, /Escolha a origem/);
  assert.match((await get('/admin/metricas?link=1&l_source=google&l_medium=cpc&l_campaign=%3C%3E', admin)).body, /Escreva o nome da campanha/);
  assert.deepEqual(M.buildLink({}), null);
  // O link criado conta como campanha na landing.
  const url = new URL(M.buildLink({ link: '1', l_source: 'instagram', l_medium: 'social', l_campaign: 'qi-built' })!.url as string);
  await visit(url.pathname + url.search);
  assert.equal(await count('/', { source: 'instagram', medium: 'social', campaign: 'qi-built' }), 1);
});

test('privacidade: parágrafo sobre os links das campanhas', async () => {
  const b = (await visit('/privacy')).body;
  assert.match(b, /<h2>Campaign links<\/h2><p>Visits to the home page and the sign-up page are counted in aggregate per day[^<]*without cookies, IP addresses[^<]*When you sign up after following a campaign link, the campaign tags[^<]*are kept with your account to measure campaign results\.<\/p>/);
  assert.match(b, /<h2>Composition assistant<\/h2>/); assert.match(b, /<h2>Your rights<\/h2>/);
});

test('migração 034: registos anteriores identificados pela auditoria', async () => {
  const d2 = await openDb();
  try {
    await migrate(d2, { until: '033_assistente_composicao.sql' });
    await d2.query(`INSERT INTO users(email, name, password_hash, role) VALUES ('adm@x.pt','A','x','admin'), ('reg@x.pt','R','x','interviewer'), ('criado@x.pt','C','x','interviewer')`);
    await d2.query(`INSERT INTO audit_events(actor, action, meta) VALUES ('adm@x.pt','signup','{"role":"admin"}'), ('reg@x.pt','signup','{"role":"interviewer"}'), ('adm@x.pt','admin.user_created','{"role":"interviewer"}')`);
    await migrate(d2);
    assert.deepEqual((await d2.query(`SELECT email, self_signup FROM users ORDER BY email`)).map((r: any) => [r.email, r.self_signup]), [['adm@x.pt', false], ['criado@x.pt', false], ['reg@x.pt', true]]);
  } finally { await d2.close(); }
});
