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
const { saveSetting } = await import('../src/settings.ts');
const J = await import('../src/jobs.ts');
const { runOne } = J;
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const { storage } = await import('../src/storage.ts');
const W = await import('../src/wallet.ts');
const Q = await import('../src/quotes.ts');
const V = await import('../src/veo-episode.ts');
const { eurPt, withVat } = await import('../src/vat.ts');
const sharp = (await import('sharp')).default;

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db);});
after(async () => { await app.close(); await db.close(); });
// Sem rede: nada vai à Google, à OpenAI nem à Stripe (o modo simulado gera os clipes localmente).
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any) => Promise.reject(new Error(`rede proibida nos testes: ${String(u)}`))) as any;
after(() => { globalThis.fetch = realFetch; });

const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie = '') => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const raw = (url: string, payload: Buffer, type: string, cookie: string) => app.inject({ method: 'POST', url, payload, headers: { 'content-type': type, cookie } });
const msg = (r: any) => decodeURIComponent(String(r.headers.location ?? ''));
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const PW = 'uma-palavra-passe-longa';
/** NIF fictício com o dígito de controlo certo (só para testes). */
const nifOf = (p8: string) => { const sum = [...p8].reduce((s, d, i) => s + Number(d) * (9 - i), 0); return p8 + (sum % 11 < 2 ? 0 : 11 - (sum % 11)); };
const check = async () => assert.deepEqual(await W.ledgerCheck(db), [], 'livro-razão: soma das entradas = saldos; disponível = lotes');
const walletOf = (userId: string) => db.one('SELECT * FROM wallets WHERE user_id=$1 AND entity_id IS NULL', [userId]);
/** Créditos num lote pago (o carregamento pela Stripe está testado em credits.test.ts). */
const credit = async (userId: string, cents: number) => {
  const w = await W.walletFor(db, userId, null);
  const tp = await db.one(`INSERT INTO credit_topups(wallet_id, user_id, net_cents, vat_cents, gross_cents, vat_rate, vat_regime, customer_kind, customer_country) VALUES ($1,$2,$3,$4,$5,23,'domestic','business','PT') RETURNING id`,
    [w.id, userId, cents, Math.round(cents * 0.23), cents + Math.round(cents * 0.23)]);
  assert.equal(await db.tx((t: any) => W.creditTopup(t, tp.id, { paymentIntent: `pi_q_${tp.id}` })), true);
};

let admin = '', guest = '', ivId = '', epId = '';
const cli = { cookie: '', id: '' };
const ALL = ['s0', 'q0', 'a0', 'q1', 'a1', 'sx'], HOST = ['s0', 'q0', 'q1', 'sx'];
const LONG_Q0 = 'Looking back at the first five years of the project, what were the three decisions that mattered most for the team, for the customers who trusted you early on, and for the way you plan the next stage today?';
const LONG_Q1 = 'When the grid operators asked for more flexibility last winter, how did you organise the people, the batteries and the software so that every site could answer within minutes, and what would you change now?';
const quoteOf = (id: string) => db.one('SELECT * FROM animation_quotes WHERE id=$1', [id]);
const lastJob = () => db.one(`SELECT * FROM jobs WHERE kind='render_video' ORDER BY created_at DESC LIMIT 1`);
const newQuote = async (falas: string[], cookie = cli.cookie) => {
  const r = await post(`/entrevistas/${ivId}/episodio/${epId}/orcamento`, { fala: falas, lang: 'en' }, cookie);
  const m = /orcamentos\/([0-9a-f-]{36})/.exec(String(r.headers.location));
  assert.ok(m, msg(r));
  return quoteOf(m![1]);
};
const accept = async (q: any) => {
  const r = await post(`/entrevistas/${ivId}/orcamentos/${q.id}/aceitar`, { start_now: '1', waiver: '1' }, cli.cookie);
  assert.match(msg(r), /Orçamento aceite/);
  return quoteOf(q.id);
};
/** Clipes rejeitados (defeito objetivo ou gosto do cliente): saem do reaproveitamento e o take seguinte gera clipes novos. */
const _unused = () => db.query(`UPDATE assets SET meta = meta || '{"rejected": true}'::jsonb WHERE interview_id=$1 AND kind='veo_clip' AND deleted_at IS NULL`, [ivId]);
const centsOf = (ep: any, ids: string[], perMin = 3000) => ids.reduce((n, id) => n + Q.segmentCents(Q.speechSec(ep.technical.timing.find((t: any) => t.id === id).durationMs), perMin), 0);

