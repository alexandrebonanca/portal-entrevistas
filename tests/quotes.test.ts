import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';
process.env.VEO_BUSY_WAIT_MS = '400'; // espera depois de uma «procura elevada» simulada (45 s na produção)

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
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
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
const rejectAll = () => db.query(`UPDATE assets SET meta = meta || '{"rejected": true}'::jsonb WHERE interview_id=$1 AND kind='veo_clip' AND deleted_at IS NULL`, [ivId]);
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
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, guest);
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

test('orçamento: o administrador prepara o rascunho; tabela por fala, total e saldo; só o titular aceita, com as duas caixas', async () => {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  // página de produção do cliente: sem Veo direto nem retratos animados; secção do orçamento com as falas
  const pg = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
  assert.doesNotMatch(pg, /value="veo"/); assert.doesNotMatch(pg, /value="lipsync"/);
  assert.match(pg, /Animação por IA \(Google Veo 3\.1 Fast\), por orçamento/);
  assert.match(pg, /≈ 30 créditos por minuto de fala/);
  for (const id of ALL) assert.match(pg, new RegExp(`name="fala" value="${id}" checked`));
  // o administrador prepara o rascunho (grátis, não cativa nada)
  const q = await newQuote(ALL, admin);
  const expected = centsOf(ep, ALL);
  assert.equal(q.price_cents, expected);
  assert.deepEqual([q.status, q.created_by, q.tier, q.engine, q.rate.cents_per_min, q.rate.version, q.lang], ['draft', 'admin@example.com', 'fast', 'veo', 3000, 1, 'en']);
  for (const x of q.selection) {
    const ms = ep.technical.timing.find((t: any) => t.id === x.segmentId).durationMs;
    assert.equal(x.sec, Math.max(4, Math.ceil(ms / 1000)), 's = max(4, ⌈duração⌉)');
    assert.equal(x.cents, Math.ceil((x.sec * 3000) / 60), 'p = ⌈s × tarifa⌉ ao cêntimo');
    assert.equal(x.budgetUsd, Q.budgetUsd(x.cents, 0.95));
    assert.ok(x.chunkKeys.length >= 1 && x.reuseKey && x.take === 1 && !x.reused);
  }
  assert.deepEqual(q.selection.find((x: any) => x.segmentId === 's0').realNames, ['rui']);
  assert.ok(q.cap_usd > 0 && q.cap_usd <= Q.budgetUsd(expected, 0.95), 'teto ≤ Q × 0,815 ÷ câmbio');
  const days = (new Date(q.valid_until).getTime() - Date.now()) / 86400_000;
  assert.ok(days > 6.9 && days <= 7, 'validade de 7 dias');
  assert.equal(await db.one(`SELECT 1 FROM wallet_entries WHERE quote_id=$1`, [q.id]), undefined, 'o rascunho não cativa nada');
  const page = `/entrevistas/${ivId}/orcamentos/${q.id}`, aceitar = `${page}/aceitar`;
  // o administrador nunca aceita em nome do cliente
  assert.match((await get(page, admin)).body, /Só o titular da entrevista \(cliente@example\.com\) pode aceitar este orçamento/);
  assert.match(msg(await post(aceitar, { start_now: '1', waiver: '1' }, admin)), /Só o titular da entrevista aceita o orçamento/);
  // o que o cliente vê antes de aceitar
  const pc = (await get(page, cli.cookie)).body;
  for (const s of ['Google Veo 3.1 Fast, 720p', `${W.cr(expected)} créditos (= ${eurPt(expected)} + IVA, já pago no carregamento)`, '≈ 30 créditos por minuto de fala', '0 créditos → 0 créditos depois de aceitar (insuficiente)',
    'nomes de pessoas reais (rui): risco de recusa pelo filtro da Google; se recusar, fica em fotografia e não paga', 'Peço que a produção comece já.', 'Aceito este orçamento e as condições acima',
    `<button class="accent" disabled>Aceitar e pagar ${W.cr(expected)} créditos</button>`, `/conta/creditos/carregar?falta=${expected}&amp;voltar=${encodeURIComponent(page)}`,
    'O orçamento aceite é o máximo', 'AI-generated video · AI voice', 'Empresa Vendedora de Teste, Lda.', 'Livro de Reclamações Eletrónico', 'Até '])
    assert.ok(pc.includes(s), s);
  assert.doesNotMatch(pc, /type="checkbox" name="(start_now|waiver)" value="1" checked/, 'caixas não pré-assinaladas');
  // sem as caixas e sem saldo: nada é cativado nem posto na fila
  assert.match(msg(await post(aceitar, { start_now: '1' }, cli.cookie)), /assinale as duas caixas/);
  assert.match(msg(await post(aceitar, { start_now: '1', waiver: '1' }, cli.cookie)), new RegExp(`Saldo insuficiente: o orçamento é de ${W.cr(expected).replace(',', '\\,')} créditos e tem 0`));
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE kind='render_video'`)).n), 0);
  // carregamento e aceitação: valor cativo, trabalho na fila (um por orçamento) e o email com o orçamento e as condições
  await credit(cli.id, 10000);
  const ok = await post(aceitar, { start_now: '1', waiver: '1' }, cli.cookie);
  assert.match(msg(ok), new RegExp(`Orçamento aceite: ${W.cr(expected)} créditos cativos`));
  const qa = await quoteOf(q.id);
  assert.deepEqual([qa.status, qa.accepted_by, qa.terms_version, qa.acceptance.startNow, qa.acceptance.consumer, qa.acceptance.second], ['accepted', 'cliente@example.com', '2026-10-23', true, false, 'conditions']);
  assert.ok(qa.accepted_ip);
  const w = await walletOf(cli.id);
  assert.deepEqual([w.available_cents, w.reserved_cents], [10000 - expected, expected]);
  const job = await db.one(`SELECT * FROM jobs WHERE dedupe_key=$1`, [`video:quote:${q.id}`]);
  assert.deepEqual([job.state, job.input.quoteId, job.input.engine, job.input.requestedBy, job.id], ['queued', q.id, 'veo', cli.id, qa.job_id]);
  const em = await db.one(`SELECT * FROM emails WHERE dedupe_key=$1`, [`quote:${q.id}`]);
  for (const s of [`Total: ${W.cr(expected)} créditos`, 'Peço que a produção comece já.', 'O orçamento aceite é o máximo', 'Empresa Vendedora de Teste, Lda.', 's0 · Entrevistador']) assert.ok(em.text_body.includes(s), s);
  const au = await db.one(`SELECT meta FROM audit_events WHERE action='animation.quote_accepted' AND interview_id=$1`, [ivId]);
  assert.deepEqual([au.meta.quote, au.meta.terms, !!au.meta.ip], [q.id, '2026-10-23', true]);
  // duplo clique: um só trabalho e uma só cativação
  assert.match(msg(await post(aceitar, { start_now: '1', waiver: '1' }, cli.cookie)), /já não está por aceitar/);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM wallet_entries WHERE kind='reserve' AND ref=$1`, [`quote:${q.id}`])).n), 1);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE kind='render_video'`)).n), 1);
  // pedidos diretos do cliente continuam recusados
  assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { lang: 'en', engine: 'veo' }, cli.cookie)), /faz-se por orçamento/);
  await check();
});

test('liquidação: cobra só as falas animadas e verificadas, liberta o resto, relatório por fala; teto; confirmação antes de começar', async () => {
  const q = await db.one(`SELECT * FROM animation_quotes WHERE status='accepted'`);
  V.veoMock.outcome = c => (c.segmentId === 'q1' ? 'mismatch' : 'ok');
  try { await drain(); } finally { V.veoMock.outcome = null; }
  const job = await db.one('SELECT * FROM jobs WHERE id=$1', [q.job_id]);
  assert.equal(job.state, 'done', job.error ?? '');
  const s = await quoteOf(q.id);
  const p = (id: string) => s.selection.find((x: any) => x.segmentId === id).cents;
  assert.equal(s.status, 'settled');
  assert.deepEqual([s.charged_cents, s.released_cents], [s.price_cents - p('q1'), p('q1')]);
  const rep = new Map(s.settlement.segments.map((x: any) => [x.segmentId, x]));
  assert.deepEqual([(rep.get('q1') as any).status, (rep.get('q1') as any).reason], ['photo', 'mismatch']);
  for (const id of ['s0', 'q0', 'a0', 'a1', 'sx']) assert.equal((rep.get(id) as any).status, 'charged', id);
  const w = await walletOf(cli.id);
  assert.deepEqual([w.available_cents, w.reserved_cents], [10000 - s.charged_cents, 0]);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM animation_charges WHERE quote_id=$1`, [q.id])).n), 5);
  // vídeo ligado ao episódio, com a fala falhada em fotografia
  const vm = (await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [epId])).meta;
  assert.deepEqual([vm.quoteId, vm.fallbackSegments, vm.guestAiVideo, vm.hostAiVideo], [q.id, ['q1'], true, true]);
  // teto: intenção gravada antes de cada envio; nada fica reservado; o gasto nunca passa o teto
  const ops = await db.query('SELECT state, cost_usd, segment_key FROM veo_ops WHERE quote_id=$1', [q.id]);
  assert.ok(ops.length > 0 && ops.every((o: any) => ['done', 'failed'].includes(o.state)), JSON.stringify(ops));
  assert.ok(ops.reduce((n: number, o: any) => n + o.cost_usd, 0) <= s.cap_usd + 1e-9);
  assert.equal(s.spent_usd, ops.reduce((n: number, o: any) => n + o.cost_usd, 0));
  const q1 = s.selection.find((x: any) => x.segmentId === 'q1');
  // 1.ª passagem de todos os pedaços; na 2.ª, a repetição do primeiro também falha e a fala já não fica completa: pára aí
  assert.equal(ops.filter((o: any) => o.segment_key === q1.reuseKey).length, q1.chunks + 1, 'não se gasta mais numa fala que já não fica completa');
  // a confirmação (suporte duradouro) saiu antes de a produção começar; o resultado segue por email
  const conf = await db.one(`SELECT state, sent_at FROM emails WHERE dedupe_key=$1`, [`quote:${q.id}`]);
  assert.equal(conf.state, 'sent'); assert.ok(new Date(conf.sent_at) <= new Date(s.started_at));
  assert.ok(await db.one(`SELECT 1 FROM emails WHERE dedupe_key=$1`, [`quote-settled:${q.id}`]));
  const pg = (await get(`/entrevistas/${ivId}/orcamentos/${q.id}`, cli.cookie)).body;
  assert.ok(pg.includes(`Produção concluída: cobrados <strong>${W.cr(s.charged_cents)}</strong> créditos`));
  assert.match(pg, /fotografia: 0 cr<\/span> <span class="hint">o texto dito não coincidiu com o guião/);
  const st = (await get('/conta/creditos', cli.cookie)).body;
  assert.match(st, /Charged from hold/); assert.match(st, /Released from hold/);
  await check();
});

