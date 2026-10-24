import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';
process.env.ASSISTANT_AI_PER_HOUR = '5'; // teto global de respostas redigidas pela IA (testado com a IA simulada por injeção)

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { config } = await import('../src/config.ts');
const A = await import('../src/assistant.ts');
const { helpRequest, parseHelp, HELP_MAX_TOKENS } = await import('../src/ai/openai.ts');
const { FAQ_SEED, seedAssistant, seedRows } = await import('../src/assistant-faq.ts');
const { LEGACY_SEED_HASHES } = await import('../src/assistant-faq-legacy.ts');
const W = await import('../src/wallet.ts');
const { QUOTE_VALID_DAYS } = await import('../src/quotes.ts');
const { SUPPORT_RATE } = await import('../src/support.ts');

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
  // Formas verbais: «apago» encontra «apagar», «partilho» encontra «partilhar», «anulo» encontra «anular».
  assert.deepEqual(A.tokens('apago'), A.tokens('apagar'));
  assert.deepEqual(A.tokens('elimino'), A.tokens('eliminar'));
  assert.deepEqual(A.tokens('anulo'), A.tokens('anular'));
  assert.deepEqual(A.tokens('partilho'), A.tokens('partilhar'));
  assert.deepEqual(A.tokens('apagamos'), A.tokens('apagou'));
  assert.notDeepEqual(A.tokens('convidado'), A.tokens('convidar'), 'o convidado não é o convite');
  // Espanhol e francês não passam por português só por terem acentos: fica a língua da página.
  for (const q of ['¿Mi foto será pública?', '¿Puedo hacer un vídeo con mis fotos?', 'Où est le lien vidéo ?', 'Mi foto será pública']) assert.equal(A.detectLang(q), null, q);
  assert.equal(A.detectLang('A minha fotografia será pública?'), 'pt');
  assert.equal(A.detectLang('Não recebi'), 'pt', 'o til só existe em português');
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
    // formas verbais e perguntas naturais
    ['Como apago uma entrevista?', 'pt', 'interviewer', 'cancelar'],
    ['Como elimino a entrevista?', 'pt', 'interviewer', 'cancelar'],
    ['Como anulo a entrevista?', 'pt', 'interviewer', 'cancelar'],
    ['Como partilho o episódio?', 'pt', 'interviewer', 'publicar'],
    ['Como publico o episódio?', 'pt', 'interviewer', 'publicar'],
    ['How do I publish?', 'en', 'interviewer', 'publicar'],
    ['Who can see the episode?', 'en', 'interviewer', 'publicar'],
    ['Quem pode ver o episódio?', 'pt', 'interviewer', 'publicar'],
    ['Quem gere o portal?', 'pt', 'interviewer', 'quem-gere'],
    ['Quem é o dono do portal?', 'pt', 'interviewer', 'quem-gere'],
    ['Quem é a Certif?', 'pt', 'interviewer', 'quem-gere'],
    ['Who runs this portal?', 'en', 'interviewer', 'quem-gere'],
    ['Who owns this website?', 'en', 'interviewer', 'quem-gere'],
    ['Who runs this portal?', 'en', 'guest', 'quem-gere'],
    ['O que acontece às perguntas que faço ao assistente?', 'pt', 'interviewer', 'assistente-privacidade'],
    ['Who can listen to my episode?', 'en', 'guest', 'convidado-publicacao'],
    // o que este ramo acrescenta: créditos, orçamentos, regenerações, limites, introdução, grafismo, faturação
    ['Como carrego créditos?', 'pt', 'interviewer', 'creditos'],
    ['How do I top up credits?', 'en', 'interviewer', 'creditos'],
    ['Quanto custa animar o vídeo com IA?', 'pt', 'interviewer', 'video-ia'],
    ['Como aceito o orçamento?', 'pt', 'interviewer', 'orcamento-aceitar'],
    ['How do I accept the quote?', 'en', 'interviewer', 'orcamento-aceitar'],
    ['Quantas regenerações tenho?', 'pt', 'interviewer', 'regeneracoes'],
    ['How many times can I regenerate?', 'en', 'interviewer', 'regeneracoes'],
    ['Acabaram as entrevistas do meu plano', 'pt', 'interviewer', 'entrevista-extra'],
    ['Posso enviar mais convites este mês?', 'pt', 'interviewer', 'entrevista-extra'],
    ['Quanto tempo pode durar a entrevista?', 'pt', 'interviewer', 'limites-entrevista'],
    ['O que é a introdução animada?', 'pt', 'interviewer', 'introducao-animada'],
    ['What is the animated introduction?', 'en', 'interviewer', 'introducao-animada'],
    ['Como funcionam os reembolsos?', 'pt', 'interviewer', 'devolucoes'],
    ['How do refunds work?', 'en', 'interviewer', 'devolucoes'],
    ['Quem emite a fatura?', 'pt', 'interviewer', 'faturas-iva'],
    ['Como é calculado o IVA?', 'pt', 'interviewer', 'faturas-iva'],
    ['O que está incluído no plano?', 'pt', 'interviewer', 'custos'],
    ['Que grafismo tem o vídeo?', 'pt', 'interviewer', 'grafismo-video'],
    ['cartão de título', 'pt', 'interviewer', 'grafismo-video'],
    ['O gestor de entidade precisa de subscrição?', 'pt', 'interviewer', 'entidade'],
    ['Que planos existem?', 'pt', 'interviewer', 'planos-conta'],
    ['O meu nome aparece no vídeo?', 'pt', 'guest', 'convidado-nome-video'],
    ['Will my name be shown in the video?', 'en', 'guest', 'convidado-nome-video'],
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
  // O que já existe não se promete para depois.
  for (const e of FAQ_SEED) for (const l of ['pt', 'en'] as const) assert.doesNotMatch(e[l][1], /em breve|vai chegar|coming soon|will soon/i, `${e.key}/${l}: nada «em breve»`);
  // Animação por orçamento pago com créditos; retratos animados só do administrador; o entrevistado animado aprova sempre.
  assert.match(by('video-ia').pt[1], /^Sim, por orçamento: os planos não incluem animação/); assert.match(by('video-ia').pt[1], /«Calcular orçamento \(grátis, não cativa nada\)»/);
  assert.match(by('video-ia').pt[1], /Os retratos animados \(Replicate\) estão reservados ao administrador/);
  assert.match(by('video-ia').pt[1], /vê e aprova o vídeo antes de ser publicado/);
  assert.match(by('video-ia').en[1], /^Yes, on a quote/); assert.match(by('video-ia').en[1], /reserved for the administrator/);
  assert.match(A.fillVars(by('video-ia').pt[1]), new RegExp(`validade \\(${QUOTE_VALID_DAYS} dias\\)`));
  assert.match(by('orcamento-aceitar').pt[1], /O orçamento aceite é o máximo: nunca se cobra mais/); assert.match(by('orcamento-aceitar').pt[1], /o resto volta ao saldo automaticamente/);
  // Os números deste ramo vêm da configuração e das constantes em vigor.
  assert.match(A.fillVars(by('limites-entrevista').pt[1]), new RegExp(`até ${config.limits.maxQuestions} perguntas \\(as adicionais incluídas\\) e até ${config.limits.maxAnswerTotalSec / 60} minutos de respostas no total`));
  assert.match(A.fillVars(by('limites-entrevista').en[1]), new RegExp(`up to ${config.limits.maxAnswerTotalSec / 60} minutes of answers in total`));
  assert.match(A.fillVars(by('regeneracoes').pt[1]), new RegExp(`inclui ${config.limits.includedRegenerations} regenerações`));
  assert.match(A.fillVars(by('regeneracoes').pt[1]), new RegExp(`custa ${W.EXTRA_REGEN_CENTS / 100} crédito`));
  assert.match(A.fillVars(by('entrevista-extra').pt[1]), new RegExp(`por ${W.EXTRA_INTERVIEW_CENTS / 100} créditos`));
  assert.match(A.fillVars(by('introducao-animada').pt[1]), new RegExp(`até ${config.limits.introPerMonth} por mês`)); assert.match(by('introducao-animada').pt[1], /Não usa créditos nem entra no orçamento/);
  assert.match(A.fillVars(by('creditos').pt[1]), new RegExp(`de ${W.TOPUP_MIN_CENTS / 100} a ${W.TOPUP_MAX_CENTS / 100} créditos`));
  assert.match(A.fillVars(by('creditos').pt[1]), new RegExp(`vale ${W.CREDIT_VALID_MONTHS} meses`));
  assert.match(A.fillVars(by('devolucoes').pt[1]), new RegExp(`nos ${W.REFUND_WINDOW_DAYS} dias seguintes a esse carregamento`));
  assert.ok(A.fillVars(by('grafismo-video').pt[1]).includes(config.brandSite));
  assert.match(by('planos-conta').pt[1], /Start e Pro/); assert.match(by('planos-conta').pt[1], /«Manage card, Stripe receipts & cancellation»/);
  assert.match(by('entidade').pt[1], /convida sem subscrição e sem limite mensal de entrevistas/);
  assert.ok(A.fillVars(by('faturas-iva').pt[1]).includes(`emitida pela ${config.seller.name}`), 'a vendedora (Telecert) nas faturas');
  assert.match(by('convidado-nome-video').pt[1], /no cartão de título/);
  // Correções de conteúdo verificadas no código
  assert.match(by('galeria').pt[1], /se quiser, indique um tema \(sem tema, fica no grupo «Other»\)/); assert.doesNotMatch(by('galeria').pt[1], /e indicar um tema/);
  assert.match(by('galeria').en[1], /without one, it is listed under «Other»/);
  for (const l of ['pt', 'en'] as const) assert.doesNotMatch(by('estados')[l][1], /expirar|expiry/, `estados/${l}: «expirada» nunca é gravado`);
  assert.match(by('objetivo').pt[1], /Só o texto é mostrado ao entrevistado/); assert.match(by('objetivo').en[1], /Only the text is shown to the guest/);
  assert.match(by('validacao-entrevistado').pt[1], /com «Só o entrevistador aprova», a aprovação é só sua/);
  assert.match(by('validacao-entrevistado').en[1], /the approval is yours alone/);
  assert.match(by('palavra-passe').pt[1], /nunca é escrita nas mensagens do suporte/); assert.match(by('palavra-passe').en[1], /never written in support messages/);
  assert.match(by('convidado-suporte').pt[1], /enquanto for válido/); assert.match(by('convidado-suporte').en[1], /while it is valid/);
  assert.match(A.fillVars(by('convidado-privacidade').pt[1]), new RegExp(`não seguem para serviços de IA\\) e ficam registadas sem identificação durante ${A.ASSISTANT_LOG_DAYS} dias`));
  assert.match(A.fillVars(by('assistente-privacidade').pt[1]), new RegExp(`durante ${A.ASSISTANT_LOG_DAYS} dias`));
});