test('preparação: episódio em pré-visualização de um cliente (não administrador) com o Veo autorizado pelos dois', async () => {
  admin = `sid=${cookies(await post('/registar', { name: 'Admin', email: 'admin@example.com', password: PW, terms: 1 })).sid}`;
  await saveSetting(db, 'SIGNUPS_OPEN', '1');
  for (const [k, v] of [['SELLER_NAME', 'Empresa Vendedora de Teste, Lda.'], ['SELLER_NIF', nifOf('50000000')], ['SELLER_ADDRESS', 'Rua de Teste, 1, 1000-001 Lisboa'], ['SELLER_EMAIL', 'vendas@exemplo.pt'], ['SELLER_COMPLAINTS_URL', 'https://www.livroreclamacoes.pt/Inicio/']]) await saveSetting(db, k, v);
  const r = await post('/registar', { name: 'Cliente', email: 'cliente@example.com', password: PW, terms: 1 });
  cli.cookie = `sid=${cookies(r).sid}`;
  cli.id = (await db.one('SELECT id FROM users WHERE email=$1', ['cliente@example.com'])).id;
  await db.query(`INSERT INTO billing_profiles(user_id, kind, name, country, address, postal_code, city, nif) VALUES ($1,'business','Cliente, Lda.','PT','Rua C','1000-001','Lisboa',$2)`, [cli.id, nifOf('51234567')]);
  await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, source) VALUES ($1,'start','active','manual')`, [cli.id]);
  const c = await post('/entrevistas', { title: 'Armazenamento de energia' }, cli.cookie);
  ivId = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${ivId}/perguntas`, { text: 'Pergunta um?' }, cli.cookie);
  await post(`/entrevistas/${ivId}/perguntas`, { text: 'Pergunta dois?' }, cli.cookie);
  await post(`/entrevistas/${ivId}/guardar`, { title: 'Armazenamento de energia', objective_text: 'O', host_name: 'Zé', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en', host_photo_rights: '1', host_ai_video: '1' }, cli.cookie);
  const jpg = (bg: string) => sharp({ create: { width: 400, height: 400, channels: 3, background: bg } }).jpeg().toBuffer();
  assert.equal((await raw(`/api/entrevistas/${ivId}/foto`, await jpg('#865'), 'image/jpeg', cli.cookie)).statusCode, 200);
  assert.match(msg(await post(`/entrevistas/${ivId}/convidar`, {}, cli.cookie)), /entrevistas\//);
  await flushOutbox(db);
  const mail = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  guest = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(mail.text_body)![1]}/abrir`, {})).gs}`;
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', host_edit: '1', processing: '1', publish: '1' }, guest);
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1' }, guest);
  assert.equal((await raw('/api/g/fotos', await jpg('#4a6'), 'image/jpeg', guest)).statusCode, 200);
  // respostas com durações diferentes (a transcrição simulada depende do tamanho: falas diferentes)
  for (const [i, q] of (await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [ivId])).entries()) assert.equal((await raw(`/api/g/respostas/${q.id}`, makeToneWav(2 + i), 'audio/wav', guest)).statusCode, 200);
  await post('/entrevista/submeter', {}, guest);
  await post(`/entrevistas/${ivId}/processar`, {}, cli.cookie);
  await drain();
  // guião revisto: falas do entrevistador longas (vários pedaços) e o nome do convidado na apresentação
  const sc = await db.one(`SELECT segments FROM scripts WHERE interview_id=$1 AND status='draft'`, [ivId]);
  assert.deepEqual(sc.segments.map((s: any) => s.id), ALL);
  const text: Record<string, string> = { s0: 'Welcome to the show. Today Rui joins us to talk about energy storage, flexible grids and what comes next for them.', q0: LONG_Q0, q1: LONG_Q1 };
  await post(`/entrevistas/${ivId}/guiao`, Object.fromEntries(sc.segments.map((s: any, i: number) => [`seg_${i}`, text[s.id] ?? s.textEnglish])), cli.cookie);
  await post(`/entrevistas/${ivId}/guiao/aprovar`, { reviewed: '1' }, cli.cookie);
  await post(`/entrevistas/${ivId}/gerar`, { subtitle_langs: ['en'] }, cli.cookie);
  await drain();
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND status='preview'`, [ivId]);
  assert.ok(ep, JSON.stringify(await db.query('SELECT kind, state, error FROM jobs WHERE interview_id=$1', [ivId])));
  epId = ep.id;
});


const PER_MIN = 450; // custo por minuto × 2 (migração 038)

test('premium: o cliente só vê «normal» e «premium», sem nomes de tecnologia; créditos por minuto e saldo', async () => {
  const pg = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
  assert.doesNotMatch(pg, /value="veo"|value="heygen"|value="lipsync"/);
  assert.doesNotMatch(pg, /Veo|HeyGen|Google|Avatar IV/);
  assert.match(pg, /Vídeo normal \(fotografias\)/);
  assert.match(pg, /Vídeo premium \(animação por IA\), por orçamento/);
  assert.match(pg, /≈ 4,50 créditos por minuto de fala/);
  assert.match(pg, /<td>10 min<\/td><td>45 créditos<\/td>/);
  assert.equal((await db.one(`SELECT active FROM animation_rates WHERE id='veo-fast'`)).active, false, 'o Veo deixa de se vender');
  assert.equal((await Q.premiumRate(db)).engine, 'heygen');
});

test('premium: orçamento, aceitação, produção e liquidação só das falas animadas (sem nada enviado ao fornecedor no modo simulado)', async () => {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  const q = await newQuote(ALL);
  assert.deepEqual([q.status, q.engine, q.rate.cents_per_min, q.tier], ['draft', 'heygen', PER_MIN, null]);
  assert.equal(q.price_cents, centsOf(ep, ALL, PER_MIN));
  const page = `/entrevistas/${ivId}/orcamentos/${q.id}`;
  const pc = (await get(page, cli.cookie)).body;
  assert.doesNotMatch(pc, /Veo|HeyGen|Google/);
  assert.ok(pc.includes('cada fala animada por IA a partir da fotografia, com a voz do episódio'));
  await credit(cli.id, 10000);
  const qa = await accept(q);
  const job = await db.one(`SELECT * FROM jobs WHERE id=$1`, [qa.job_id]);
  assert.deepEqual([job.input.animEngine, job.input.quoteId, job.input.animate, job.input.engine], ['heygen', q.id, true, undefined]);
  const w0 = await walletOf(cli.id);
  assert.deepEqual([w0.available_cents, w0.reserved_cents], [10000 - q.price_cents, q.price_cents]);
  await drain();
  const j = await db.one('SELECT * FROM jobs WHERE id=$1', [qa.job_id]);
  assert.equal(j.state, 'done', j.error ?? '');
  const qs = await quoteOf(q.id);
  assert.equal(qs.status, 'settled');
  assert.equal(qs.charged_cents + qs.released_cents, q.price_cents);
  const charged = (qs.settlement.segments as any[]).filter(x => x.status === 'charged');
  assert.ok(charged.length > 0);
  assert.equal(qs.charged_cents, charged.reduce((n, x) => n + x.cents, 0));
  const w = await walletOf(cli.id);
  assert.deepEqual([w.available_cents, w.reserved_cents], [10000 - qs.charged_cents, 0]);
  const meta = (await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [epId])).meta;
  assert.deepEqual([meta.engine, meta.quoteId, meta.paidBy], ['heygen', q.id, 'credits']);
  assert.ok(await db.one(`SELECT 1 FROM emails WHERE dedupe_key=$1`, [`quote-settled:${q.id}`]));
  await check();
  // um orçamento novo para o mesmo vídeo: as falas já animadas passam a 0 créditos
  const q2 = await newQuote(ALL);
  assert.ok((q2.selection as any[]).filter(x => charged.some(c => c.segmentId === x.segmentId)).every(x => x.reused && x.cents === 0));
});

test('premium: sem orçamento o cliente não gera o vídeo animado; o administrador gera-o sem créditos', async () => {
  assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'heygen', lang: 'en' }, cli.cookie)), /reservados ao administrador/);
  const pg = (await get(`/entrevistas/${ivId}/producao`, admin)).body;
  assert.match(pg, /value="heygen"> Vídeo premium/);
  assert.doesNotMatch(pg, /value="veo"/);
});

test('publicação: o último episódio público com vídeo na galeria aparece no separador «Interviews» da página inicial', async () => {
  assert.doesNotMatch((await get('/')).body, /id="interviews"/, 'sem episódio publicado, sem separador');
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  await post(`/entrevistas/${ivId}/episodio/${epId}/aprovar`, { video: ep.video_asset_id }, cli.cookie);
  await post(`/entrevistas/${ivId}/episodio/${epId}/enviar-previa`, {}, cli.cookie);
  await flushOutbox(db);
  const pm = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND subject LIKE 'Please review%' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  const tk = /\/i\/([A-Za-z0-9_-]{40,})/.exec(pm.text_body)![1];
  const g2 = `gs=${cookies(await post(`/i/${tk}/abrir`, {})).gs}`;
  await post('/entrevista/episodio/decisao', { decision: 'approved', video: ep.video_asset_id, episode: ep.id, audio: ep.audio_asset_id }, g2);
  const pub = await post(`/entrevistas/${ivId}/episodio/${epId}/publicar`, { visibility: 'public', gallery: '1', theme: 'Energia' }, cli.cookie);
  assert.match(msg(pub), /Publicado/, msg(pub));
  const slug = (await db.one('SELECT slug FROM episodes WHERE id=$1', [epId])).slug;
  const home = (await get('/')).body;
  assert.match(home, /<a href="#interviews">Interviews<\/a>/);
  assert.ok(home.includes(`src="/e/${slug}/video"`));
  assert.equal((await get(`/e/${slug}/video`)).statusCode, 200);
  assert.doesNotMatch(home, /Veo|HeyGen|Google/);
});

test('convites para assistir: email pelo portal, link para o WhatsApp, visualizações e revogação', async () => {
  const pg = (await get('/assistir/convites', cli.cookie)).body;
  assert.match(pg, /Convidar para assistir/);
  assert.match(pg, new RegExp(`<option value="${epId}" selected>Armazenamento de energia · vídeo · público`));
  assert.match((await get('/painel', cli.cookie)).body, /href="\/assistir\/convites"/);
  // email inválido recusado; email válido sai pelo portal com o link pessoal
  assert.match(msg(await post('/assistir/convites', { episode: epId, channel: 'email', email: 'nao-e-email' }, cli.cookie)), /email válido/);
  assert.match(msg(await post('/assistir/convites', { episode: epId, channel: 'email', email: 'Amiga@Example.com', name: 'Ana', note: 'Veja esta conversa.' }, cli.cookie)), /Convite enviado para amiga@example\.com/);
  await flushOutbox(db);
  const em = await db.one(`SELECT * FROM emails WHERE dedupe_key LIKE 'watch:%' ORDER BY created_at DESC LIMIT 1`);
  assert.equal(em.to_email, 'amiga@example.com');
  assert.match(em.text_body, /Veja esta conversa\./);
  const token = /\/ver\/([A-Za-z0-9_-]{30,60})/.exec(em.text_body)![1];
  const w = await get(`/ver/${token}`);
  assert.equal(w.statusCode, 200);
  assert.match(w.body, new RegExp(`src="/ver/${token}/video"`));
  assert.equal((await get(`/ver/${token}/video`)).statusCode, 200);
  assert.equal((await db.one(`SELECT views FROM watch_invites WHERE token_hash=$1`, [(await import('../src/lib.ts')).sha256(token)])).views, 1);
  // WhatsApp: o código só aparece na resposta (nunca no URL); botão com a mensagem pronta
  const wa = await post('/assistir/convites', { episode: epId, channel: 'whatsapp', note: 'Olá!' }, cli.cookie);
  assert.equal(wa.statusCode, 200);
  assert.match(wa.body, /href="https:\/\/wa\.me\/\?text=[^"]*%2Fver%2F[A-Za-z0-9_-]{30,60}"/);
  assert.match(wa.body, /Abrir no WhatsApp/);
  // outra pessoa não convida com o episódio de outro
  const other = `sid=${cookies(await post('/registar', { name: 'Outro', email: 'outro@example.com', password: PW, terms: 1 })).sid}`;
  assert.match(msg(await post('/assistir/convites', { episode: epId, channel: 'email', email: 'x@example.com' }, other)), /Escolha um dos seus episódios/);
  // revogação: o link deixa de abrir
  const inv = await db.one(`SELECT id FROM watch_invites WHERE token_hash=$1`, [(await import('../src/lib.ts')).sha256(token)]);
  assert.match(msg(await post(`/assistir/convites/${inv.id}/revogar`, {}, other)), /inexistente/);
  assert.match(msg(await post(`/assistir/convites/${inv.id}/revogar`, {}, cli.cookie)), /Link revogado/);
  assert.equal((await get(`/ver/${token}`)).statusCode, 404);
  assert.equal((await get(`/ver/${token}/video`)).statusCode, 404);
});