test('reaproveitamento: falas pagas a 0 créditos; a que esgotou as tentativas passa a um take novo; clipes rejeitados saem do reaproveitamento', async () => {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  const q = await newQuote(ALL);
  const by = new Map(q.selection.map((x: any) => [x.segmentId, x]));
  for (const id of ['s0', 'q0', 'a0', 'a1', 'sx']) assert.deepEqual([(by.get(id) as any).reused, (by.get(id) as any).cents], [true, 0], id);
  assert.deepEqual([(by.get('q1') as any).reused, (by.get('q1') as any).take, (by.get('q1') as any).cents], [false, 2, centsOf(ep, ['q1'])], 'take novo: tentativas novas, paga-se só se sair animada');
  assert.equal(q.price_cents, centsOf(ep, ['q1']));
  assert.match((await get(`/entrevistas/${ivId}/orcamentos/${q.id}`, cli.cookie)).body, /reaproveitado: 0 cr/);
  const before = (await walletOf(cli.id)).available_cents;
  // as falas já pagas foram geradas noutro nível (o Lite): o resumo do vídeo não as dá como do modelo pedido agora
  const FAST = 'veo-3.1-fast-generate-preview', LITE = 'veo-3.1-lite-generate-preview';
  await db.query(`UPDATE assets SET meta = meta || jsonb_build_object('model', $2::text) WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'segmentId'<>'q1'`, [ivId, LITE]);
  await accept(q);
  await drain();
  const s = await quoteOf(q.id);
  assert.deepEqual([s.status, s.charged_cents, s.released_cents], ['settled', q.price_cents, 0]);
  const vm = (await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [epId])).meta;
  assert.deepEqual([vm.generatedClips, vm.fallbackSegments], [(by.get('q1') as any).chunks, []], 'só a fala nova foi gerada');
  assert.ok(vm.fidelity.filter((f: any) => f.reused).length > 0);
  assert.equal(vm.model, FAST);
  assert.deepEqual(vm.clipModels, { [FAST]: (by.get('q1') as any).chunks, [LITE]: vm.veoClips - (by.get('q1') as any).chunks }, 'modelo de cada clipe que entrou no vídeo');
  const prod = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
  assert.match(prod, /pedido ao Google Veo 3\.1 Fast \(veo-3\.1-fast-generate-preview\): \d+ clipes/);
  assert.match(prod, new RegExp(`clipes no vídeo: [^<]*${vm.clipModels[LITE]} do Google Veo 3\\.1 Lite \\(veo-3\\.1-lite-generate-preview\\), de gerações anteriores`));
  assert.match(prod, new RegExp(`clipes no vídeo: [^<]*${vm.clipModels[FAST]} do Google Veo 3\\.1 Fast \\(veo-3\\.1-fast-generate-preview\\)(?!, de gerações)`));
  assert.equal((await walletOf(cli.id)).available_cents, before - q.price_cents);
  // clipes rejeitados (defeito objetivo ou gosto): saem do reaproveitamento; o take seguinte gera clipes novos e paga-se
  await db.query(`UPDATE assets SET meta = meta || '{"rejected": true}'::jsonb WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'segmentId'='q0'`, [ivId]);
  const r = await newQuote(ALL);
  const rq0 = r.selection.find((x: any) => x.segmentId === 'q0');
  assert.deepEqual([rq0.reused, rq0.take, r.price_cents], [false, 2, centsOf(ep, ['q0'])]);
  assert.ok(r.selection.filter((x: any) => x.segmentId !== 'q0').every((x: any) => x.reused), 'as outras falas (q1 no take 2) estão pagas');
  await accept(r);
  await drain();
  assert.deepEqual([(await quoteOf(r.id)).status, (await quoteOf(r.id)).charged_cents], ['settled', r.price_cents]);
  const fresh = await db.query(`SELECT meta FROM assets WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'segmentId'='q0' AND COALESCE(meta->>'rejected','')<>'true'`, [ivId]);
  assert.equal(fresh.length, rq0.chunks);
  assert.ok(fresh.every((a: any) => a.meta.take === 2 && a.meta.quoteId === r.id));
  assert.ok(await db.one(`SELECT 1 FROM animation_charges WHERE interview_id=$1 AND reuse_key=$2 AND take=2`, [ivId, rq0.reuseKey]));
  assert.equal((await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [epId])).meta.guestAiVideo, true);
  await check();
});