// ======================= fluxos =======================

test('preparação: semente na base (idempotente, alterações do administrador mantidas), utilizadores e convidados', async () => {
  const n = async () => Number((await db.one('SELECT count(*)::int n FROM assistant_faq')).n);
  assert.equal(await n(), FAQ_SEED.length * 2, 'cada entrada em pt e en');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assistant_faq f WHERE seed_hash IS NULL`)).n), 0, 'cada entrada com a versão da semente');
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
  // Sem subscrição (e em AI_MOCK) a pergunta nunca vai para a IA, e o aviso diz isso e o prazo do registo.
  assert.match(help.body, /não é enviada a serviços de IA\) e fica registada sem identificação durante 180 dias/);
  assert.match(help.body, /<form method="post" action="\/ajuda#suporte">/, 'erros do formulário à vista (sem JavaScript)');
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
  assert.match(page.body, new RegExp(`<form method="post" action="/ajuda/assistente/${id}/ajudou" data-as><div class="as-fb" role="group" aria-labelledby="as-fb-q">`));
  assert.match(page.body, /<span id="as-fb-q">Isto ajudou\?<\/span>/, 'o grupo dos botões tem nome para os leitores de ecrã');
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
  assert.match(pg.body, new RegExp(`<form method="post" action="/ajuda/assistente/${id}/suporte#suporte"><input type="hidden" name="s" value="[^"]+">`));
  assert.match(pg.body, /<textarea id="sp-m" name="message"[^>]*>Como altero a minha palavra-passe\?<\/textarea>/);
  assert.equal(pg.body.split('id="sp-m"').length - 1, 1, 'um só formulário de suporte na página');

  // erros: mensagem vazia (formulário mantém-se), assinatura errada
  const empty = await post(`/ajuda/assistente/${id}/suporte`, { s, subject: '', message: '  ' }, ana);
  assert.equal(empty.statusCode, 422);
  assert.match(empty.body, new RegExp(`action="/ajuda/assistente/${id}/suporte#suporte"`));
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
  assert.match(again.body, /<form method="post" action="\/ajuda#suporte"><label for="sp-s">/);
  assert.equal(await nEmails(), emails, 'nenhum email');
});

