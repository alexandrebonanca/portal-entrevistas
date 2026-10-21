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
const { config } = await import('../src/config.ts');
const A = await import('../src/assistant.ts');
const { FAQ_SEED, seedAssistant } = await import('../src/assistant-faq.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie = '', ip = '10.0.0.1', json = false) =>
  app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie, 'x-forwarded-for': ip, ...(json ? { accept: 'application/json' } : {}) } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const PW = 'uma-palavra-passe-longa';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const nEmails = async () => Number((await db.one('SELECT count(*)::int n FROM emails')).n);
const logOf = (loc: string) => new RegExp(`[?&]r=(${UUID})`).exec(loc)![1];
const seedId = async (key: string, lang = 'pt') => (await db.one('SELECT id FROM assistant_faq WHERE seed_key=$1 AND lang=$2', [key, lang])).id;

let admin = '', ana = '', bruno = '', anaId = '', tcId = '', guest = '', guestPt = '', ivEn = '';
let logins = 0;
const login = async (email: string) => `sid=${cookies(await post('/entrar', { email, password: PW }, '', `10.8.0.${++logins}`)).sid}`;
const newUser = async (name: string, email: string, extra: Record<string, string> = {}) => {
  await post('/admin/utilizadores', { name, email, password: PW, role: 'interviewer', ...extra }, admin);
  return login(email);
};
const invite = async (title: string, lang: 'en' | 'pt-PT', guestName: string, guestEmail: string) => {
  const c = await post('/entrevistas', { title }, admin);
  const id = /\/entrevistas\/([0-9a-f-]{36})\/editar/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/perguntas`, { text: 'Qual é o maior desafio?' }, admin);
  await post(`/entrevistas/${id}/guardar`, { title, objective_text: 'Perceber o mercado', objective_shared: '1', host_name: 'Admin', guest_name: guestName, guest_email: guestEmail, interaction_lang: lang, answer_lang: 'auto', planned_visibility: 'private', subtitle_langs: ['en'], review_policy: 'guest_preview' }, admin);
  await post(`/entrevistas/${id}/convidar`, {}, admin);
  await flushOutbox(db);
  const mail = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [id]);
  const token = /\/i\/([A-Za-z0-9_-]{40,})/.exec(mail.text_body)![1];
  return { id, gs: `gs=${cookies(await post(`/i/${token}/abrir`, {}, '', '10.9.9.9')).gs}` };
};
/** Entradas da semente como a pesquisa as recebe (sem base de dados). */
const seedEntries = (lang: 'pt' | 'en', audience: 'interviewer' | 'guest') => FAQ_SEED.filter(e => e.audience === audience || e.audience === 'all')
  .map((e, i) => ({ id: e.key, lang, audience: e.audience, question: e[lang][0], answer: e[lang][1], keywords: e[lang][2], sort: i * 10 }));

// ======================= pesquisa (unitários) =======================

test('pesquisa: sem acentos, sem palavras vazias, sinónimos pt/en, língua da pergunta', () => {
  assert.equal(A.fold('Ação Pública ÇÃ'), 'acao publica ca');
  assert.deepEqual(A.tokens('Gravação da RESPOSTA, por favor!'), ['gravar', 'resposta']);
  assert.deepEqual(A.tokens('Recording answers'), ['gravar', 'resposta'], 'inglês e português no mesmo sinónimo');
  assert.deepEqual(A.tokens('palavra-passe'), ['password']);
  assert.deepEqual(A.tokens('Esqueci-me da senha'), ['esqueci', 'password']);
  assert.deepEqual(A.tokens('legendas'), A.tokens('subtitles'));
  assert.deepEqual(A.tokens('a o de que'), [], 'só palavras vazias');
  assert.equal(A.detectLang('Como posso gravar a resposta?'), 'pt');
  assert.equal(A.detectLang('How can I record my answer?'), 'en');
  assert.equal(A.detectLang('Ação?'), 'pt', 'acentos portugueses');
  assert.equal(A.detectLang('xyz'), null);
});

test('pesquisa: tapa emails, links do convite, números longos e códigos; valida o tamanho da pergunta', () => {
  const r = A.redact('sou ana.silva@example.com, tel. +351 912 345 678, link https://x.pt/i/abcdefghijklmnop e /i/AbCdEfGhIjKlMnOpQrStUv_-12 e sk_' + 'live_' + 'X'.repeat(26) + ' com 5 minutos');
  assert.match(r, /\[email\]/); assert.match(r, /\[número\]/); assert.match(r, /\[link\]/); assert.match(r, /\[código\]/);
  assert.doesNotMatch(r, /@|912|abcdefghijklmnop|AbCdEf|sk_live/);
  assert.match(r, /5 minutos/, 'números curtos ficam');
  assert.deepEqual(A.cleanQuestion('  '), { ok: false, error: 'empty' });
  assert.deepEqual(A.cleanQuestion('x'.repeat(501)), { ok: false, error: 'long' });
  assert.equal((A.cleanQuestion(' ' + 'x'.repeat(500) + '\u0007 ') as any).text, 'x'.repeat(500));
  assert.equal(A.fillVars('{maxAnswerMin} min · {brand} · {inviteDays} dias · {desconhecido}'), `${config.limits.maxAnswerSeconds / 60} min · ${config.brand} · ${config.limits.inviteDays} dias · {desconhecido}`);
});

test('pesquisa sobre a semente: perguntas reais encontram a entrada certa (pt e en, entrevistador e convidado)', () => {
  const cases: [string, 'pt' | 'en', 'interviewer' | 'guest', string][] = [
    ['Como envio o convite?', 'pt', 'interviewer', 'enviar-convite'],
    ['quanto tempo dura o link', 'pt', 'interviewer', 'validade-link'],
    ['o convidado não recebeu o email', 'pt', 'interviewer', 'nao-recebeu'],
    ['Esqueci-me da senha', 'pt', 'interviewer', 'palavra-passe'],
    ['como mudar de plano', 'pt', 'interviewer', 'planos-conta'],
    ['a voz é clonada?', 'pt', 'interviewer', 'vozes'],
    ['legendas em espanhol', 'pt', 'interviewer', 'linguas'],
    ['posso fazer vídeo com avatar do Veo?', 'pt', 'interviewer', 'video-ia'],
    ['quem é a empresa que vende isto', 'pt', 'interviewer', 'quem-gere'],
    ['como acrescentar mais uma pergunta depois de enviar', 'pt', 'interviewer', 'pergunta-adicional'],
    ['o episódio está desatualizado', 'pt', 'interviewer', 'desatualizado'],
    ['o que é a galeria', 'pt', 'interviewer', 'galeria'],
    ['posso pôr a minha foto', 'pt', 'interviewer', 'fotografia-entrevistador'],
    ['how can I change my password', 'en', 'interviewer', 'palavra-passe'],
    ['what are the plans and prices', 'en', 'interviewer', 'planos-conta'],
    ['what does the entity manager do', 'en', 'interviewer', 'entidade'],
    ['quanto tempo pode ter a resposta', 'pt', 'guest', 'convidado-duracao'],
    ['posso gravar outra vez?', 'pt', 'guest', 'convidado-regravar'],
    ['o microfone não funciona', 'pt', 'guest', 'convidado-microfone'],
    ['não quero participar', 'pt', 'guest', 'convidado-recusar'],
    ['posso continuar mais tarde', 'pt', 'guest', 'convidado-continuar'],
    ['tenho de instalar uma app?', 'pt', 'guest', 'convidado-instalar'],
    ['how long can my answer be', 'en', 'guest', 'convidado-duracao'],
    ['will my voice be cloned', 'en', 'guest', 'convidado-voz'],
    ['delete my data', 'en', 'guest', 'convidado-privacidade'],
    ['can I skip a question', 'en', 'guest', 'convidado-recusar-pergunta'],
    ['how do I contact support', 'en', 'guest', 'convidado-suporte'],
    ['who sells this service', 'en', 'guest', 'quem-gere'],
  ];
  for (const [q, lang, aud, key] of cases) {
    const hits = A.searchFaq(seedEntries(lang, aud), q);
    assert.ok(hits.length >= 1 && hits.length <= 3, `${q}: entre 1 e 3 resultados`);
    assert.equal(hits[0].entry.id, key, `${q} → ${hits.map(h => h.entry.id).join(', ')}`);
  }
  for (const [q, lang] of [['receita de bacalhau com natas', 'pt'], ['what is the weather tomorrow', 'en'], ['sabes cozinhar?', 'pt']] as const)
    assert.deepEqual(A.searchFaq(seedEntries(lang, 'interviewer'), q), [], `${q}: sem resposta`);
  // Uma pergunta só para entrevistadores não aparece aos convidados.
  assert.ok(!A.searchFaq(seedEntries('pt', 'guest'), 'como publico o episódio e que visibilidades existem').some(h => h.entry.id === 'publicar'));
});

test('semente: pt e en em cada entrada, dentro dos limites, marcadores conhecidos, sem preços, mínimos por público', () => {
  const keys = new Set<string>();
  for (const e of FAQ_SEED) {
    assert.ok(!keys.has(e.key), `chave repetida: ${e.key}`); keys.add(e.key);
    for (const lang of ['pt', 'en'] as const) {
      const [q, a, k] = e[lang];
      assert.ok(q && a && k, `${e.key}/${lang} completa`);
      assert.ok(q.length <= A.FAQ_LIMITS.question && a.length <= A.FAQ_LIMITS.answer && k.length <= A.FAQ_LIMITS.keywords, `${e.key}/${lang} dentro dos limites`);
      assert.doesNotMatch(A.fillVars(q + a), /\{\w+\}/, `${e.key}/${lang}: só marcadores conhecidos`);
      assert.doesNotMatch(a, /€|\$\d|\d+ ?(euros|EUR|USD)/, `${e.key}/${lang}: nenhum preço prometido`);
    }
  }
  for (const [aud, min] of [['interviewer', 20], ['guest', 12]] as const) {
    const n = FAQ_SEED.filter(e => e.audience === aud || e.audience === 'all').length;
    assert.ok(n >= min, `${aud}: ${n} entradas (mínimo ${min}) em pt e em en`);
  }
  const by = (k: string) => FAQ_SEED.find(e => e.key === k)!;
  // Os números vêm da configuração em vigor (não ficam escritos na semente).
  assert.match(A.fillVars(by('convidado-duracao').pt[1]), new RegExp(`até ${config.limits.maxAnswerSeconds / 60} minutos`));
  assert.match(A.fillVars(by('convidado-duracao').en[1]), new RegExp(`up to ${config.limits.maxAnswerSeconds / 60} minutes`));
  assert.match(A.fillVars(by('perguntas').pt[1]), new RegExp(`até ${config.limits.maxQuestions} perguntas`));
  assert.match(A.fillVars(by('validade-link').pt[1]), new RegExp(`${config.limits.inviteDays} dias`));
  assert.ok(A.fillVars(by('quem-gere').pt[1]).includes(config.owner.name) && A.fillVars(by('quem-gere').pt[1]).includes(config.seller.name));
  assert.match(by('video-ia').pt[1], /só é pedida pelo administrador/); assert.match(by('video-ia').pt[1], /chegar em breve/);
  assert.match(by('video-ia').en[1], /only be requested by the portal administrator/); assert.match(by('video-ia').en[1], /coming soon/);
});

// ======================= fluxos =======================

test('preparação: semente na base (idempotente, alterações do administrador mantidas), utilizadores e convidados', async () => {
  const n = async () => Number((await db.one('SELECT count(*)::int n FROM assistant_faq')).n);
  assert.equal(await n(), FAQ_SEED.length * 2, 'cada entrada em pt e en');
  const id = await seedId('custos');
  await db.query(`UPDATE assistant_faq SET answer='Resposta alterada pelo administrador.' WHERE id=$1`, [id]);
  await seedAssistant(db);
  assert.equal(await n(), FAQ_SEED.length * 2, 'semear de novo não duplica');
  assert.equal((await db.one('SELECT answer FROM assistant_faq WHERE id=$1', [id])).answer, 'Resposta alterada pelo administrador.', 'a alteração fica');
  await db.query(`UPDATE assistant_faq SET answer=$2 WHERE id=$1`, [id, FAQ_SEED.find(e => e.key === 'custos')!.pt[1]]);
  // o registo não tem colunas de quem perguntou
  const cols = (await db.query(`SELECT column_name FROM information_schema.columns WHERE table_name='assistant_questions'`)).map((r: any) => r.column_name);
  for (const c of ['user_id', 'interview_id', 'ip', 'email', 'entity_id']) assert.ok(!cols.includes(c), `sem ${c}`);

  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  tcId = (await db.one(`SELECT id FROM entities WHERE slug='telecert-formacao'`)).id;
  ana = await newUser('Ana', 'ana@example.com', { entity_id: tcId });
  anaId = (await db.one(`SELECT id FROM users WHERE email='ana@example.com'`)).id;
  bruno = await newUser('Bruno', 'bruno@example.com');
  ({ id: ivEn, gs: guest } = await invite('Fibra ótica em Portugal', 'en', 'Rui', 'rui@example.com'));
  ({ gs: guestPt } = await invite('Energia solar', 'pt-PT', 'Marta', 'marta@example.com'));
  assert.ok(ana && bruno && guest && guestPt);
});

test('utilizador: pergunta, resposta com as entradas (AI_MOCK), registo sem dados pessoais, «ajudou» só por quem perguntou', async () => {
  const emails = await nEmails();
  const help = await get('/ajuda', ana);
  assert.equal(help.statusCode, 200);
  assert.match(help.body, /<h2 id="h-as"[^>]*>Assistente virtual<\/h2>/);
  assert.match(help.body, /<form method="post" action="\/ajuda\/assistente" data-as>/);
  assert.match(help.body, /<label for="as-q">A sua pergunta<\/label>/);
  assert.match(help.body, /Ver todas as perguntas frequentes \(\d+\)/);
  assert.match(help.body, /<summary>Como envio o convite ao entrevistado\?<\/summary>/, 'perguntas para entrevistadores');
  assert.match(help.body, /<summary>Quem gere e quem comercializa o quietinterview\?<\/summary>/, 'as de «todos», com o marcador preenchido');
  assert.doesNotMatch(help.body, /Como gravo uma resposta\?/, 'sem as perguntas só para convidados');
  assert.match(help.body, /<script src="\/static\/assistant\.js" defer><\/script>/);
  assert.ok(help.body.indexOf('id="assistente"') < help.body.indexOf('id="suporte"'), 'assistente antes de «Falar com o suporte»');

  const r = await post('/ajuda/assistente', { q: 'Como envio o convite? Sou a ana@example.com' }, ana);
  assert.equal(r.statusCode, 303);
  assert.match(r.headers.location as string, new RegExp(`^/ajuda\\?r=${UUID}&s=[A-Za-z0-9_%-]+#as-resposta$`));
  const id = logOf(r.headers.location as string);
  const log = await db.one('SELECT * FROM assistant_questions WHERE id=$1', [id]);
  assert.equal(log.lang, 'pt'); assert.equal(log.audience, 'interviewer'); assert.equal(log.mode, 'local'); assert.equal(log.answered, true); assert.equal(log.answer, null);
  assert.equal(log.question, 'Como envio o convite? Sou a [email]', 'email tapado no registo');
  assert.equal(log.faq_ids[0], await seedId('enviar-convite'));
  assert.ok(log.faq_ids.length <= 3);

  const page = await get(r.headers.location as string, ana);
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /Perguntou: «Como envio o convite\? Sou a \[email\]»/);
  assert.match(page.body, /<h3 class="as-h">Como envio o convite ao entrevistado\?<\/h3><p class="msgbody">Na página de edição, carregue em «Rever e convidar»/);
  assert.match(page.body, new RegExp(`<form method="post" action="/ajuda/assistente/${id}/ajudou" class="as-fb" data-as>`));
  assert.match(page.body, /Isto ajudou\?/);
  assert.match(page.body, new RegExp(`href="/ajuda\\?r=${id}&amp;s=[^"]+&amp;apoio=1#suporte">Falar com o suporte</a>`));

  // Outro utilizador, com o mesmo link, não vê a resposta nem pode dizer se ajudou.
  const other = await get(r.headers.location as string, bruno);
  assert.doesNotMatch(other.body, /id="as-resposta"|Perguntou:/); assert.match(other.body, /Esta resposta já não está disponível/);
  assert.match((await get(`/ajuda?r=${id}`, ana)).body, /Esta resposta já não está disponível/, 'sem assinatura');
  const s = decodeURIComponent(/[?&]s=([^&#]+)/.exec(r.headers.location as string)![1]);
  assert.equal((await post(`/ajuda/assistente/${id}/ajudou`, { s, v: 'sim' }, bruno)).statusCode, 404);
  assert.equal((await post(`/ajuda/assistente/${id}/ajudou`, { s: s.slice(0, -2) + 'xx', v: 'sim' }, ana)).statusCode, 404);
  assert.equal((await post(`/entrevista/ajuda/assistente/${id}/ajudou`, { s, v: 'sim' }, guest)).statusCode, 404, 'nem o convidado');
  assert.equal((await db.one('SELECT helped FROM assistant_questions WHERE id=$1', [id])).helped, null);

  const yes = await post(`/ajuda/assistente/${id}/ajudou`, { s, v: 'sim' }, ana);
  assert.equal(yes.statusCode, 303);
  assert.match(yes.headers.location as string, /#as-resposta$/);
  assert.equal((await db.one('SELECT helped FROM assistant_questions WHERE id=$1', [id])).helped, true);
  const after = await get(yes.headers.location as string, ana);
  assert.match(after.body, /Obrigado pela resposta\./);
  assert.doesNotMatch(after.body, /class="as-fb"/);
  assert.equal(await nEmails(), emails, 'nenhum email');
});

test('«Não ajudou» → pedido ao suporte já com a pergunta e a resposta do assistente', async () => {
  const emails = await nEmails();
  const r = await post('/ajuda/assistente', { q: 'Como altero a minha palavra-passe?' }, ana);
  const id = logOf(r.headers.location as string);
  const s = decodeURIComponent(/[?&]s=([^&#]+)/.exec(r.headers.location as string)![1]);
  const no = await post(`/ajuda/assistente/${id}/ajudou`, { s, v: 'nao' }, ana);
  assert.equal(no.statusCode, 303);
  assert.match(no.headers.location as string, /&apoio=1#suporte$/);
  assert.equal((await db.one('SELECT helped FROM assistant_questions WHERE id=$1', [id])).helped, false);

  const pg = await get(no.headers.location as string, ana);
  assert.match(pg.body, /Lamentamos\. Envie a pergunta ao suporte/);
  assert.match(pg.body, /A sua pergunta e a resposta do assistente seguem com o pedido/);
  assert.match(pg.body, new RegExp(`<form method="post" action="/ajuda/assistente/${id}/suporte"><input type="hidden" name="s" value="[^"]+">`));
  assert.match(pg.body, /<textarea id="sp-m" name="message"[^>]*>Como altero a minha palavra-passe\?<\/textarea>/);
  assert.equal(pg.body.split('id="sp-m"').length - 1, 1, 'um só formulário de suporte na página');

  // erros: mensagem vazia (formulário mantém-se), assinatura errada
  const empty = await post(`/ajuda/assistente/${id}/suporte`, { s, subject: '', message: '  ' }, ana);
  assert.equal(empty.statusCode, 422);
  assert.match(empty.body, new RegExp(`action="/ajuda/assistente/${id}/suporte"`));
  assert.equal((await post(`/ajuda/assistente/${id}/suporte`, { s: 'x', message: 'olá' }, ana)).statusCode, 404);
  assert.equal((await post(`/ajuda/assistente/${id}/suporte`, { s, message: 'olá' }, bruno)).statusCode, 404);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM support_threads WHERE origin='assistant'`)).n), 0);

  const sent = await post(`/ajuda/assistente/${id}/suporte`, { s, subject: '', message: 'Como altero a minha palavra-passe?\nJá tentei e não consegui.' }, ana);
  assert.equal(sent.statusCode, 302);
  const tid = new RegExp(`^/ajuda/(${UUID})\\?ok=sent$`).exec(sent.headers.location as string)![1];
  const th = await db.one('SELECT * FROM support_threads WHERE id=$1', [tid]);
  assert.equal(th.origin, 'assistant'); assert.equal(th.user_id, anaId); assert.equal(th.entity_id, tcId); assert.equal(th.lang, 'pt-PT'); assert.equal(th.unread_admin, true);
  assert.equal(th.subject, 'Como altero a minha palavra-passe?');
  const msgs = await db.query('SELECT author, body FROM support_messages WHERE thread_id=$1 ORDER BY created_at', [tid]);
  assert.equal(msgs.length, 2);
  assert.deepEqual([msgs[0].author, msgs[0].body], ['user', 'Como altero a minha palavra-passe?\nJá tentei e não consegui.']);
  assert.equal(msgs[1].author, 'assistant');
  assert.match(msgs[1].body, /^Respostas mostradas pelo assistente:\n\n— Como altero a minha palavra-passe\?\nAinda não há alteração nem recuperação automática/);
  assert.equal((await db.one('SELECT escalated FROM assistant_questions WHERE id=$1', [id])).escalated, true);
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='support.thread_opened' AND meta->>'via'='assistant' AND meta->>'threadId'=$1`, [tid]));
  // o mesmo formulário enviado outra vez (clique duplo) não abre um segundo pedido
  const twice = await post(`/ajuda/assistente/${id}/suporte`, { s, subject: '', message: 'Como altero a minha palavra-passe?' }, ana);
  assert.equal(twice.headers.location, '/ajuda#pedidos');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM support_threads WHERE origin='assistant'`)).n), 1);

  const mine = await get(`/ajuda/${tid}`, ana);
  assert.match(mine.body, /<strong>Assistente virtual<\/strong>/);
  const inbox = await get('/admin/suporte', admin);
  assert.match(inbox.body, /<td>Assistente virtual<\/td>/);
  const at = await get(`/admin/suporte/${tid}`, admin);
  assert.match(at.body, /<strong>Origem:<\/strong> Assistente virtual/);
  assert.match(at.body, /<div class="msg assistant"><p class="who hint sans"><strong>Assistente virtual<\/strong>/);
  // depois de enviado, a resposta mostra que já foi ao suporte e o formulário volta ao normal
  const again = await get(no.headers.location as string, ana);
  assert.match(again.body, /Pedido enviado\. A resposta aparece nesta página\./);
  assert.match(again.body, /<form method="post" action="\/ajuda"><label for="sp-s">/);
  assert.equal(await nEmails(), emails, 'nenhum email');
});

test('com JavaScript: resposta, «ajudou» e erros em JSON, sem recarregar', async () => {
  const r = await post('/ajuda/assistente', { q: 'Quanto custa processar uma entrevista?' }, ana, '10.0.0.1', true);
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.match(j.url, new RegExp(`^/ajuda\\?r=${UUID}&s=`));
  assert.match(j.html, /<div id="as-resposta" class="as-res" tabindex="-1">/);
  assert.match(j.html, /Utilização registada/);
  const id = logOf(j.url), s = decodeURIComponent(/[?&]s=([^&#]+)/.exec(j.url)![1]);
  const yes = (await post(`/ajuda/assistente/${id}/ajudou`, { s, v: 'sim' }, ana, '10.0.0.1', true)).json();
  assert.match(yes.html, /Obrigado pela resposta\./);
  const r2 = (await post('/ajuda/assistente', { q: 'como mudar de plano' }, ana, '10.0.0.1', true)).json();
  const no = (await post(`/ajuda/assistente/${logOf(r2.url)}/ajudou`, { s: decodeURIComponent(/[?&]s=([^&#]+)/.exec(r2.url)![1]), v: 'nao' }, ana, '10.0.0.1', true)).json();
  assert.match(no.redirect, /&apoio=1#suporte$/);
  const bad = await post('/ajuda/assistente', { q: ' ' }, ana, '10.0.0.1', true);
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().error, 'Escreva a sua pergunta.');
  assert.match(bad.json().html, /class="flash bad"/);
});

test('convidado (inglês): perguntas para convidados, resposta na língua da pergunta e pedido ligado à entrevista', async () => {
  const help = await get('/entrevista/ajuda', guest);
  assert.equal(help.statusCode, 200);
  assert.match(help.body, /<html lang="en">/);
  assert.match(help.body, />Virtual assistant<\/h2>/);
  assert.match(help.body, /<form method="post" action="\/entrevista\/ajuda\/assistente" data-as>/);
  assert.match(help.body, /<summary>How do I record an answer\?<\/summary>/);
  assert.doesNotMatch(help.body, /How do I create an interview\?/, 'sem as perguntas dos entrevistadores');

  const r = await post('/entrevista/ajuda/assistente', { q: 'How long can my answer be?' }, guest);
  assert.equal(r.statusCode, 303);
  assert.match(r.headers.location as string, /^\/entrevista\/ajuda\?r=/);
  const id = logOf(r.headers.location as string);
  const pg = await get(r.headers.location as string, guest);
  assert.match(pg.body, /You asked: “How long can my answer be\?”/);
  assert.match(pg.body, new RegExp(`Each answer can be up to ${config.limits.maxAnswerSeconds / 60} minutes`));
  assert.match(pg.body, /Did this help\?/);
  const log = await db.one('SELECT * FROM assistant_questions WHERE id=$1', [id]);
  assert.equal(log.lang, 'en'); assert.equal(log.audience, 'guest');

  // Convidado com páginas em português que pergunta em inglês: resposta em inglês.
  const en = await post('/entrevista/ajuda/assistente', { q: 'How long can my answer be?' }, guestPt);
  const pgPt = await get(en.headers.location as string, guestPt);
  assert.match(pgPt.body, /<html lang="pt-PT">/);
  assert.match(pgPt.body, /Each answer can be up to/);
  // E em português, a resposta em português.
  const pt = await get((await post('/entrevista/ajuda/assistente', { q: 'Posso gravar outra vez a resposta?' }, guestPt)).headers.location as string, guestPt);
  assert.match(pt.body, /<h3 class="as-h">Posso gravar de novo uma resposta\?<\/h3>/);

  // Isolamento: o utilizador não usa as páginas do convidado; o convidado não vê respostas de outros.
  assert.equal((await post('/entrevista/ajuda/assistente', { q: 'olá' }, ana)).headers.location, '/');
  const s = decodeURIComponent(/[?&]s=([^&#]+)/.exec(r.headers.location as string)![1]);
  assert.match((await get(`/entrevista/ajuda?r=${id}&s=${encodeURIComponent(s)}`, guestPt)).body, /This answer is no longer available|Esta resposta já não está disponível/);
  assert.match((await get(`/ajuda?r=${id}&s=${encodeURIComponent(s)}`, ana)).body, /Esta resposta já não está disponível/);

  // «No» → pedido ao suporte ligado à entrevista, em inglês
  const no = await post(`/entrevista/ajuda/assistente/${id}/ajudou`, { s, v: 'nao' }, guest);
  assert.match(no.headers.location as string, /^\/entrevista\/ajuda\?r=.*&apoio=1#suporte$/);
  const form2 = await get(no.headers.location as string, guest);
  assert.match(form2.body, /Your question and the assistant’s answer are sent with the request/);
  const sent = await post(`/entrevista/ajuda/assistente/${id}/suporte`, { s, subject: 'Answer length', message: 'How long can my answer be?\nI need 10 minutes.' }, guest);
  const tid = new RegExp(`^/entrevista/ajuda/(${UUID})\\?ok=sent$`).exec(sent.headers.location as string)![1];
  const th = await db.one('SELECT * FROM support_threads WHERE id=$1', [tid]);
  assert.equal(th.interview_id, ivEn); assert.equal(th.user_id, null); assert.equal(th.origin, 'assistant'); assert.equal(th.lang, 'en');
  const msgs = await db.query('SELECT author, body FROM support_messages WHERE thread_id=$1 ORDER BY created_at', [tid]);
  assert.deepEqual(msgs.map((m: any) => m.author), ['guest', 'assistant']);
  assert.match(msgs[1].body, /^Answers shown by the assistant:/);
  const at = await get(`/admin/suporte/${tid}`, admin);
  assert.match(at.body, /<strong>Entrevista:<\/strong> <a href="\/entrevistas\/[0-9a-f-]{36}">Fibra ótica em Portugal<\/a>/);
  assert.match(at.body, /<strong>Convidado:<\/strong> Rui/);

  // O administrador pode experimentar o assistente, sem enviar pedidos a si próprio.
  const ad = await get((await post('/ajuda/assistente', { q: 'Como envio o convite?' }, admin)).headers.location as string, admin);
  assert.match(ad.body, /Rever e convidar/);
  assert.doesNotMatch(ad.body, /apoio=1/);
});

test('sem resposta: o administrador vê a pergunta, cria, edita e desativa entradas e marca a pergunta como tratada', async () => {
  const r = await post('/ajuda/assistente', { q: 'Receita de bacalhau com natas' }, ana);
  const id = logOf(r.headers.location as string);
  const pg = await get(r.headers.location as string, ana);
  assert.match(pg.body, /Não encontrei resposta a isto nas perguntas frequentes\./);
  assert.doesNotMatch(pg.body, /class="as-fb"/, 'sem «Isto ajudou?» quando não há resposta');
  assert.match(pg.body, /apoio=1#suporte">Falar com o suporte<\/a>/);
  const log = await db.one('SELECT * FROM assistant_questions WHERE id=$1', [id]);
  assert.equal(log.answered, false); assert.deepEqual(log.faq_ids, []);
  // escape do texto da pergunta
  const x = await get((await post('/ajuda/assistente', { q: '<img src=x onerror=alert(1)> convite' }, ana)).headers.location as string, ana);
  assert.match(x.body, /Perguntou: «&lt;img src=x onerror=alert\(1\)&gt; convite»/);
  assert.doesNotMatch(x.body, /<img src=x/);
  await post('/ajuda/assistente', { q: 'zzqx <b>wwk</b> yyv' }, ana);

  assert.equal((await get('/admin/assistente', ana)).statusCode, 403);
  assert.equal((await get('/admin/assistente', guest)).statusCode, 302);
  assert.equal((await post('/admin/assistente', { lang: 'pt', audience: 'all', question: 'x', answer: 'y' }, ana)).statusCode, 403);
  const adm = await get('/admin/assistente', admin);
  assert.equal(adm.statusCode, 200);
  assert.match(adm.body, /<a href="\/admin\/assistente">Assistente<\/a>/, 'na navegação do administrador');
  assert.match(adm.body, /Perguntas a melhorar/);
  assert.match(adm.body, /Receita de bacalhau com natas/);
  assert.match(adm.body, /Como altero a minha palavra-passe\?<\/span>/, 'a que «não ajudou» também');
  assert.match(adm.body, /pill bad">sem resposta/); assert.match(adm.body, /pill warn">não ajudou/); assert.match(adm.body, /enviada ao suporte/);
  assert.match(adm.body, /zzqx &lt;b&gt;wwk&lt;\/b&gt; yyv/);
  assert.doesNotMatch(adm.body, /<b>wwk<\/b>/);
  assert.doesNotMatch(adm.body, /Quanto custa processar uma entrevista\?<\/span>/, 'as que ajudaram não estão por tratar');
  assert.match(adm.body, /Base de conhecimento/);
  assert.match(adm.body, /\d+ perguntas · \d+ sem resposta · \d+ ajudou · \d+ não ajudou · \d+ enviadas ao suporte/);

  // filtros da base
  const en = await get('/admin/assistente?lingua=en&publico=guest', admin);
  assert.match(en.body, />How do I record an answer\?<\/a>/);
  assert.doesNotMatch(en.body, />Como gravo uma resposta\?<\/a>/);
  assert.doesNotMatch(en.body, />How do I create an interview\?<\/a>/);

  // «Criar entrada» a partir da pergunta registada
  const nova = await get(`/admin/assistente/nova?de=${id}`, admin);
  assert.match(nova.body, /<input id="f-q" name="question" type="text" required maxlength="300" value="Receita de bacalhau com natas">/);
  assert.match(nova.body, /<code>\{maxAnswerMin\}<\/code>/, 'marcadores explicados');
  const bad = await post('/admin/assistente', { lang: 'pt', audience: 'interviewer', question: 'Só pergunta', answer: '   ', sort: '5', active: '1' }, admin);
  assert.equal(bad.statusCode, 422);
  assert.match(bad.body, /Escreva a pergunta e a resposta\./);
  const created = await post('/admin/assistente', { lang: 'pt', audience: 'interviewer', question: 'Há receitas no portal?', keywords: 'bacalhau, receita, natas, culinária',
    answer: 'Não. O {brand} é um portal de entrevistas.\nPara outra dúvida, fale com o suporte.', sort: '5', active: '1' }, admin);
  assert.equal(created.statusCode, 302);
  assert.equal(created.headers.location, '/admin/assistente?ok=created#base');
  const e = await db.one(`SELECT * FROM assistant_faq WHERE question='Há receitas no portal?'`);
  assert.equal(e.seed_key, null); assert.equal(e.active, true); assert.equal(e.sort, 5);
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='assistant.faq_created' AND meta->>'faqId'=$1`, [e.id]));

  const found = await get((await post('/ajuda/assistente', { q: 'Receita de bacalhau com natas' }, ana)).headers.location as string, ana);
  assert.match(found.body, /<h3 class="as-h">Há receitas no portal\?<\/h3><p class="msgbody">Não\. O quietinterview é um portal de entrevistas\.\nPara outra dúvida/);

  const ed = await get(`/admin/assistente/${e.id}`, admin);
  assert.match(ed.body, /Entrada criada pelo administrador/);
  assert.match(ed.body, /Pré-visualização<\/h2><p><strong>Há receitas no portal\?<\/strong><\/p><p class="msgbody">Não\. O quietinterview é/);
  const saved = await post(`/admin/assistente/${e.id}`, { lang: 'pt', audience: 'interviewer', question: 'Há receitas no portal?', keywords: 'bacalhau, receita', answer: 'Não: só entrevistas.', sort: '7', active: '1' }, admin);
  assert.equal(saved.headers.location, '/admin/assistente?ok=saved#base');
  assert.equal((await db.one('SELECT answer, sort FROM assistant_faq WHERE id=$1', [e.id])).answer, 'Não: só entrevistas.');
  // editar uma entrada da semente: fica e não volta atrás com a semente
  const sid = await seedId('galeria');
  await post(`/admin/assistente/${sid}`, { lang: 'pt', audience: 'interviewer', question: 'O que é a galeria pública «Podcasts gerados»?', keywords: 'galeria', answer: 'Texto novo da galeria.', sort: '1', active: '1' }, admin);
  await seedAssistant(db);
  assert.equal((await db.one('SELECT answer FROM assistant_faq WHERE id=$1', [sid])).answer, 'Texto novo da galeria.');

  const off = await post(`/admin/assistente/${e.id}/estado`, { active: '0' }, admin);
  assert.equal(off.headers.location, '/admin/assistente?ok=off#base');
  const gone = await get((await post('/ajuda/assistente', { q: 'Receita de bacalhau com natas' }, ana)).headers.location as string, ana);
  assert.match(gone.body, /Não encontrei resposta/, 'entrada desativada deixa de ser usada');
  assert.doesNotMatch((await get('/ajuda', ana)).body, /Há receitas no portal\?/, 'nem aparece na lista');

  const done = await post(`/admin/assistente/perguntas/${id}/tratada`, {}, admin);
  assert.equal(done.headers.location, '/admin/assistente?ok=reviewed#h-melhorar');
  assert.equal((await db.one('SELECT reviewed FROM assistant_questions WHERE id=$1', [id])).reviewed, true);
  const list = await get(done.headers.location as string, admin);
  assert.match(list.body, /Pergunta marcada como tratada\./);
  assert.ok(!new RegExp(`/admin/assistente/perguntas/${id}/tratada`).test(list.body), 'sai da lista por tratar');
  assert.match((await get('/admin/assistente?perguntas=todas', admin)).body, new RegExp(`nova\\?de=${id}`), 'continua em «todas»');
  assert.equal((await get('/admin/assistente/00000000-0000-0000-0000-000000000000', admin)).statusCode, 404);
});

test('limites: pergunta vazia ou longa; 20 perguntas por hora por pessoa e 60 por IP; o mesmo para convidados', async () => {
  const empty = await post('/ajuda/assistente', { q: '' }, ana);
  assert.equal(empty.statusCode, 422);
  assert.match(empty.body, /Escreva a sua pergunta\./);
  const long = await post('/ajuda/assistente', { q: 'x'.repeat(501) }, ana);
  assert.equal(long.statusCode, 422);
  assert.match(long.body, /A pergunta tem mais de 500 caracteres\./);
  assert.match(long.body, /<textarea id="as-q"[^>]*>x{501}<\/textarea>/, 'o texto fica no formulário');

  const carla = await newUser('Carla', 'carla@example.com');
  for (let i = 0; i < A.ASSISTANT_RATE.perAsker; i++) assert.equal((await post('/ajuda/assistente', { q: `Como envio o convite ${i}?` }, carla, '10.50.0.1')).statusCode, 303);
  const over = await post('/ajuda/assistente', { q: 'Como envio o convite?' }, carla, '10.50.0.1');
  assert.equal(over.statusCode, 429);
  assert.match(over.body, /Fez muitas perguntas na última hora/);
  assert.equal((await post('/ajuda/assistente', { q: 'Como envio o convite?' }, carla, '10.50.0.2')).statusCode, 429, 'mudar de IP não ajuda');
  // por IP: mais duas pessoas no mesmo IP chegam às 60
  for (const [name, email] of [['Dina', 'dina@example.com'], ['Eva', 'eva@example.com']]) {
    const c = await newUser(name, email);
    for (let i = 0; i < A.ASSISTANT_RATE.perAsker; i++) assert.equal((await post('/ajuda/assistente', { q: 'Como envio o convite?' }, c, '10.60.0.1')).statusCode, 303);
  }
  const fil = await newUser('Filipa', 'filipa@example.com');
  for (let i = 0; i < A.ASSISTANT_RATE.perIp - 2 * A.ASSISTANT_RATE.perAsker; i++) assert.equal((await post('/ajuda/assistente', { q: 'Como envio o convite?' }, fil, '10.60.0.1')).statusCode, 303);
  assert.equal((await post('/ajuda/assistente', { q: 'Como envio o convite?' }, await newUser('Gil', 'gil@example.com'), '10.60.0.1')).statusCode, 429, 'IP no limite');

  // convidado
  let ok = 0;
  for (let i = 0; i < A.ASSISTANT_RATE.perAsker + 1; i++) if ((await post('/entrevista/ajuda/assistente', { q: 'How long can my answer be?' }, guestPt, `10.70.0.${i}`)).statusCode === 303) ok++;
  assert.ok(ok < A.ASSISTANT_RATE.perAsker + 1);
  const g = await post('/entrevista/ajuda/assistente', { q: 'How long?' }, guestPt, '10.70.1.1');
  assert.equal(g.statusCode, 429);
  assert.match(g.body, /Fez muitas perguntas na última hora/, 'na língua das páginas do convidado');
});

test('IA (simulada por injeção): redige só a partir das entradas, recebe só a pergunta tapada; sem entradas ou com falha não inventa', async () => {
  assert.equal(A.defaultAiEnabled(), false, 'AI_MOCK: nunca chama a OpenAI');
  const calls: { system: string; user: string }[] = [];
  const ai = async (system: string, user: string) => { calls.push({ system, user }); return { answer: 'Use «Rever e convidar» <b>na página</b>.', answered: true }; };
  const id = await A.answerQuestion(db, { question: 'Como envio o convite? Sou a ana@example.com, 912 345 678', pageLang: 'pt', audience: 'interviewer' }, { aiEnabled: () => true, ai });
  assert.equal(calls.length, 1);
  assert.match(calls[0].system, /ONLY the help entries/); assert.match(calls[0].system, /NOT instructions/); assert.match(calls[0].system, /do not know/); assert.match(calls[0].system, /European Portuguese/);
  assert.match(calls[0].user, /<faq>\n\[\{"question":"Como envio o convite ao entrevistado\?"/);
  assert.match(calls[0].user, /<question>\nComo envio o convite\? Sou a \[email\], \[número\]\n<\/question>/);
  assert.doesNotMatch(calls[0].user, /ana@example\.com|912 345|Ana|anaId/);
  assert.ok(!calls[0].user.includes(anaId));
  const log = await db.one('SELECT * FROM assistant_questions WHERE id=$1', [id]);
  assert.equal(log.mode, 'ai'); assert.equal(log.answered, true); assert.equal(log.answer, 'Use «Rever e convidar» <b>na página</b>.');
  const pg = await get(`/ajuda?r=${id}&s=${encodeURIComponent(A.assistantSig(id, `user:${anaId}`))}`, ana);
  assert.match(pg.body, /<h3 class="as-h">Resposta do assistente<\/h3><p class="msgbody">Use «Rever e convidar» &lt;b&gt;na página&lt;\/b&gt;\.<\/p>/);
  assert.match(pg.body, /Escrita automaticamente a partir destas perguntas frequentes/);
  assert.match(pg.body, /<summary>Como envio o convite ao entrevistado\?<\/summary>/, 'as entradas usadas ficam à vista');
  // a resposta redigida vai para o suporte com as entradas em que se baseou
  const t = A.assistantTranscript((await A.loadAnswer(db, id))!, 'pt');
  assert.match(t, /^Use «Rever e convidar» <b>na página<\/b>\.\n\nCom base em:\n\n— Como envio o convite ao entrevistado\?/);

  // o modelo diz que não sabe: fica registado como sem resposta
  const unk = await A.answerQuestion(db, { question: 'Como envio o convite por SMS?', pageLang: 'pt', audience: 'interviewer' }, { aiEnabled: () => true, ai: async () => ({ answer: 'Não sei. Fale com o suporte.', answered: false }) });
  assert.equal((await db.one('SELECT answered FROM assistant_questions WHERE id=$1', [unk])).answered, false);
  // falha do modelo: ficam as entradas encontradas
  const fail = await A.answerQuestion(db, { question: 'Como envio o convite?', pageLang: 'pt', audience: 'interviewer' }, { aiEnabled: () => true, ai: async () => { throw new Error('timeout'); } });
  const fl = await db.one('SELECT * FROM assistant_questions WHERE id=$1', [fail]);
  assert.equal(fl.mode, 'local'); assert.equal(fl.answer, null); assert.equal(fl.answered, true);
  // sem entradas: o modelo nem é chamado
  calls.length = 0;
  const none = await A.answerQuestion(db, { question: 'receita de arroz de pato', pageLang: 'pt', audience: 'interviewer' }, { aiEnabled: () => true, ai });
  assert.equal(calls.length, 0);
  assert.equal((await db.one('SELECT answered, mode FROM assistant_questions WHERE id=$1', [none])).mode, 'local');
});

test('registo: apagado ao fim de 180 dias (trabalho periódico e consulta do administrador)', async () => {
  const ins = (days: number) => db.one(`INSERT INTO assistant_questions(lang, audience, question, answered, created_at) VALUES ('pt','guest','antiga',false, now() - make_interval(days => $1)) RETURNING id`, [days]);
  const old = await ins(181), recent = await ins(179);
  assert.equal(await A.purgeAssistantLog(db, true), 1);
  assert.equal(await db.one('SELECT 1 FROM assistant_questions WHERE id=$1', [old.id]), undefined);
  assert.ok(await db.one('SELECT 1 FROM assistant_questions WHERE id=$1', [recent.id]));
  assert.equal(await A.purgeAssistantLog(db), 0, 'no máximo uma vez por hora sem «force»');
  const older = await ins(200);
  await get('/admin/assistente', admin);
  assert.equal(await db.one('SELECT 1 FROM assistant_questions WHERE id=$1', [older.id]), undefined, 'a página do administrador limpa antes de mostrar');
});