test('RGPD: o convidado retira a autorização do Veo — os clipes e vídeos com a imagem dele são apagados; reconstrução a 0 créditos só com o entrevistador', async () => {
  const clips = await db.query(`SELECT id, storage_key FROM assets WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'role'='guest' AND deleted_at IS NULL`, [ivId]);
  assert.ok(clips.length > 0);
  const wBefore = await walletOf(cli.id), charges = Number((await db.one('SELECT count(*)::int n FROM animation_charges WHERE interview_id=$1', [ivId])).n);
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1' }, guest);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'role'='guest' AND deleted_at IS NULL`, [ivId])).n), 0);
  for (const c of clips) await assert.rejects(storage.get(c.storage_key), 'ficheiro apagado');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='episode_video' AND meta->>'guestAiVideo'='true' AND deleted_at IS NULL`, [ivId])).n), 0);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [epId])).video_asset_id, null);
  // o que foi entregue continua cobrado
  assert.deepEqual([(await walletOf(cli.id)).available_cents, Number((await db.one('SELECT count(*)::int n FROM animation_charges WHERE interview_id=$1', [ivId])).n)], [wBefore.available_cents, charges]);
  // reconstrução só com o entrevistador: clipes já pagos, nada vai à Google, 0 créditos
  const last = await db.one(`SELECT id FROM animation_quotes WHERE interview_id=$1 AND status='settled' ORDER BY settled_at DESC LIMIT 1`, [ivId]);
  const page = (await get(`/entrevistas/${ivId}/orcamentos/${last.id}`, cli.cookie)).body;
  assert.match(page, /Reconstruir só com o entrevistador \(0 créditos\)/);
  const ops = Number((await db.one('SELECT count(*)::int n FROM veo_ops WHERE interview_id=$1', [ivId])).n);
  assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${last.id}/reconstruir`, {}, cli.cookie)), /Reconstrução do vídeo só com o entrevistador iniciada/);
  await drain();
  const job = await lastJob();
  assert.equal(job.state, 'done', job.error ?? '');
  const vm = (await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [epId])).meta;
  assert.deepEqual([vm.rebuildOf, vm.hostAiVideo, vm.guestAiVideo, vm.generatedClips, vm.veoSegments], [last.id, true, false, 0, HOST.length]);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM veo_ops WHERE interview_id=$1', [ivId])).n), ops, 'nada foi enviado à Google');
  assert.equal((await walletOf(cli.id)).available_cents, wBefore.available_cents);
  // as falas do convidado deixam de se poder orçamentar
  const pg = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
  assert.doesNotMatch(pg, /name="fala" value="a0"/); assert.match(pg, /name="fala" value="q0"/);
  assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/orcamento`, { fala: ['a0'], lang: 'en' }, cli.cookie)), /Escolha pelo menos uma fala autorizada/);
  await check();
});

test('falhas e pausas: autorização retirada liberta tudo; quota esgotada pausa sem falhar e retoma; validade, trabalho parado e cancelamento libertam', async () => {
  const avail = async () => (await walletOf(cli.id)).available_cents;
  // (a) o entrevistador retira a autorização antes de a produção começar
  await rejectAll();
  let a0 = await avail();
  let q = await accept(await newQuote(HOST));
  assert.equal(await avail(), a0 - q.price_cents);
  await db.query('UPDATE interviews SET host_ai_video=false WHERE id=$1', [ivId]);
  await drain();
  await db.query('UPDATE interviews SET host_ai_video=true WHERE id=$1', [ivId]);
  let s = await quoteOf(q.id);
  assert.equal((await db.one('SELECT state FROM jobs WHERE id=$1', [q.job_id])).state, 'failed');
  assert.equal(s.status, 'void'); assert.match(s.void_reason, /autorização do entrevistador/);
  assert.deepEqual([await avail(), (await walletOf(cli.id)).reserved_cents, s.released_cents], [a0, 0, q.price_cents]);
  assert.equal(Number((await db.one('SELECT count(*)::int n FROM veo_ops WHERE quote_id=$1', [q.id])).n), 0, 'nada foi enviado à Google');
  // (b) quota da Google esgotada: o trabalho volta à fila mais tarde (sem gastar tentativas) e o orçamento continua em curso
  q = await accept(await newQuote(HOST));
  V.veoMock.outcome = () => 'quota';
  try { await drain(); } finally { V.veoMock.outcome = null; }
  let job = await db.one('SELECT * FROM jobs WHERE id=$1', [q.job_id]);
  assert.deepEqual([job.state, job.attempts], ['queued', 0]);
  assert.ok(new Date(job.run_after).getTime() > Date.now() + 60_000); assert.match(job.progress_label, /A aguardar quota da Google/);
  s = await quoteOf(q.id);
  assert.equal(s.status, 'running'); assert.match(s.status_note, /A aguardar quota da Google/);
  assert.equal((await walletOf(cli.id)).reserved_cents, q.price_cents);
  assert.ok((await db.query('SELECT state, cost_usd FROM veo_ops WHERE quote_id=$1', [q.id])).every((o: any) => o.state === 'void' && o.cost_usd === 0), 'recusados antes de a Google aceitar: custo 0');
  assert.match((await get(`/entrevistas/${ivId}/orcamentos/${q.id}`, cli.cookie)).body, /A aguardar quota da Google/);
  await db.query('UPDATE jobs SET run_after=now() WHERE id=$1', [q.job_id]);
  await drain();
  s = await quoteOf(q.id);
  assert.deepEqual([s.status, s.charged_cents, s.released_cents], ['settled', q.price_cents, 0]);
  // (c) validade terminada antes de a produção começar
  await rejectAll();
  a0 = await avail();
  q = await accept(await newQuote(HOST));
  await db.query(`UPDATE animation_quotes SET valid_until=now() - interval '1 minute' WHERE id=$1`, [q.id]);
  await drain();
  s = await quoteOf(q.id);
  assert.equal(s.status, 'void'); assert.match(s.void_reason, /passou a validade/);
  assert.equal(await avail(), a0);
  // (d) trabalho dado como falhado sem passar pelo __onFail (ex.: reinício): a limpeza periódica liberta
  q = await accept(await newQuote(HOST));
  await db.query(`UPDATE jobs SET state='failed', error='Interrompido pelo reinício do servidor' WHERE id=$1`, [q.job_id]);
  assert.deepEqual(await Q.quoteHousekeeping(db), { voided: 0, released: 1 });
  s = await quoteOf(q.id);
  assert.equal(s.status, 'void'); assert.equal(await avail(), a0);
  // (e) aceite à espera da nossa fila (outro vídeo a correr): o prazo de 24 h ainda não conta; a página mostra a posição.
  // Quando a via fica livre, o vídeo pode arrancar; se não arrancar nas 24 h seguintes, é anulado e libertado.
  const other = await db.one(`INSERT INTO jobs(kind, input, state, attempts, locked_at, started_at) VALUES ('render_video', '{"engine":"veo"}', 'running', 1, now(), now()) RETURNING id`);
  q = await accept(await newQuote(HOST));
  await db.query(`UPDATE jobs SET created_at=now() - interval '2 days', run_after=now() - interval '2 days' WHERE id=$1`, [q.job_id]);
  assert.equal(await J.markReady(db), 0, 'a via está ocupada por outro vídeo');
  assert.deepEqual(await Q.quoteHousekeeping(db), { voided: 0, released: 0 }, 'dois dias à espera da fila não contam');
  const pg = (await get(`/entrevistas/${ivId}/orcamentos/${q.id}`, cli.cookie)).body;
  assert.match(pg, /está na fila com 1 vídeo\(s\) à frente \(~30 min de espera\)/);
  assert.match(pg, /a espera pelos vídeos à frente na fila não conta/);
  const prog = JSON.parse((await get(`/entrevistas/${ivId}/progresso`, cli.cookie)).body);
  assert.equal(prog.label, 'Em fila: 1 vídeo(s) à frente (~30 min)');
  await db.query(`UPDATE jobs SET state='done', finished_at=now() WHERE id=$1`, [other.id]);
  assert.equal(await J.markReady(db), 1);
  assert.match((await get(`/entrevistas/${ivId}/orcamentos/${q.id}`, cli.cookie)).body, /é o próximo vídeo da fila/);
  assert.deepEqual(await Q.quoteHousekeeping(db), { voided: 0, released: 0 }, 'acabou de poder arrancar');
  await db.query(`UPDATE jobs SET ready_at=now() - interval '25 hours' WHERE id=$1`, [q.job_id]);
  assert.deepEqual(await Q.quoteHousekeeping(db), { voided: 0, released: 1 });
  assert.equal((await db.one('SELECT state FROM jobs WHERE id=$1', [q.job_id])).state, 'failed');
  assert.match((await quoteOf(q.id)).void_reason, /não arrancou em 24 h/);
  // (f) cancelado pelo cliente antes de começar
  q = await accept(await newQuote(HOST));
  assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${q.id}/cancelar`, {}, cli.cookie)), /Orçamento cancelado: nada foi cobrado/);
  assert.equal((await quoteOf(q.id)).status, 'cancelled'); assert.equal(await avail(), a0);
  // (g) rascunho fora da validade
  const d = await newQuote(HOST);
  await db.query(`UPDATE animation_quotes SET valid_until=now() - interval '1 minute' WHERE id=$1`, [d.id]);
  assert.deepEqual(await Q.quoteHousekeeping(db), { voided: 1, released: 0 });
  assert.equal((await quoteOf(d.id)).status, 'void');
  await check();
});