test('com JavaScript: resposta, «ajudou» e erros em JSON, sem recarregar', async () => {
  const r = await post('/ajuda/assistente', { q: 'Quanto custa processar uma entrevista?' }, ana, '10.0.0.1', true);
  assert.equal(r.statusCode, 200);
  const j = r.json();
  assert.match(j.url, new RegExp(`^/ajuda\\?r=${UUID}&s=`));
  assert.match(j.html, /<div id="as-resposta" class="as-res" tabindex="-1">/);
  assert.match(j.html, /vídeo premium \(animação por IA\)/);
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

test('administrador: a língua de uma entrada da semente não muda (sem «Erro interno»); «tratada» fica na auditoria', async () => {
  const sid = await seedId('quem-gere');
  const before = await db.one('SELECT * FROM assistant_faq WHERE id=$1', [sid]);
  const ed = await get(`/admin/assistente/${sid}`, admin);
  assert.doesNotMatch(ed.body, /<select id="f-lang"/, 'sem escolha de língua numa entrada da semente');
  assert.match(ed.body, /<input type="hidden" name="lang" value="pt">/);
  assert.match(ed.body, /a língua não muda/);
  const r = await post(`/admin/assistente/${sid}`, { lang: 'en', audience: 'all', question: 'Quem gere e quem comercializa o {brand}?', keywords: 'quem gere', answer: 'Texto novo.', sort: '5', active: '1' }, admin);
  assert.equal(r.statusCode, 422, 'recusado com explicação, não «Erro interno»');
  assert.match(r.body, /A língua de uma entrada da semente não muda/);
  assert.match(r.body, /<input type="hidden" name="lang" value="pt">/);
  assert.match(r.body, /Texto novo\./, 'o que foi escrito não se perde');
  const after = await db.one('SELECT * FROM assistant_faq WHERE id=$1', [sid]);
  assert.equal(after.lang, 'pt'); assert.equal(after.answer, before.answer);
  // Sem mudar de língua, guarda normalmente.
  const ok = await post(`/admin/assistente/${sid}`, { lang: 'pt', audience: 'all', question: before.question, keywords: before.keywords, answer: before.answer, sort: String(before.sort), active: '1' }, admin);
  assert.equal(ok.headers.location, '/admin/assistente?ok=saved#base');
  // Numa entrada criada pelo administrador, a língua escolhe-se e muda-se.
  await post('/admin/assistente', { lang: 'pt', audience: 'all', question: 'Pergunta de teste da língua?', keywords: 'teste', answer: 'Resposta.', sort: '1', active: '1' }, admin);
  const mine = await db.one(`SELECT id FROM assistant_faq WHERE question='Pergunta de teste da língua?'`);
  assert.match((await get(`/admin/assistente/${mine.id}`, admin)).body, /<select id="f-lang" name="lang"/);
  assert.equal((await post(`/admin/assistente/${mine.id}`, { lang: 'en', audience: 'all', question: 'Language test question?', keywords: 'test', answer: 'Answer.', sort: '1', active: '0' }, admin)).statusCode, 302);
  assert.equal((await db.one('SELECT lang FROM assistant_faq WHERE id=$1', [mine.id])).lang, 'en');

  // «Marcar como tratada» fica na auditoria; um registo inexistente dá 404.
  const q = await A.answerQuestion(db, { question: 'zzqx pergunta sem resposta', pageLang: 'pt', audience: 'interviewer' });
  assert.equal((await post(`/admin/assistente/perguntas/${q}/tratada`, {}, admin)).headers.location, '/admin/assistente?ok=reviewed#h-melhorar');
  assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action='assistant.question_reviewed' AND actor='admin@example.com' AND meta->>'questionId'=$1`, [q]));
  assert.equal((await post('/admin/assistente/perguntas/00000000-0000-0000-0000-000000000000/tratada', {}, admin)).statusCode, 404);
});

// ======================= versões da semente =======================

/** 'video-ia' (pt) como a main o semeou (1eb5f9a), antes das versões: prometia a animação «em breve». */
const LEGACY_VIDEO_IA_PT: [string, string, string] = ["Posso ter um vídeo com animação por IA (Google Veo ou retratos animados)?","Na secção «Vídeo do podcast», os retratos com sincronização labial e o Google Veo só ficam disponíveis quando o administrador do portal os abre a todos os entrevistadores; por omissão, só o administrador os pede, porque cada geração é paga ao fornecedor. Quando não estão disponíveis, a secção avisa e o vídeo sai com as fotografias e a voz do episódio. A animação por IA vai chegar em breve por orçamento, aceite antes de gerar e pago com créditos. Quem aparece animado tem de dar uma autorização própria e o vídeo leva sempre um aviso visível; se for o entrevistado, ele vê e aprova o vídeo antes de ser publicado.","animação, IA, vídeo IA, Veo, Google Veo, retrato animado, avatar, lipsync, créditos, orçamento, animar fotografia"];
/** 'objetivo' (pt) da primeira semente publicada (bb77841). */
const LEGACY_OBJETIVO_PT: [string, string, string] = ["Para que serve o objetivo da entrevista e quem o vê?","O objetivo explica o tema e o propósito da entrevista. Pode escrevê-lo ou gravá-lo em áudio (o áudio é transcrito para poder copiar o texto, quando o serviço de IA está configurado). Só é mostrado ao entrevistado se marcar «Mostrar o objetivo ao entrevistado»; caso contrário fica interno. É preciso ter objetivo, em texto ou em áudio, para enviar o convite.","objetivo, propósito, tema, mostrar objetivo, interno, finalidade, assunto"];

test('versões da semente: o texto novo chega às entradas que o administrador não alterou; as alteradas ficam e ele decide', async () => {
  const row = (key: string, lang = 'pt') => db.one('SELECT * FROM assistant_faq WHERE seed_key=$1 AND lang=$2', [key, lang]);
  const cur = (key: string, lang: 'pt' | 'en' = 'pt') => seedRows().find(r => r.key === key && r.lang === lang)!;
  // Entradas semeadas pela main antes das versões (seed_hash NULL), com o texto de uma versão publicada: atualizadas.
  const vid = await seedId('video-ia'), before = await row('video-ia');
  await db.query(`UPDATE assistant_faq SET question=$2, answer=$3, keywords=$4, seed_hash=NULL, sort=777, active=false WHERE id=$1`, [vid, ...LEGACY_VIDEO_IA_PT]);
  await db.query(`UPDATE assistant_faq SET question=$2, answer=$3, keywords=$4, seed_hash=NULL WHERE id=$1`, [await seedId('objetivo'), ...LEGACY_OBJETIVO_PT]);
  // Entrada antiga alterada pelo administrador (texto que nenhuma versão teve): fica.
  const cid = await seedId('custos', 'en');
  await db.query(`UPDATE assistant_faq SET answer='Texto do administrador sobre custos.', seed_hash=NULL WHERE id=$1`, [cid]);
  // Entrada antiga igual à semente atual: só ganha a versão.
  await db.query(`UPDATE assistant_faq SET seed_hash=NULL WHERE id=$1`, [await seedId('cancelar')]);
  const r = await seedAssistant(db);
  assert.equal(r.inserted, 0); assert.equal(r.updated, 2, JSON.stringify(r));
  const v = await row('video-ia');
  assert.equal(v.answer, cur('video-ia').answer); assert.equal(v.question, cur('video-ia').question); assert.equal(v.seed_hash, cur('video-ia').hash);
  assert.doesNotMatch(v.answer, /em breve/);
  assert.equal(v.sort, 777); assert.equal(v.active, false, 'a ordem e o estado escolhidos pelo administrador ficam');
  await db.query('UPDATE assistant_faq SET sort=$2, active=true WHERE id=$1', [vid, before.sort]);
  assert.equal((await row('objetivo')).answer, cur('objetivo').answer, 'também a partir da primeira versão publicada');
  const c = await row('custos', 'en');
  assert.equal(c.answer, 'Texto do administrador sobre custos.');
  assert.equal(c.seed_hash, LEGACY_SEED_HASHES['custos/en'].at(-1), 'base da alteração: a última versão publicada');
  assert.equal((await row('cancelar')).seed_hash, cur('cancelar').hash);
  assert.equal((await seedAssistant(db)).updated, 0, 'semear de novo não muda nada');

  // O administrador vê a versão nova por decidir e mantém o texto dele ou repõe o da semente.
  const list = await get('/admin/assistente?lingua=en&publico=interviewer', admin);
  assert.match(list.body, new RegExp(`/admin/assistente/${cid}">[^<]*</a> <span class="pill warn">versão nova da semente por decidir</span>`));
  assert.match(list.body, /<strong>1 por decidir neste filtro\.<\/strong>/);
  const ed = await get(`/admin/assistente/${cid}`, admin);
  assert.match(ed.body, /alterada por si: o seu texto mantém-se/);
  assert.match(ed.body, /<h2[^>]*>Versão nova da semente por decidir<\/h2>/);
  assert.ok(ed.body.includes('For each interview, the plan includes the transcription'), 'mostra o texto novo da semente');
  assert.match(ed.body, /name="acao" value="manter">Manter o meu texto/);
  assert.equal((await post(`/admin/assistente/${cid}/semente`, { acao: 'repor' }, ana)).statusCode, 403);
  const keep = await post(`/admin/assistente/${cid}/semente`, { acao: 'manter' }, admin);
  assert.equal(keep.headers.location, `/admin/assistente/${cid}?ok=kept`);
  assert.equal((await row('custos', 'en')).answer, 'Texto do administrador sobre custos.');
  const ed2 = await get(keep.headers.location as string, admin);
  assert.match(ed2.body, /O seu texto fica/); assert.match(ed2.body, /Texto atual da semente/); assert.doesNotMatch(ed2.body, /value="manter"/);
  assert.match((await get('/admin/assistente?lingua=en&publico=interviewer', admin)).body, new RegExp(`/admin/assistente/${cid}">[^<]*</a> <span class="pill ">alterada pelo administrador</span>`));
  await seedAssistant(db);
  assert.equal((await row('custos', 'en')).answer, 'Texto do administrador sobre custos.', 'mantido: a semente não o substitui');
  const restore = await post(`/admin/assistente/${cid}/semente`, { acao: 'repor' }, admin);
  assert.equal(restore.headers.location, `/admin/assistente/${cid}?ok=restored`);
  assert.equal((await row('custos', 'en')).answer, cur('custos', 'en').answer);
  assert.doesNotMatch((await get(`/admin/assistente/${cid}`, admin)).body, /id="semente"/, 'igual à semente: nada por decidir');
  for (const a of ['assistant.faq_seed_kept', 'assistant.faq_seed_restored'])
    assert.ok(await db.one(`SELECT 1 FROM audit_events WHERE action=$1 AND actor='admin@example.com' AND meta->>'faqId'=$2`, [a, cid]), a);

  // Uma atualização futura da semente chega só às entradas que o administrador não alterou.
  const rid = await seedId('convidado-recusar'), rec = await row('convidado-recusar');
  await post(`/admin/assistente/${rid}`, { lang: 'pt', audience: 'guest', question: rec.question, keywords: rec.keywords, answer: 'Resposta do administrador.', sort: String(rec.sort), active: '1' }, admin);
  const lingua = FAQ_SEED.find(e => e.key === 'convidado-lingua')!, recusar = FAQ_SEED.find(e => e.key === 'convidado-recusar')!;
  const orig = [lingua.pt, recusar.pt] as const;
  try {
    lingua.pt = [lingua.pt[0], `${lingua.pt[1]} Texto da versão seguinte.`, lingua.pt[2]];
    recusar.pt = [recusar.pt[0], `${recusar.pt[1]} Texto da versão seguinte.`, recusar.pt[2]];
    const r2 = await seedAssistant(db);
    assert.equal(r2.updated, 1, JSON.stringify(r2));
    assert.match((await row('convidado-lingua')).answer, /Texto da versão seguinte\.$/);
    assert.equal((await row('convidado-recusar')).answer, 'Resposta do administrador.');
    assert.match((await get(`/admin/assistente/${rid}`, admin)).body, /Versão nova da semente por decidir<\/h2>[\s\S]*Texto da versão seguinte\./);
    const hits = A.searchFaq(await A.activeFaq(db, 'pt', 'guest'), 'Em que língua respondo?');
    assert.match(hits[0].entry.answer, /Texto da versão seguinte\.$/, 'o assistente responde com o texto novo');
  } finally { [lingua.pt, recusar.pt] = orig; }
  await seedAssistant(db);
  assert.equal((await row('convidado-lingua')).answer, lingua.pt[1], 'ainda por alterar: acompanha também o regresso');
  await db.query('UPDATE assistant_faq SET answer=$2 WHERE id=$1', [rid, recusar.pt[1]]);
});

test('atualização da produção: as migrações deste ramo correm depois das 030 e 031 da main e a semente atualiza o que não foi alterado', async () => {
  const { readFileSync } = await import('node:fs');
  const d2 = await openDb();
  try {
    await migrate(d2, { until: '012_veo_modelo_preco.sql' });
    // Como na produção: o suporte e o assistente da main (030 e 031) aplicados antes das migrações 013 a 020 deste ramo.
    for (const f of ['030_suporte.sql', '031_assistente.sql']) {
      const sql = readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8');
      await d2.tx(async (t: any) => { for (const st of sql.split(/;\s*\n/).map(x => x.trim()).filter(Boolean)) await t.query(st); await t.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]); });
    }
    // A semente da main, sem versões: uma entrada com o texto publicado e outra alterada pelo administrador.
    await d2.query(`INSERT INTO assistant_faq(seed_key, lang, audience, question, answer, keywords, sort) VALUES ('video-ia', 'pt', 'interviewer', $1, $2, $3, 270),
      ('custos', 'pt', 'interviewer', 'Quanto custa?', 'Resposta do administrador.', 'custo', 280)`, LEGACY_VIDEO_IA_PT);
    await migrate(d2);
    const names = (await d2.query('SELECT name FROM schema_migrations')).map((x: any) => x.name);
    for (const f of ['013_limites.sql', '016_orcamentos.sql', '020_introducao.sql', '032_assistente_versoes.sql']) assert.ok(names.includes(f), f);
    const r = await seedAssistant(d2);
    assert.deepEqual(r, { inserted: FAQ_SEED.length * 2 - 2, updated: 1, kept: 1 });
    assert.equal((await d2.one(`SELECT answer FROM assistant_faq WHERE seed_key='video-ia' AND lang='pt'`)).answer, seedRows().find(x => x.key === 'video-ia' && x.lang === 'pt')!.answer);
    assert.equal((await d2.one(`SELECT answer FROM assistant_faq WHERE seed_key='custos' AND lang='pt'`)).answer, 'Resposta do administrador.');
  } finally { await d2.close(); }
});