test('reinício a meio da produção: não gasta tentativa e retoma sem pagar de novo os clipes feitos; depois da liquidação, o resultado é o mesmo', async () => {
  await rejectAll();
  const a0 = (await walletOf(cli.id)).available_cents;
  const q = await accept(await newQuote(HOST));
  const keys = new Set((q.selection as any[]).filter(x => !x.reused).flatMap(x => x.chunkKeys));
  // 1.ª execução: alguns clipes feitos e a quota da Google esgota-se (os clipes ficam guardados; o orçamento continua em curso)
  let n = 0;
  V.veoMock.outcome = () => (++n <= 4 ? 'ok' : 'quota');
  try { await drain(); } finally { V.veoMock.outcome = null; }
  assert.equal((await quoteOf(q.id)).status, 'running');
  const before = Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE quote_id=$1 AND state='done'`, [q.id])).n);
  assert.ok(before >= 4 && before < keys.size, `clipes feitos antes do reinício: ${before} de ${keys.size}`);
  // O processo morre a meio da 3.ª (última) tentativa: no arranque o trabalho retoma, sem gastar a tentativa.
  await db.query(`UPDATE jobs SET state='running', attempts=3, locked_at=now(), run_after=now() WHERE id=$1`, [q.job_id]);
  assert.deepEqual(await J.recoverOrphans(db, handlers), { resumed: 1, failed: 0 });
  let job = await db.one('SELECT * FROM jobs WHERE id=$1', [q.job_id]);
  assert.deepEqual([job.state, job.attempts, job.interruptions], ['queued', 2, 1]);
  await drain();
  job = await db.one('SELECT * FROM jobs WHERE id=$1', [q.job_id]);
  assert.deepEqual([job.state, job.attempts], ['done', 3], job.error ?? '');
  let s = await quoteOf(q.id);
  assert.deepEqual([s.status, s.charged_cents, s.released_cents], ['settled', q.price_cents, 0]);
  // cada pedaço foi pago à Google uma só vez: os clipes de antes do reinício reaproveitaram-se
  assert.deepEqual(await db.query(`SELECT chunk_key FROM veo_ops WHERE quote_id=$1 AND state<>'void' GROUP BY 1 HAVING count(*) > 1`, [q.id]), []);
  const ops = Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE quote_id=$1 AND state<>'void'`, [q.id])).n);
  assert.equal(ops, keys.size);
  // O processo morre depois da liquidação e antes de dar o trabalho por terminado: a retoma devolve o mesmo resultado.
  await db.query(`UPDATE jobs SET state='running', locked_at=now() WHERE id=$1`, [q.job_id]);
  assert.deepEqual(await J.recoverOrphans(db, handlers), { resumed: 1, failed: 0 });
  await drain();
  job = await db.one('SELECT * FROM jobs WHERE id=$1', [q.job_id]);
  assert.equal(job.state, 'done'); assert.equal(job.result.resumedAfterSettlement, true); assert.equal(job.result.chargedCents, q.price_cents);
  s = await quoteOf(q.id);
  assert.deepEqual([s.status, s.charged_cents], ['settled', q.price_cents]);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE quote_id=$1 AND state<>'void'`, [q.id])).n), ops, 'nada foi enviado outra vez');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM emails WHERE dedupe_key=$1`, [`quote-settled:${q.id}`])).n), 1);
  const w = await walletOf(cli.id);
  assert.deepEqual([w.available_cents, w.reserved_cents], [a0 - q.price_cents, 0]);
  await check();
});

test('canário: dos primeiros 8 pedaços, menos de 4 aprovados param a produção e libertam tudo', async () => {
  await rejectAll();
  const a0 = (await walletOf(cli.id)).available_cents;
  const q = await accept(await newQuote(HOST));
  assert.ok(q.selection.reduce((n: number, x: any) => n + x.chunks, 0) >= 8, 'pelo menos 8 pedaços novos');
  V.veoMock.outcome = () => 'mismatch';
  try { await drain(); } finally { V.veoMock.outcome = null; }
  const job = await db.one('SELECT * FROM jobs WHERE id=$1', [q.job_id]);
  assert.equal(job.state, 'failed'); assert.match(job.error, /Dos primeiros 8 pedaços, menos de 4 passaram/);
  const s = await quoteOf(q.id);
  assert.deepEqual([s.status, s.released_cents], ['void', q.price_cents]);
  assert.equal((await walletOf(cli.id)).available_cents, a0);
  const n = Number((await db.one('SELECT count(*)::int n FROM veo_ops WHERE quote_id=$1', [q.id])).n);
  assert.ok(n >= 5 && n <= 8, `pára cedo: ${n} clipes`);
  await check();
});

test('canário: uma tentativa contada que acaba sem nada enviado devolve o lugar e acorda quem espera', async () => {
  let failed: Error | null = null;
  const g = V.canaryGate(true, () => !!failed, e => { failed ??= e; });
  for (let i = 0; i < V.CANARY_CHUNKS; i++) assert.equal(await g.enter(), true);
  for (let i = 0; i < V.CANARY_CHUNKS - 1; i++) g.leave('ok');
  let entered: boolean | null = null;
  const p = g.enter().then(v => { entered = v; });
  await new Promise(r => setImmediate(r));
  assert.equal(entered, null, 'o 9.º espera pelo resultado do 8.º');
  g.leave('stop'); // o 8.º acabou sem nada enviado (procura elevada, teto): o lugar passa ao seguinte
  await p;
  assert.equal(entered, true, 'o que esperava passa a contar como 8.º');
  g.leave('ok');
  assert.equal(await g.enter(), false, 'com os 8 resultados, os seguintes já não contam nem esperam');
  assert.equal(failed, null);
  // trabalho parado: quem espera sai logo
  let stopped: Error | null = null;
  const g2 = V.canaryGate(true, () => !!stopped, () => {});
  for (let i = 0; i < V.CANARY_CHUNKS; i++) await g2.enter();
  const w = g2.enter();
  stopped = new Error('parado'); g2.notify();
  assert.equal(await w, false);
});

test('canário: «procura elevada» no 8.º pedaço (o último da passagem A a seguir é o 9.º) não deixa o trabalho preso', async () => {
  await rejectAll();
  const q = await accept(await newQuote(['q0', 'q1', 'sx']));
  assert.equal(q.selection.reduce((n: number, x: any) => n + x.chunks, 0), 9, 'exatamente 9 pedaços novos: o canário está ligado e o 9.º é o último');
  // O 8.º pedaço a arrancar recebe 3 vezes «procura elevada» (sem nada enviado nem cobrado); depois passa.
  const seen: string[] = [], calls = new Map<string, number>();
  V.veoMock.outcome = c => {
    if (!seen.includes(c.text)) seen.push(c.text);
    const n = (calls.get(c.text) ?? 0) + 1; calls.set(c.text, n);
    return seen.indexOf(c.text) === V.CANARY_CHUNKS - 1 && n <= 3 ? 'busy' : 'ok';
  };
  try {
    await Promise.race([drain(), new Promise((_, rej) => setTimeout(() => rej(new Error('o trabalho ficou preso à espera do canário')), 120_000).unref())]);
  } finally { V.veoMock.outcome = null; }
  const job = await db.one('SELECT state, error FROM jobs WHERE id=$1', [q.job_id]);
  assert.equal(job.state, 'done', job.error ?? '');
  const s = await quoteOf(q.id);
  assert.deepEqual([s.status, s.charged_cents, s.released_cents], ['settled', q.price_cents, 0], 'a repetição na 2.ª passagem completou a fala');
  const busy = await db.query(`SELECT state, cost_usd FROM veo_ops WHERE quote_id=$1 AND state='void'`, [q.id]);
  assert.ok(busy.length >= 3 && busy.every((o: any) => o.cost_usd === 0), 'recusados antes de a Google aceitar: custo 0');
  await check();
});