test('limites: um pedido já enviado a partir do assistente não gasta o limite de mensagens', async () => {
  const hugo = await newUser('Hugo', 'hugo@example.com');
  const r = await post('/ajuda/assistente', { q: 'Como envio o convite?' }, hugo, '10.80.0.1');
  const id = logOf(r.headers.location as string), s = decodeURIComponent(/[?&]s=([^&#]+)/.exec(r.headers.location as string)![1]);
  assert.equal((await post(`/ajuda/assistente/${id}/suporte`, { s, message: 'Não percebi.' }, hugo, '10.80.0.1')).statusCode, 302);
  for (let i = 0; i < 5; i++) assert.equal((await post(`/ajuda/assistente/${id}/suporte`, { s, message: 'Não percebi.' }, hugo, '10.80.0.1')).headers.location, '/ajuda#pedidos');
  for (let i = 1; i < SUPPORT_RATE.perSender; i++) assert.equal((await post('/ajuda', { message: `mensagem ${i}` }, hugo, '10.80.0.1')).statusCode, 302, `mensagem ${i}`);
  assert.equal((await post('/ajuda', { message: 'a mais' }, hugo, '10.80.0.1')).statusCode, 429);
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
  // Sem `ai` (contas sem subscrição) ou para convidados, o modelo nunca é chamado, mesmo com chave.
  for (const o of [{ audience: 'interviewer' as const }, { audience: 'interviewer' as const, ai: false }, { audience: 'guest' as const, ai: true }]) {
    const q = await A.answerQuestion(db, { question: 'Como envio o convite?', pageLang: 'pt', ...o }, { aiEnabled: () => true, ai });
    assert.equal((await db.one('SELECT mode FROM assistant_questions WHERE id=$1', [q])).mode, 'local');
  }
  assert.equal(calls.length, 0, 'nem convidados nem contas sem subscrição');
  const id = await A.answerQuestion(db, { question: 'Como envio o convite? Sou a ana@example.com, 912 345 678', pageLang: 'pt', audience: 'interviewer', ai: true }, { aiEnabled: () => true, ai });
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
  const unk = await A.answerQuestion(db, { question: 'Como envio o convite por SMS?', pageLang: 'pt', audience: 'interviewer', ai: true }, { aiEnabled: () => true, ai: async () => ({ answer: 'Não sei. Fale com o suporte.', answered: false }) });
  assert.equal((await db.one('SELECT answered FROM assistant_questions WHERE id=$1', [unk])).answered, false);
  // falha do modelo: ficam as entradas encontradas
  const fail = await A.answerQuestion(db, { question: 'Como envio o convite?', pageLang: 'pt', audience: 'interviewer', ai: true }, { aiEnabled: () => true, ai: async () => { throw new Error('timeout'); } });
  const fl = await db.one('SELECT * FROM assistant_questions WHERE id=$1', [fail]);
  assert.equal(fl.mode, 'local'); assert.equal(fl.answer, null); assert.equal(fl.answered, true);
  // sem entradas: o modelo nem é chamado
  calls.length = 0;
  const none = await A.answerQuestion(db, { question: 'receita de arroz de pato', pageLang: 'pt', audience: 'interviewer', ai: true }, { aiEnabled: () => true, ai });
  assert.equal(calls.length, 0);
  assert.equal((await db.one('SELECT answered, mode FROM assistant_questions WHERE id=$1', [none])).mode, 'local');

  // Teto global por hora (ASSISTANT_AI_PER_HOUR=5 neste teste; já foram 3 chamadas): acima dele, só a pesquisa local.
  assert.equal(config.openai.assistantAiPerHour, 5);
  const modes: string[] = [];
  for (let i = 0; i < 4; i++) modes.push((await db.one('SELECT mode FROM assistant_questions WHERE id=$1', [await A.answerQuestion(db, { question: 'Como envio o convite?', pageLang: 'pt', audience: 'interviewer', ai: true }, { aiEnabled: () => true, ai })])).mode);
  assert.deepEqual(modes, ['ai', 'ai', 'local', 'local']);
  assert.equal(calls.length, 2, 'o teto não depende do IP nem da conta');

  // Teto de tokens no pedido; uma resposta cortada conta como falha (ficam as entradas encontradas).
  const req = helpRequest('sys', 'user');
  assert.equal(req.max_completion_tokens, HELP_MAX_TOKENS); assert.ok(HELP_MAX_TOKENS <= 500);
  assert.deepEqual(parseHelp({ choices: [{ finish_reason: 'stop', message: { content: '{"answer":" Olá ","answered":true}' } }] }), { answer: 'Olá', answered: true });
  assert.throws(() => parseHelp({ choices: [{ finish_reason: 'length', message: { content: '{"answer":"Lorem ipsum' } }] }), /cortada/);

  // Os marcadores {…} das perguntas também são preenchidos para o modelo e no pedido ao suporte.
  const qg = (await db.one(`SELECT id, lang, audience, question, answer, keywords, sort FROM assistant_faq WHERE seed_key='quem-gere' AND lang='pt'`));
  assert.match(A.assistantPrompt('Quem vende?', [qg], 'pt').user, new RegExp(`"question":"Quem gere e quem comercializa o ${config.brand}\\?"`));
  assert.doesNotMatch(A.assistantPrompt('Quem vende?', [qg], 'pt').user, /\{brand\}/);
  const tr = A.assistantTranscript({ log: { answer: null }, entries: [qg] }, 'pt');
  assert.match(tr, new RegExp(`— Quem gere e quem comercializa o ${config.brand}\\?`)); assert.doesNotMatch(tr, /\{\w+\}/);
});

test('IA só para contas com subscrição ativa (e o administrador); convidados e contas sem subscrição na pesquisa local', async () => {
  const u = async (email: string) => db.one('SELECT id, role FROM users WHERE email=$1', [email]);
  assert.equal(await A.assistantAiFor(db, await u('admin@example.com')), true);
  assert.equal(await A.assistantAiFor(db, await u('ana@example.com')), false, 'sem subscrição');
  const b = await u('bruno@example.com');
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source, interviews_override) VALUES ($1,'starter','active','manual',0)`, [b.id]);
  assert.equal(await A.assistantAiFor(db, b), true, 'com subscrição ativa, mesmo com a quota do mês gasta');
  await db.query(`UPDATE subscriptions SET status='canceled' WHERE user_id=$1`, [b.id]);
  assert.equal(await A.assistantAiFor(db, b), false, 'subscrição cancelada');
  await db.query(`DELETE FROM subscriptions WHERE user_id=$1`, [b.id]);
  // O convidado vê o aviso de que a pergunta não vai para a IA, na língua dele.
  assert.match((await get('/entrevista/ajuda', guest)).body, /it is not sent to AI services\) and is stored without identification for 180 days/);
  assert.match((await get('/entrevista/ajuda', guestPt)).body, /não é enviada a serviços de IA/);
  // A página de privacidade explica o assistente e o suporte.
  const priv = await get('/privacy');
  assert.match(priv.body, /Help assistant and support/); assert.match(priv.body, /never sent to AI services/); assert.match(priv.body, /stored for 180 days/);
});

test('convidado com página em inglês que pergunta em espanhol ou francês: resposta em inglês (não em português)', async () => {
  for (const q of ['¿Mi foto será pública?', '¿Puedo hacer un vídeo con mis fotos?', 'Où est le lien vidéo ?']) {
    const r = await post('/entrevista/ajuda/assistente', { q }, guest, '10.71.0.1');
    const id = logOf(r.headers.location as string);
    assert.equal((await db.one('SELECT lang FROM assistant_questions WHERE id=$1', [id])).lang, 'en', q);
    const pg = await get(r.headers.location as string, guest);
    assert.doesNotMatch(pg.body, /<h3 class="as-h">(Quem|Como|O que|Posso|Tenho)/, `${q}: nada em português`);
  }
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

test('marcadores com os valores de quem pergunta: limites do plano dele, os do convite do convidado e a vendedora da conta Stripe dele', async () => {
  const { saveEntitySetting } = await import('../src/settings.ts');
  const limits = (await import('../src/assistant-faq.ts')).FAQ_SEED.find(e => e.key === 'limites-entrevista')!;
  // o administrador mudou os limites do plano Start: a cliente com esse plano vê os do plano dela, não os gerais
  const u = await newUser('Plano Start', 'plano-start@example.com');
  const uid = (await db.one(`SELECT id FROM users WHERE email='plano-start@example.com'`)).id;
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [uid]);
  await db.query(`UPDATE plans SET max_questions=10, max_answer_total_sec=600 WHERE id='start'`);
  try {
    const loc = (await post('/ajuda/assistente', { q: 'Que limites tem cada entrevista?' }, u, '10.91.0.1')).headers.location as string;
    const pg = (await get(loc, u)).body;
    assert.match(pg, /até 10 perguntas \(as adicionais incluídas\) e até 10 minutos de respostas no total/);
    assert.doesNotMatch(pg, /até 15 perguntas \(as adicionais incluídas\)/);
    const vars = await A.userAskerVars(db, { id: uid, role: 'interviewer', entity_id: null });
    assert.deepEqual([vars.maxQuestions, vars.maxAnswerTotalMin], ['10', '10']);
    assert.match(A.withAskerVars(vars, () => A.fillVars(limits.en[1])), /up to 10 questions \(additional ones included\) and up to 10 minutes of answers in total/);
    // fora do contexto de quem pergunta (pré-visualização do administrador), os valores gerais
    assert.match(A.fillVars(limits.pt[1]), new RegExp(`até ${config.limits.maxQuestions} perguntas`));
  } finally { await db.query(`UPDATE plans SET max_questions=15, max_answer_total_sec=900 WHERE id='start'`); }
  // convidado: os limites fixados no convite da entrevista dele
  await db.query(`UPDATE interviews SET question_limit=7, answer_limit_sec=480 WHERE id=$1`, [ivEn]);
  try {
    assert.deepEqual(Object.entries(await A.guestAskerVars(db, ivEn)).filter(([k]) => k !== 'sellerName'), [['maxQuestions', '7'], ['maxAnswerTotalMin', '8']]);
  } finally { await db.query(`UPDATE interviews SET question_limit=NULL, answer_limit_sec=NULL WHERE id=$1`, [ivEn]); }
  // entidade com Stripe própria: as faturas são da vendedora dela, como na Conta e nos termos
  const ent = (await db.one(`INSERT INTO entities(slug, name) VALUES ('entidade-x','Entidade X') RETURNING id`)).id;
  const ux = await newUser('Xavier', 'xavier@example.com', { entity_id: ent });
  await saveEntitySetting(db, ent, 'STRIPE_SECRET_KEY', ('sk_' + 'test_' + 'X'.repeat(23)));
  await saveEntitySetting(db, ent, 'SELLER_NAME', 'Entidade X Formação, Lda.');
  try {
    const loc = (await post('/ajuda/assistente', { q: 'Quem emite a fatura-recibo?' }, ux, '10.91.0.2')).headers.location as string;
    const pg = (await get(loc, ux)).body;
    assert.match(pg, /emitida pela Entidade X Formação, Lda\./);
    assert.doesNotMatch(pg, /Telecert/);
    assert.ok(A.fillVars('{sellerName}') !== 'Entidade X Formação, Lda.', 'sem contexto, a vendedora global');
  } finally {
    await saveEntitySetting(db, ent, 'STRIPE_SECRET_KEY', '');
    await saveEntitySetting(db, ent, 'SELLER_NAME', '');
  }
});