test('teto: uma fala só arranca se o teto cobrir a 1.ª passagem dela; na 2.ª passagem cada fala tem o seu orçamento (b_i)', async () => {
  await rejectAll();
  const q = await accept(await newQuote(HOST));
  const sx = q.selection.find((x: any) => x.segmentId === 'sx');
  assert.equal(sx.chunks, 1);
  // teto só para a fala de um pedaço (8 s × 0,10 $) e orçamento mínimo dessa fala para as repetições
  await db.query(`UPDATE animation_quotes SET cap_usd=0.8, selection=(SELECT jsonb_agg(CASE WHEN x->>'segmentId'='sx' THEN x || '{"budgetUsd":0.05}'::jsonb ELSE x END ORDER BY o) FROM jsonb_array_elements(selection) WITH ORDINALITY AS e(x, o)) WHERE id=$1`, [q.id]);
  V.veoMock.outcome = c => (c.segmentId === 'sx' ? 'mismatch' : 'ok');
  try { await drain(); } finally { V.veoMock.outcome = null; }
  const s = await quoteOf(q.id);
  assert.equal(s.status, 'settled', (await db.one('SELECT error FROM jobs WHERE id=$1', [q.job_id]))?.error ?? '');
  assert.deepEqual([s.charged_cents, s.released_cents], [0, q.price_cents]);
  assert.deepEqual(s.settlement.segments.map((x: any) => [x.segmentId, x.status, x.reason]), HOST.map(id => [id, 'photo', 'capped_budget']));
  const ops = await db.query('SELECT cost_usd FROM veo_ops WHERE quote_id=$1', [q.id]);
  assert.equal(ops.length, 1, 'só a 1.ª tentativa da fala que cabia no teto');
  assert.ok(ops[0].cost_usd <= 0.8);
  const vm = (await db.one('SELECT a.meta FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [epId])).meta;
  assert.ok(vm.fidelity.some((f: any) => f.problem === 'capped_budget'));
  assert.match((await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body, /teto do orçamento atingido: fotografia fixa, não cobrada/);
  await check();
});

test('tarifas: editáveis pelo administrador só para orçamentos novos; o Omni não se ativa; o nível do Veo escolhe a tarifa', async () => {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  const pg = (await get('/admin/definicoes', admin)).body;
  assert.match(pg, /Tarifas da animação \(orçamentos\)/); assert.match(pg, /por integrar e medir no Laboratório: não se pode ativar/);
  await rejectAll();
  const d = await newQuote(HOST);
  assert.equal(d.price_cents, centsOf(ep, HOST, 3000));
  assert.match(msg(await post('/admin/tarifas/veo-fast', { cr_min: '45', cost: '0.15', usd_eur: '0.95', max_clip: '8', valid_until: '', active: '1' }, admin)), /Tarifa Google Veo 3\.1 Fast guardada \(versão 2\)/);
  // o rascunho com a tarifa antiga já não se aceita; um orçamento novo usa a tarifa nova
  assert.match((await get(`/entrevistas/${ivId}/orcamentos/${d.id}`, cli.cookie)).body, /A tarifa mudou depois deste orçamento/);
  assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${d.id}/aceitar`, { start_now: '1', waiver: '1' }, cli.cookie)), /A tarifa mudou/);
  const n = await newQuote(HOST);
  assert.deepEqual([n.price_cents, n.rate.version, n.rate.cents_per_min], [centsOf(ep, HOST, 4500), 2, 4500]);
  const terms = (await get('/termos')).body;
  assert.match(terms, /Google Veo 3\.1 Fast \(720p\), 45 créditos por minuto de fala \(55,35 € com IVA de 23%\)/);
  assert.doesNotMatch(terms, /Veo 3\.1 Lite/, 'os termos só anunciam a tarifa que se vende');
  assert.equal(eurPt(withVat(4500, 23)), '55,35 €');
  // o custo registado é o da tarifa (0,15 $/s), o mesmo que se reserva no teto: operações, orçamento e fator batem certo
  await credit(cli.id, 5000);
  await accept(n);
  await drain();
  const sn = await quoteOf(n.id);
  assert.equal(sn.status, 'settled');
  const nops = await db.query(`SELECT usd_per_sec, cost_usd, duration_sec FROM veo_ops WHERE quote_id=$1 AND state<>'void'`, [n.id]);
  assert.ok(nops.length > 0 && nops.every((o: any) => Number(o.usd_per_sec) === 0.15 && Math.abs(o.cost_usd - o.duration_sec * 0.15) < 1e-9), JSON.stringify(nops));
  assert.ok(Math.abs(sn.spent_usd - nops.reduce((s: number, o: any) => s + o.cost_usd, 0)) < 1e-9);
  assert.equal(await V.veoCostPerSec(db, 'fast'), 0.15, 'o mesmo custo para o administrador, o gestor e a introdução');
  await rejectAll();
  assert.match(msg(await post('/admin/tarifas/omni-flash', { cr_min: '30', cost: '0.101', usd_eur: '0.95', max_clip: '10', active: '1' }, admin)), /não se pode ativar/);
  assert.equal((await db.one(`SELECT active FROM animation_rates WHERE id='omni-flash'`)).active, false);
  // o Lite não se oferece (texto inventado no ecrã): fora de venda, não se ativa e, com o nível Lite nas Definições, não há orçamento
  const lite = await db.one(`SELECT active, available FROM animation_rates WHERE id='veo-lite'`);
  assert.deepEqual([lite.active, lite.available], [false, false]);
  assert.match(msg(await post('/admin/tarifas/veo-lite', { cr_min: '15', cost: '0.05', usd_eur: '0.95', max_clip: '8', valid_until: '', active: '1' }, admin)), /não se oferece[^;]*; não se pode ativar/);
  assert.equal((await db.one(`SELECT active FROM animation_rates WHERE id='veo-lite'`)).active, false);
  await saveSetting(db, 'VEO_TIER', 'lite');
  try {
    assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/orcamento`, { fala: HOST, lang: 'en' }, cli.cookie)), /Google Veo 3\.1 Lite não está disponível de momento/);
    assert.equal(await Q.rateForTier(db, 'lite'), null);
  } finally { await saveSetting(db, 'VEO_TIER', ''); }
  // motor desativado: nada se orçamenta
  await post('/admin/tarifas/veo-fast', { cr_min: '30', cost: '0.10', usd_eur: '0.95', max_clip: '8', valid_until: '' }, admin);
  assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/orcamento`, { fala: HOST, lang: 'en' }, cli.cookie)), /não está disponível de momento/);
  await post('/admin/tarifas/veo-fast', { cr_min: '30', cost: '0.10', usd_eur: '0.95', max_clip: '8', valid_until: '', active: '1' }, admin);
  assert.equal((await db.one(`SELECT version FROM animation_rates WHERE id='veo-fast'`)).version, 4);
  await check();
});

test('preço por fala, teto e cauda dos pedaços (contas da decisão do juiz)', () => {
  assert.equal(Q.speechSec(2900), 4, 'uma fala de 2,9 s conta 4 s');
  assert.equal(Q.speechSec(12_400), 13);
  assert.equal(Q.segmentCents(13, 3000), 650, '13 s a 30 cr/min = 6,50 cr');
  assert.equal(Q.segmentCents(13, 750), 163, '13 s a 7,5 cr/min = 1,625 → 1,63 cr (para cima)');
  assert.equal(Q.segmentCents(200, 3000), 10_000, 'anfitrião, 200 s: 100 cr');
  assert.equal(Q.budgetUsd(10_000, 0.9363), 87.0447, 'teto de 100 cr: 87,04 $');
  assert.equal(Q.recommendedCentsPerMin({ cost_usd_per_sec: 0.10, usd_eur: 0.9363 }), 2915, '≈ 29,1 cr/min: publica-se 30');
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');
  assert.deepEqual(V.chunkText(`${words(17)}.`), [`${words(17)}.`], 'cauda de 2 palavras colada (17 ≤ 18)');
  assert.deepEqual(V.chunkText(`Yes. ${words(15)}.`), [`Yes. ${words(15)}.`], 'cabeça de 1 palavra colada ao seguinte');
  assert.equal(V.chunkText(`${words(15)}. ${words(4)}.`).length, 2, '4 palavras não são cauda');
});

test('consumidor: € com IVA primeiro, botão «Aceitar e pagar … €» e o reconhecimento sobre a livre resolução', async () => {
  // o cliente passa a comprar como consumidor nos Açores (IVA de 16%)
  await db.query(`UPDATE billing_profiles SET kind='consumer', nif=NULL, postal_code='9500-001', city='Ponta Delgada' WHERE user_id=$1`, [cli.id]);
  try {
    await rejectAll();
    const q = await newQuote(HOST);
    const gross = withVat(q.price_cents, 16);
    const pg = (await get(`/entrevistas/${ivId}/orcamentos/${q.id}`, cli.cookie)).body;
    for (const s of [`${eurPt(gross)} com IVA (${W.cr(q.price_cents)} créditos)`, `≈ ${eurPt(withVat(3000, 16))} por minuto de fala, com IVA (30 créditos)`,
      `Aceitar e pagar ${eurPt(gross)} (${W.cr(q.price_cents)} créditos)`, 'Reconheço que perco o direito de livre resolução quando a produção estiver concluída.', 'Livre resolução.'])
      assert.ok(pg.includes(s), s);
    assert.match((await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body, new RegExp(`≈ ${eurPt(withVat(3000, 16))} por minuto de fala, com IVA`));
    const ok = await post(`/entrevistas/${ivId}/orcamentos/${q.id}/aceitar`, { start_now: '1', waiver: '1' }, cli.cookie);
    assert.match(msg(ok), /Orçamento aceite/);
    const a = (await quoteOf(q.id)).acceptance;
    assert.deepEqual([a.consumer, a.second, a.vatRate], [true, 'waiver', 16]);
    assert.match((await db.one(`SELECT text_body FROM emails WHERE dedupe_key=$1`, [`quote:${q.id}`])).text_body, /Livre resolução: tem 14 dias/);
    assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${q.id}/cancelar`, {}, cli.cookie)), /Orçamento cancelado/);
  } finally {
    await db.query(`UPDATE billing_profiles SET kind='business', nif=$2, postal_code='1000-001', city='Lisboa' WHERE user_id=$1`, [cli.id, nifOf('51234567')]);
  }
  await check();
});

test('empresa da UE em autoliquidação: o orçamento não diz «+ IVA, já pago no carregamento»', async () => {
  await db.query(`UPDATE billing_profiles SET country='DE', nif=NULL, vat_number='DE123456789', vat_status='verified', postal_code='10115', city='Berlin' WHERE user_id=$1`, [cli.id]);
  try {
    await rejectAll();
    const q = await newQuote(HOST);
    const label = `${W.cr(q.price_cents)} créditos (= ${eurPt(q.price_cents)}, sem IVA: autoliquidação)`;
    const pg = (await get(`/entrevistas/${ivId}/orcamentos/${q.id}`, cli.cookie)).body;
    assert.ok(pg.includes(label), label);
    assert.doesNotMatch(pg, /já pago no carregamento/);
    assert.ok((await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body.includes(label), 'também na lista da produção');
    assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${q.id}/aceitar`, { start_now: '1', waiver: '1' }, cli.cookie)), /Orçamento aceite/);
    const em = (await db.one(`SELECT text_body FROM emails WHERE dedupe_key=$1`, [`quote:${q.id}`])).text_body;
    assert.ok(em.includes(`Total: ${label}`), 'e no email da aceitação (suporte duradouro)');
    assert.equal((await quoteOf(q.id)).acceptance.vatRegime, 'reverse_charge');
    assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${q.id}/cancelar`, {}, cli.cookie)), /Orçamento cancelado/);
    assert.equal(Q.priceLabel(1350, null, 'not_registered'), '13,50 créditos (= 13,50 €)');
    assert.equal(Q.priceLabel(1350, null, 'domestic'), '13,50 créditos (= 13,50 € + IVA, já pago no carregamento)');
  } finally {
    await db.query(`UPDATE billing_profiles SET country='PT', nif=$2, vat_number=NULL, vat_status=NULL, postal_code='1000-001', city='Lisboa' WHERE user_id=$1`, [cli.id, nifOf('51234567')]);
  }
  await check();
});

test('gestor de entidade: o Veo sem créditos só com credenciais Google próprias da entidade; com as do portal, por orçamento', async () => {
  const { saveEntitySetting } = await import('../src/settings.ts');
  const ent = (await db.one(`SELECT id FROM entities WHERE slug='telecert-formacao'`)).id;
  await db.query(`UPDATE users SET role='entity_admin', entity_id=$2 WHERE id=$1`, [cli.id, ent]);
  const entries = async () => Number((await db.one(`SELECT count(*)::int n FROM wallet_entries e JOIN wallets w ON w.id=e.wallet_id WHERE w.user_id=$1`, [cli.id])).n);
  const videoJobs = async () => Number((await db.one(`SELECT count(*)::int n FROM jobs WHERE interview_id=$1 AND kind='render_video'`, [ivId])).n);
  try {
    // a entidade usa as credenciais do portal: o gestor anima por orçamento, com créditos, como os outros
    let pg = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
    assert.doesNotMatch(pg, /value="veo"/); assert.doesNotMatch(pg, /value="lipsync"/);
    assert.match(pg, /Animação por IA \(Google Veo 3\.1 Fast\), por orçamento/);
    const n0 = await videoJobs();
    assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'veo', lang: 'en' }, cli.cookie)), /faz-se por orçamento[\s\S]*gestor de uma entidade com credenciais Google próprias/);
    assert.equal(await videoJobs(), n0);
    await rejectAll();
    const draft = await newQuote(HOST);
    assert.equal(draft.status, 'draft');

    // com credenciais Google próprias (aqui, uma chave Gemini falsa: em modo simulado nada sai para a Google), sem orçamento
    await saveEntitySetting(db, ent, 'GEMINI_API_KEY', ('AIza' + 'Test' + 'X'.repeat(29)));
    pg = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
    assert.match(pg, /<input type="radio" name="engine" value="veo" >/); assert.doesNotMatch(pg, /value="lipsync"/);
    assert.match(pg, /Pedido pelo gestor da entidade, com as credenciais Google dela: sem orçamento nem créditos/);
    assert.ok(pg.includes(Q.ENTITY_VEO_NO_QUOTE), 'a secção do orçamento explica porque não é precisa');
    assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/orcamento`, { fala: HOST, lang: 'en' }, cli.cookie)), /credenciais Google próprias: o gestor gera o vídeo do Google Veo sem orçamento nem créditos/);
    assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${draft.id}/aceitar`, { start_now: '1', waiver: '1' }, cli.cookie)), /sem orçamento nem créditos/, 'um rascunho de antes não se aceita (pagaria duas vezes)');
    assert.equal((await quoteOf(draft.id)).status, 'draft');
    const before = await entries();
    assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'veo', lang: 'en' }, cli.cookie)), /Geração do vídeo iniciada/);
    await drain();
    const job = await lastJob();
    assert.equal(job.state, 'done', job.error);
    const ep = await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [epId]);
    const meta = (await db.one('SELECT meta FROM assets WHERE id=$1', [ep.video_asset_id])).meta;
    assert.deepEqual([meta.engine, meta.paidBy, meta.quoteId], ['veo', 'entity', null]);
    assert.ok(meta.veoSegments > 0, 'falas animadas');
    assert.equal(await entries(), before, 'nenhum crédito gasto nem cativo');
    assert.match((await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body, /pago pela entidade, no projeto Google dela \(sem créditos\)/);

    // segunda barreira: credenciais retiradas depois do pedido — o trabalho recusa (pagaria o portal)
    await rejectAll();
    assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'veo', lang: 'en' }, cli.cookie)), /Geração do vídeo iniciada/);
    await saveEntitySetting(db, ent, 'GEMINI_API_KEY', '');
    await drain();
    const j2 = await lastJob();
    assert.equal(j2.state, 'failed'); assert.match(j2.error, /faz-se por orçamento/);
    assert.equal(await entries(), before);

    // um entrevistador da mesma entidade, mesmo com as credenciais dela, continua por orçamento
    await saveEntitySetting(db, ent, 'GEMINI_API_KEY', ('AIza' + 'Test' + 'X'.repeat(29)));
    await saveEntitySetting(db, ent, 'VEO_TIER', 'lite');
    await db.query(`UPDATE users SET role='interviewer' WHERE id=$1`, [cli.id]);
    pg = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
    assert.doesNotMatch(pg, /value="veo"/);
    assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'veo', lang: 'en' }, cli.cookie)), /faz-se por orçamento/);
    // ... e o orçamento (pago com créditos) usa o nível e as credenciais Google do portal, nunca os da entidade:
    // a entidade não paga à Google o que o cliente paga em créditos
    assert.match(pg, /Animação por IA \(Google Veo 3\.1 Fast\), por orçamento/, 'o nível das Definições globais, não o Lite da entidade');
    const w = await W.walletFor(db, cli.id, ent);
    const tp = await db.one(`INSERT INTO credit_topups(wallet_id, user_id, entity_id, net_cents, vat_cents, gross_cents, vat_rate, vat_regime, customer_kind, customer_country) VALUES ($1,$2,$3,10000,2300,12300,23,'domestic','business','PT') RETURNING id`, [w.id, cli.id, ent]);
    await db.tx((t: any) => W.creditTopup(t, tp.id, { paymentIntent: `pi_ent_${tp.id}` }));
    const eq = await newQuote(['sx']);
    assert.deepEqual([eq.tier, eq.rate_id], ['fast', 'veo-fast']);
    await accept(eq);
    await drain();
    assert.equal((await quoteOf(eq.id)).status, 'settled', (await db.one('SELECT error FROM jobs WHERE id=$1', [(await quoteOf(eq.id)).job_id]))?.error ?? '');
    const scopes = await db.query(`SELECT DISTINCT cred_scope FROM veo_ops WHERE quote_id=$1 AND state<>'void'`, [eq.id]);
    assert.deepEqual(scopes.map((o: any) => o.cred_scope), ['global'], 'operações do orçamento com as credenciais do portal');
    // um orçamento aceite antes de a entidade gravar credenciais próprias também segue com as do portal
    await saveEntitySetting(db, ent, 'GEMINI_API_KEY', '');
    await rejectAll();
    const late = await accept(await newQuote(['sx']));
    await saveEntitySetting(db, ent, 'GEMINI_API_KEY', ('AIza' + 'Test' + 'X'.repeat(29)));
    await drain();
    assert.equal((await quoteOf(late.id)).status, 'settled');
    assert.deepEqual((await db.query(`SELECT DISTINCT cred_scope FROM veo_ops WHERE quote_id=$1 AND state<>'void'`, [late.id])).map((o: any) => o.cred_scope), ['global']);
  } finally {
    await saveEntitySetting(db, ent, 'VEO_TIER', '');
    await saveEntitySetting(db, ent, 'GEMINI_API_KEY', '');
    await db.query(`UPDATE users SET role='interviewer', entity_id=NULL WHERE id=$1`, [cli.id]);
  }
  await check();
});

test('operação pendente na geração: credencial retirada fica pendente e pára; recusa às credenciais de outra operação segue; às em vigor pára', async () => {
  const { VeoCredsMissing, VeoPollError } = await import('../src/talking.ts');
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]);
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  /** Chave do 1.º pedaço da 1.ª fala do entrevistador (o primeiro a ser tentado), com os clipes atuais rejeitados. */
  const firstKey = async () => { await rejectAll(); const plan = await V.veoPlan(db, iv, ep, { tier: 'fast' }); return plan.segs.find(s => s.role === 'host' && s.chunks.length)!.chunks[0].key; };
  const pendingOp = async (key: string, name: string, scope: string, project: string | null) => (await db.one(`INSERT INTO veo_ops(interview_id, chunk_key, op_name, duration_sec, state, model, usd_per_sec, cost_usd, cred_scope, project)
    VALUES ($1,$2,$3,8,'pending','veo-3.1-fast-generate-001',0.10,0.8,$4,$5) RETURNING id`, [ivId, key, name, scope, project])).id;
  const opsOf = async (key: string) => db.query(`SELECT id, state, error, cred_scope FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 ORDER BY created_at`, [ivId, key]);
  const run = async () => { assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'veo', lang: 'en' }, admin)), /Geração do vídeo iniciada/); await drain(); return lastJob(); };
  try {
    // 1. a credencial que criou a operação (já paga) foi retirada: fica pendente, o trabalho pára e nada se envia de novo
    let key = await firstKey();
    const a = await pendingOp(key, 'models/veo-3.1-fast-generate-preview/operations/p1', 'global', null);
    V.veoMock.poll = ({ opName }) => { if (opName.endsWith('/p1')) throw new VeoCredsMissing('Veo: há uma operação da Gemini API já paga por concluir, mas a chave Gemini com que foi criada (credenciais globais do portal) foi retirada de Definições (simulado): nada é pago de novo.'); };
    let j = await run();
    assert.equal(j.state, 'failed'); assert.match(j.error, /chave Gemini com que foi criada[\s\S]*nada é pago de novo/);
    assert.deepEqual((await opsOf(key)).map((o: any) => [o.id, o.state]), [[a, 'pending']], 'continua pendente e nenhum envio novo deste pedaço');

    // 2. recusa (403) às credenciais de outra operação (criada com as de uma entidade, noutro projeto): não acusa as em vigor
    //    nem pára; a operação dá-se como perdida e o pedaço gera-se de novo com as credenciais em vigor
    await db.query('DELETE FROM veo_ops WHERE id=$1', [a]);
    const b = await pendingOp(key, 'projects/outro-projeto/locations/us-central1/publishers/google/models/veo-3.1-fast-generate-001/operations/p2', '11111111-1111-1111-1111-111111111111', 'outro-projeto');
    V.veoMock.poll = ({ opName }) => { if (opName.endsWith('/p2')) throw new VeoPollError('Veo 403: Permission denied (simulado)'); };
    j = await run();
    assert.equal(j.state, 'done', j.error);
    const ops = await opsOf(key);
    assert.deepEqual([ops[0].id, ops[0].state], [b, 'failed']); assert.match(ops[0].error, /não às em vigor/);
    assert.deepEqual(ops.slice(1).map((o: any) => [o.state, o.cred_scope]), [['done', 'global']], 'gerado de novo, com o âmbito guardado');

    // 3. recusa às credenciais em vigor (a operação é delas): fica pendente e o trabalho pára a acusar as credenciais
    key = await firstKey();
    const c = await pendingOp(key, 'models/veo-3.1-fast-generate-preview/operations/p3', 'global', null);
    V.veoMock.poll = ({ opName }) => { if (opName.endsWith('/p3')) throw new VeoPollError('Veo 403: Permission denied (simulado)'); };
    j = await run();
    assert.equal(j.state, 'failed'); assert.match(j.error, /A Google recusou as credenciais do Veo/);
    assert.deepEqual((await opsOf(key)).map((o: any) => [o.id, o.state]), [[c, 'pending']]);
  } finally {
    V.veoMock.poll = null;
    await db.query(`UPDATE veo_ops SET state='expired' WHERE interview_id=$1 AND state='pending'`, [ivId]);
  }
});

test('nenhum pedaço com clipe: o vídeo não se liga ao episódio e as aprovações mantêm-se', async () => {
  await rejectAll();
  const ep0 = await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [epId]);
  // o entrevistador aprova a versão atual (com o vídeo que lá está)
  assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/aprovar`, { video: ep0.video_asset_id ?? '' }, cli.cookie)), /Versão aprovada/);
  const ap = await db.one(`SELECT id FROM approvals WHERE episode_id=$1 AND actor='interviewer' AND valid AND decision='approved'`, [epId]);
  V.veoMock.outcome = () => 'filtered'; // a Google recusa todos os clipes
  try {
    assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'veo', lang: 'en' }, admin)), /Geração do vídeo iniciada/);
    await drain();
  } finally { V.veoMock.outcome = null; }
  const j = await lastJob();
  assert.equal(j.state, 'failed');
  assert.match(j.error, /Nenhuma fala ficou animada e a Google não devolveu nenhum clipe \([^)]*recusada pelo filtro da Google[^)]*\): o vídeo não foi ligado ao episódio e as aprovações mantêm-se\./);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [epId])).video_asset_id, ep0.video_asset_id, 'o vídeo do episódio não mudou');
  assert.equal((await db.one('SELECT valid FROM approvals WHERE id=$1', [ap.id])).valid, true, 'a aprovação mantém-se');
  assert.match((await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body, /A última geração do vídeo não terminou: Nenhuma fala ficou animada/);
});
