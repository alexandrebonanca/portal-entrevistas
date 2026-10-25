import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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
const { handlers } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const { storage } = await import('../src/storage.ts');
const W = await import('../src/wallet.ts');
const V = await import('../src/veo-episode.ts');
const T = await import('../src/talking.ts');
const I = await import('../src/intro.ts');
const G = await import('../src/graphics.ts');
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
const drain = async () => { while (await J.runOne(db, handlers)) { /* */ } await flushOutbox(db); };
const PW = 'uma-palavra-passe-longa';
const nifOf = (p8: string) => { const sum = [...p8].reduce((s, d, i) => s + Number(d) * (9 - i), 0); return p8 + (sum % 11 < 2 ? 0 : 11 - (sum % 11)); };
const snap = (ms: number) => Math.round(ms / 40) * 40;

let admin = '', ivId = '', epId = '';
const cli = { cookie: '', id: '' };
const intros = () => db.query(`SELECT * FROM host_intros WHERE user_id=$1 ORDER BY created_at`, [cli.id]);
const lastIntro = async () => (await intros()).at(-1);
const introOps = (id: string) => db.query(`SELECT state, cost_usd, duration_sec, quote_id, model FROM veo_ops WHERE chunk_key=$1 ORDER BY created_at`, [`intro:${id}`]);
const ledger = async (kind: string) => Number((await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS s FROM usage_ledger WHERE kind=$1`, [kind])).s);
const gerar = (phrase: string, cookie = cli.cookie) => post(`/entrevistas/${ivId}/introducao`, { intro_phrase: phrase, acao: 'gerar' }, cookie);
const editar = async (cookie = cli.cookie) => (await get(`/entrevistas/${ivId}/editar`, cookie)).body as string;
const videoOf = async () => db.one('SELECT a.* FROM episodes e JOIN assets a ON a.id=e.video_asset_id WHERE e.id=$1', [epId]);
const lastVideoJob = () => db.one(`SELECT state, error FROM jobs WHERE kind='render_video' ORDER BY created_at DESC LIMIT 1`);
const adminVideo = async () => {
  assert.match(msg(await post(`/entrevistas/${ivId}/episodio/${epId}/video`, { engine: 'veo', lang: 'en' }, admin)), /Geração do vídeo iniciada/);
  await drain();
  const j = await lastVideoJob();
  assert.equal(j.state, 'done', j.error ?? '');
  return videoOf();
};

test('introdução: três frases fixas, genéricas e curtas; a chave muda com a fotografia, a frase, a voz, o nível e o formato', () => {
  assert.equal(I.INTRO_PHRASES.length, 3);
  for (const p of I.INTRO_PHRASES) {
    assert.ok(V.spokenCount(p.text) <= V.VEO_MAX_WORDS && V.veoDuration(p.text) <= 8, `cabe num clipe: ${p.text}`);
    assert.doesNotMatch(p.text, /\d/, 'sem datas nem números');
    // sem nomes de pessoas nem de empresas: só a primeira letra de cada frase é maiúscula
    for (const s of p.text.split(/(?<=[.!?])\s+/)) assert.doesNotMatch(s.slice(1), /[A-Z]/, s);
    assert.equal(I.introPhrase(p.id), p);
  }
  assert.equal(I.introPhrase('Hello, Inês'), null, 'nada de texto livre');
  const base = { photoSha: 'a'.repeat(64), phrase: I.INTRO_PHRASES[0].text, voice: 'female', tier: 'fast', vertical: false };
  const keys = [base, { ...base, photoSha: 'b'.repeat(64) }, { ...base, phrase: I.INTRO_PHRASES[1].text }, { ...base, voice: 'male' }, { ...base, tier: 'lite' }, { ...base, vertical: true }].map(I.introKeyOf);
  assert.equal(new Set(keys).size, keys.length, 'cada um muda a chave');
  assert.equal(I.introKeyOf({ ...base, phrase: ` ${base.phrase}  ` }), keys[0], 'a mesma frase com outros espaços é a mesma chave');
  assert.equal(J.laneOf('render_intro'), 'video', 'corre na via dos vídeos');
  // pedido ao Veo: exatamente a frase, com a voz do entrevistador nas falas dele e sem texto no ecrã
  const pr = T.veoIntroPrompt({ text: I.INTRO_PHRASES[0].text, voice: 'male' });
  assert.ok(pr.includes(`exactly these words and nothing else, with a natural adult male voice, warm and mid-pitched, clear neutral international English accent, steady unhurried pace: "${I.INTRO_PHRASES[0].text}"`));
  assert.match(pr, /podcast host welcoming the audience/); assert.match(pr, /Only this person speaks\. No captions, no text on screen, no music, no sound effects\.$/);
  // as falas do episódio pedem exatamente o mesmo de antes (as chaves dos clipes já pagos não mudam)
  assert.equal(T.veoEpisodePrompt({ role: 'guest', text: 'It "works".', voice: 'female' }),
    `The person in the image is the guest of a podcast interview, in a calm studio. They look at the camera and say, in English, exactly these words and nothing else, with a natural adult female voice, calm and mid-pitched, clear neutral international English accent, steady unhurried pace: "It 'works'." They finish speaking before the end of the clip and then stay silent with a natural, friendly expression. ${T.presenterDirection('guest')} Keep the framing, background, clothing and appearance of the image; if the hands are not visible in the image, do not add them and express through the face, head and shoulders. Do not add other people or objects. Only this person speaks. No captions, no text on screen, no music, no sound effects.`);
});

test('preparação: episódio em pré-visualização de um cliente com subscrição e o Veo autorizado pelos dois', async () => {
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
  await post(`/entrevistas/${ivId}/guardar`, { title: 'Armazenamento de energia', objective_text: 'O', host_name: 'Zé', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'en', review_policy: 'guest_preview', subtitle_langs: 'en', host_photo_rights: '1', host_ai_video: '1' }, cli.cookie);
  const jpg = (bg: string) => sharp({ create: { width: 400, height: 400, channels: 3, background: bg } }).jpeg().toBuffer();
  assert.equal((await raw(`/api/entrevistas/${ivId}/foto`, await jpg('#865'), 'image/jpeg', cli.cookie)).statusCode, 200);
  assert.match(msg(await post(`/entrevistas/${ivId}/convidar`, {}, cli.cookie)), /entrevistas\//);
  await flushOutbox(db);
  const mail = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%' ORDER BY created_at DESC LIMIT 1`, [ivId]);
  const guest = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(mail.text_body)![1]}/abrir`, {})).gs}`;
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', host_edit: '1', processing: '1', publish: '1' }, guest);
  await post('/entrevista/fotos/autorizacoes', { photo_capture: '1', cover_use: '1', publish_photo: '1', ai_video: '1' }, guest);
  assert.equal((await raw('/api/g/fotos', await jpg('#4a6'), 'image/jpeg', guest)).statusCode, 200);
  for (const q of await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [ivId])) assert.equal((await raw(`/api/g/respostas/${q.id}`, makeToneWav(2), 'audio/wav', guest)).statusCode, 200);
  await post('/entrevista/submeter', {}, guest);
  await post(`/entrevistas/${ivId}/processar`, {}, cli.cookie);
  await drain();
  await post(`/entrevistas/${ivId}/guiao/aprovar`, { reviewed: '1' }, cli.cookie);
  await post(`/entrevistas/${ivId}/gerar`, { subtitle_langs: ['en'] }, cli.cookie);
  await drain();
  const ep = await db.one(`SELECT * FROM episodes WHERE interview_id=$1 AND status='preview'`, [ivId]);
  assert.ok(ep, JSON.stringify(await db.query('SELECT kind, state, error FROM jobs WHERE interview_id=$1', [ivId])));
  epId = ep.id;
});

test('Editar: escolha da frase e «Gerar introdução» só com as autorizações; sem créditos; uma só geração em curso', async () => {
  let pg = await editar();
  assert.match(pg, /id="introducao"/); assert.match(pg, /Introdução animada \(Google Veo\), oferecida/);
  assert.match(pg, /name="intro_phrase" value="" checked/, 'por omissão, sem introdução');
  for (const p of I.INTRO_PHRASES) assert.ok(pg.includes(`value="${p.id}"`), p.id);
  assert.match(pg, /Gerações este mês: 0 de 3/); assert.doesNotMatch(pg, /Custo interno/);
  // sem a autorização do entrevistador para o Veo: nada se pede (nem a frase muda o que já está)
  await db.query('UPDATE interviews SET host_ai_video=false WHERE id=$1', [ivId]);
  assert.match(msg(await gerar('welcome')), /falta a autorização do entrevistador para o Google Veo/);
  assert.match(await editar(), /<button class="accent" name="acao" value="gerar" disabled>/);
  assert.equal((await intros()).length, 0);
  await db.query('UPDATE interviews SET host_ai_video=true WHERE id=$1', [ivId]);
  // frase sem gerar; texto livre recusado
  assert.match(msg(await post(`/entrevistas/${ivId}/introducao`, { intro_phrase: 'Hello, Inês!', acao: 'guardar' }, cli.cookie)), /Frase desconhecida/);
  assert.match(msg(await post(`/entrevistas/${ivId}/introducao`, { intro_phrase: 'welcome', acao: 'guardar' }, cli.cookie)), /Frase da introdução guardada/);
  assert.equal((await db.one('SELECT intro_phrase FROM users WHERE id=$1', [cli.id])).intro_phrase, 'welcome', 'a frase é do entrevistador');
  // gerar: pedido em fila na via dos vídeos, sem créditos nem orçamento
  assert.match(msg(await gerar('welcome')), /Introdução pedida/);
  const row = await lastIntro();
  assert.deepEqual([row.status, row.phrase, row.voice, row.tier, row.vertical, row.counts, row.interview_id], ['queued', 'welcome', 'female', 'fast', false, true, ivId]);
  const job = await db.one(`SELECT * FROM jobs WHERE kind='render_intro'`);
  assert.deepEqual([job.state, job.input.introId, job.interview_id, J.laneOf(job.kind)], ['queued', row.id, ivId, 'video']);
  assert.match(msg(await gerar('welcome')), /já está a ser gerada/, 'dois cliques não pagam duas vezes');
  assert.match(await editar(), /em fila/);
  await drain();
  const done = await lastIntro();
  assert.deepEqual([done.status, done.sent, done.billed_sec, done.error], ['ready', 1, 6, null]);
  assert.ok(Math.abs(done.cost_usd - 0.6) < 1e-9, 'custo interno: 6 s faturados a 0,10 $/s');
  const clip = await db.one('SELECT * FROM assets WHERE id=$1', [done.asset_id]);
  assert.deepEqual([clip.kind, clip.interview_id, clip.meta.text, clip.meta.checked, clip.meta.hard], ['veo_intro', ivId, I.INTRO_PHRASES[0].text, true, 0]);
  const ops = await introOps(done.id);
  assert.deepEqual(ops.map((o: any) => [o.state, o.duration_sec, o.quote_id, o.model]), [['done', 6, null, 'veo-3.1-fast-generate-preview']]);
  assert.ok(Math.abs(await ledger('veo_usd_intro') - 0.6) < 1e-9, 'registado no usage_ledger como custo interno');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM wallet_entries`)).n), 0, 'nenhum crédito tocado');
  // o entrevistador vê o estado e a pré-visualização; o custo interno só o administrador
  pg = await editar();
  assert.match(pg, /pronta/); assert.ok(pg.includes(`<video controls preload="metadata" src="/media/${done.asset_id}"`));
  assert.match(pg, /Gerações este mês: 1 de 3/); assert.doesNotMatch(pg, /Custo interno/);
  assert.equal((await get(`/media/${done.asset_id}`, cli.cookie)).statusCode, 200);
  const adm = await editar(admin);
  assert.match(adm, /Custo interno \(só o administrador o vê[^)]*\): esta introdução ~\$0\.60 \(6 s faturados, 1 envio\(s\) à Google\)/);
  assert.match(adm, /sem limite e não conta para o limite do entrevistador/);
  // a mesma chave não se gera outra vez
  assert.match(msg(await gerar('welcome')), /já está pronta/);
  // na produção: a linha da introdução; a utilização desta entrevista não leva o custo da introdução (é do portal)
  const prod = (await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body;
  assert.match(prod, /Introdução animada do entrevistador \(oferecida\): pronta: entra nos vídeos com animação do Google Veo/);
  const use = Number((await db.one(`SELECT COALESCE(sum(cost_usd),0)::float AS s FROM usage_ledger WHERE interview_id=$1 AND kind NOT IN ('veo_usd_failed','veo_usd_intro','veo_usd_intro_failed')`, [ivId])).s);
  assert.doesNotMatch(prod, /Utilização registada/, 'o cliente não vê custos internos');
  assert.ok((await get(`/entrevistas/${ivId}/producao`, admin)).body.includes(`Utilização registada (estimativa): <strong>$${use.toFixed(2)}</strong>`), 'o administrador vê-os');
});

/** Fotograma em tons de cinzento (luma) no instante t (ms). */
const gray = (ffmpeg: string, f: string, ms: number): Buffer => {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-ss', (ms / 1000).toFixed(3), '-i', f, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', 'pipe:1'], { maxBuffer: 1e8 });
  assert.equal(r.stdout.length, 1280 * 720, `fotograma em ${ms} ms`);
  return r.stdout;
};
const region = (img: Buffer, x0: number, y0: number, x1: number, y1: number) => {
  let bright = 0, sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const v = img[y * 1280 + x]; if (v > 200) bright++; sum += v; n++; }
  return { bright, mean: sum / n };
};

test('vídeo com animação: a introdução entra logo a seguir ao aviso de IA e antes do cartão de título, sem nada ir à Google', async () => {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  // primeiro sem introdução (frase retirada), depois com ela: o vídeo cresce exatamente a duração da introdução
  await db.query('UPDATE users SET intro_phrase=NULL WHERE id=$1', [cli.id]);
  const a = await adminVideo();
  assert.equal(a.meta.intro, null); assert.ok(a.meta.generatedClips > 0);
  await db.query(`UPDATE users SET intro_phrase='welcome' WHERE id=$1`, [cli.id]);
  const opsBefore = Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE chunk_key LIKE 'intro:%'`)).n);
  const b = await adminVideo();
  const intro = b.meta.intro;
  assert.ok(intro && intro.durMs > 0, JSON.stringify(b.meta.intro));
  assert.deepEqual([intro.id, intro.phrase, intro.paidBy], [(await lastIntro()).id, 'welcome', 'internal']);
  assert.equal(b.meta.generatedClips, 0, 'as falas reaproveitam os clipes');
  assert.equal(b.duration_ms - a.duration_ms, intro.durMs, 'só a introdução acrescenta tempo');
  assert.equal(intro.durMs % 40, 0, 'em fotogramas inteiros');
  assert.equal(b.meta.hostAiVideo, true, 'a introdução mostra o entrevistador gerado pelo Veo');
  assert.deepEqual(b.meta.graphics, a.meta.graphics, 'o mesmo grafismo (o rodapé do entrevistador passa para a introdução)');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE chunk_key LIKE 'intro:%'`)).n), opsBefore, 'a introdução não vai outra vez à Google');
  // fotogramas: aviso inicial (capa) → introdução (o clipe do entrevistador, a fotografia simulada) → cartão de título com texto
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path;
  const dir = mkdtempSync(join(tmpdir(), 'pe-intro-'));
  try {
    const f = join(dir, 'v.mp4');
    writeFileSync(f, await storage.get(b.storage_key));
    const D = snap(ep.technical.timing[1].startMs); // fim do aviso inicial no vídeo
    const photoLuma = region(gray(ffmpeg, f, D + intro.durMs / 2), 400, 200, 880, 420);
    assert.ok(photoLuma.bright < 50 && Math.abs(photoLuma.mean - 110) < 20, `introdução: a fotografia animada (média ${photoLuma.mean.toFixed(1)}, ${photoLuma.bright} píxeis claros)`);
    const card = region(gray(ffmpeg, f, D + intro.durMs + 2500), 200, 230, 1080, 400);
    assert.ok(card.bright > 3000, `cartão de título a seguir à introdução: ${card.bright} píxeis claros`);
    const introFrame = gray(ffmpeg, f, D + intro.durMs / 2), coverFrame = gray(ffmpeg, f, D - 600);
    let diff = 0;
    for (let y = 200; y < 420; y++) for (let x = 400; x < 880; x++) diff += Math.abs(introFrame[y * 1280 + x] - coverFrame[y * 1280 + x]);
    assert.ok(diff / (220 * 480) > 8, `antes, o aviso inicial na capa (diferença média ${(diff / (220 * 480)).toFixed(1)})`);
    // o rodapé com o nome do entrevistador entra na introdução (é a primeira vez que fala no seu plano)
    const lower = region(gray(ffmpeg, f, D + Math.min(intro.durMs - 200, 1800)), G.GFX_X + 20, G.lowerY(true) + 20, G.GFX_X + 220, G.lowerY(true) + 60);
    assert.ok(lower.bright > 200, `rodapé do entrevistador na introdução: ${lower.bright}`);
    console.log(`[introdução] ${intro.durMs} ms; fotografia ${photoLuma.mean.toFixed(1)} (${photoLuma.bright} claros), cartão ${card.bright} claros, capa ≠ introdução ${(diff / (220 * 480)).toFixed(1)}, rodapé ${lower.bright} claros`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.match((await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body, /com a introdução animada do entrevistador \(oferecida\)/);
});

test('orçamento: a introdução fica fora (oferecida); o vídeo do orçamento leva-a sem créditos', async () => {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1', [epId]);
  const w = await W.walletFor(db, cli.id, null);
  const tp = await db.one(`INSERT INTO credit_topups(wallet_id, user_id, net_cents, vat_cents, gross_cents, vat_rate, vat_regime, customer_kind, customer_country) VALUES ($1,$2,10000,2300,12300,23,'domestic','business','PT') RETURNING id`, [w.id, cli.id]);
  assert.equal(await db.tx((t: any) => W.creditTopup(t, tp.id, { paymentIntent: `pi_intro_${tp.id}` })), true);
  const falas = ep.technical.timing.filter((t: any) => t.kind !== 'disclosure').map((t: any) => t.id);
  const r = await post(`/entrevistas/${ivId}/episodio/${epId}/orcamento`, { fala: falas, lang: 'en' }, cli.cookie);
  const qid = /orcamentos\/([0-9a-f-]{36})/.exec(String(r.headers.location))?.[1];
  assert.ok(qid, msg(r));
  let q = await db.one('SELECT * FROM animation_quotes WHERE id=$1', [qid]);
  assert.deepEqual(q.selection.map((x: any) => x.segmentId).sort(), [...falas].sort(), 'só as falas: a introdução não entra no orçamento');
  assert.match(msg(await post(`/entrevistas/${ivId}/orcamentos/${qid}/aceitar`, { start_now: '1', waiver: '1' }, cli.cookie)), /Orçamento aceite/);
  await drain();
  q = await db.one('SELECT * FROM animation_quotes WHERE id=$1', [qid]);
  assert.equal(q.status, 'settled', JSON.stringify(await db.one(`SELECT error FROM jobs WHERE id=$1`, [q.job_id])));
  const v = await videoOf();
  assert.equal(v.meta.quoteId, qid); assert.ok(v.meta.intro?.durMs > 0, 'o vídeo do orçamento leva a introdução');
  assert.equal(q.charged_cents, q.settlement.segments.reduce((n: number, x: any) => n + x.cents, 0), 'cobradas só as falas');
  const wl = await db.one('SELECT * FROM wallets WHERE id=$1', [w.id]);
  assert.deepEqual([wl.available_cents, wl.reserved_cents], [10000 - q.charged_cents, 0]);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM veo_ops WHERE chunk_key LIKE 'intro:%' AND quote_id IS NOT NULL`)).n), 0, 'nenhuma operação da introdução no orçamento');
  assert.deepEqual(await W.ledgerCheck(db), []);
});

test('autorizações: sem a do entrevistador para o Veo, a introdução não entra e o vídeo que a tinha sai do ar', async () => {
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ivId]);
  assert.ok((await videoOf())?.meta.intro);
  await post(`/entrevistas/${ivId}/guardar`, { title: iv.title, objective_text: iv.objective_text, host_name: iv.host_name, guest_name: iv.guest_name, guest_email: iv.guest_email, subtitle_langs: iv.subtitle_langs, review_policy: iv.review_policy, host_photo_rights: '1' }, cli.cookie);
  assert.equal((await db.one('SELECT video_asset_id FROM episodes WHERE id=$1', [epId])).video_asset_id, null, 'o vídeo com a introdução sai do episódio');
  assert.match(await editar(), /Nesta entrevista não entra: falta a autorização do entrevistador para o Google Veo/);
  assert.match((await get(`/entrevistas/${ivId}/producao`, cli.cookie)).body, /pronta, mas não entra nesta entrevista/);
  const v = await adminVideo(); // só o convidado animado
  assert.equal(v.meta.intro, null); assert.equal(v.meta.hostAiVideo, false); assert.equal(v.meta.guestAiVideo, true);
  await db.query('UPDATE interviews SET host_ai_video=true WHERE id=$1', [ivId]);
});

test('falhas e limite: 2 tentativas verificadas palavra a palavra, custo das falhadas à parte, 3 gerações por mês (o administrador não conta)', async () => {
  // 1.ª tentativa bloqueada pelos filtros da Google, 2.ª aprovada: pronta, com a operação falhada como «normalmente não cobrada»
  V.veoMock.outcome = c => (c.segmentId === 'intro' && c.attempt === 1 ? 'filtered' : 'ok');
  try { assert.match(msg(await gerar('started')), /Introdução pedida/); await drain(); } finally { V.veoMock.outcome = null; }
  let row = await lastIntro();
  assert.deepEqual([row.status, row.phrase, row.sent], ['ready', 'started', 2]);
  assert.deepEqual((await introOps(row.id)).map((o: any) => o.state), ['failed', 'done']);
  assert.ok(Math.abs(row.cost_usd - 0.6) < 1e-9 && Math.abs(row.failed_usd - 0.6) < 1e-9, `${row.cost_usd} / ${row.failed_usd}`);
  assert.ok(Math.abs(await ledger('veo_usd_intro') - 1.2) < 1e-9, 'as duas prontas, sem a falhada');
  assert.ok(Math.abs(await ledger('veo_usd_intro_failed') - 0.6) < 1e-9);
  // a frase nunca sai dita de outra forma: ao fim de 2 tentativas, falha com o motivo e os vídeos seguem sem ela
  V.veoMock.outcome = c => (c.segmentId === 'intro' ? 'mismatch' : 'ok');
  try { assert.match(msg(await gerar('everyone')), /Introdução pedida/); await drain(); } finally { V.veoMock.outcome = null; }
  row = await lastIntro();
  assert.equal(row.status, 'failed'); assert.match(row.error, /ao fim de 2 tentativas: a voz gerada não disse a frase exatamente, palavra a palavra\. Os vídeos seguem sem introdução animada/);
  assert.deepEqual([row.sent, row.asset_id, row.fidelity.length, row.fidelity.every((f: any) => !f.ok)], [2, null, 2, true]);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assets WHERE kind='veo_intro' AND meta->>'introId'=$1`, [row.id])).n), 2, 'os clipes pagos ficam guardados');
  let pg = await editar();
  assert.match(pg, /falhou/); assert.match(pg, /não disse a frase exatamente/);
  // sem introdução pronta para a frase escolhida: o vídeo segue sem ela
  const v = await adminVideo();
  assert.equal(v.meta.intro, null);
  // 3 gerações este mês (a falhada conta: chegou a enviar à Google): a 4.ª é recusada; o botão fica desativado
  assert.match(pg, /Gerações este mês: 3 de 3 \(limite atingido/); assert.match(pg, /value="gerar" disabled/);
  await db.query(`UPDATE interviews SET question_voice='male' WHERE id=$1`, [ivId]); // outra voz = outra chave
  assert.match(msg(await gerar('welcome')), /Atingiu o limite de 3 gerações da introdução este mês/);
  assert.equal((await intros()).length, 3);
  // o administrador gera para o entrevistador sem limite e sem contar
  assert.match(msg(await gerar('welcome', admin)), /Introdução pedida/);
  await drain();
  row = await lastIntro();
  assert.deepEqual([row.status, row.voice, row.counts], ['ready', 'male', false]);
  assert.equal(await I.introsThisMonth(db, cli.id), 3);
  // autorização retirada entre tentativas: a 2.ª não é enviada e o motivo fica à vista
  V.veoMock.outcome = c => (c.segmentId === 'intro' ? 'mismatch' : 'ok');
  V.veoMock.poll = async ({ opName }) => { if (opName.startsWith('mock/')) await db.query('UPDATE interviews SET host_ai_video=false WHERE id=$1', [ivId]); };
  try { assert.match(msg(await gerar('started', admin)), /Introdução pedida/); await drain(); } finally { V.veoMock.outcome = null; V.veoMock.poll = null; }
  row = await lastIntro();
  assert.equal(row.status, 'failed'); assert.match(row.error, /falta a autorização do entrevistador para o Google Veo[\s\S]*Nada mais foi enviado à Google/);
  assert.equal((await introOps(row.id)).length, 1, 'só a 1.ª tentativa foi enviada');
  await db.query(`UPDATE interviews SET host_ai_video=true, question_voice='female' WHERE id=$1`, [ivId]);
  // o limite é por mês de calendário: um pedido do mês anterior deixa de contar
  await db.query(`UPDATE host_intros SET created_at = date_trunc('month', now()) - interval '1 day' WHERE id=$1`, [(await intros())[0].id]);
  assert.equal(await I.introsThisMonth(db, cli.id), 2);
});

test('oferta: um entrevistador sem subscrição e sem entrevistas enviadas não gera a introdução', async () => {
  const r = await post('/registar', { name: 'Sem plano', email: 'semplano@example.com', password: PW, terms: 1 });
  const ck = `sid=${cookies(r).sid}`;
  const c = await post('/entrevistas', { title: 'Rascunho' }, ck);
  const id = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  await post(`/entrevistas/${id}/guardar`, { title: 'Rascunho', host_name: 'Ana', host_photo_rights: '1', host_ai_video: '1' }, ck);
  const jpg = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#555' } }).jpeg().toBuffer();
  assert.equal((await raw(`/api/entrevistas/${id}/foto`, jpg, 'image/jpeg', ck)).statusCode, 200);
  const res = await post(`/entrevistas/${id}/introducao`, { intro_phrase: 'welcome', acao: 'gerar' }, ck);
  assert.match(msg(res), /oferecida a quem produz vídeos/);
  assert.match((await get(`/entrevistas/${id}/editar`, ck)).body, /value="gerar" disabled/);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM host_intros h JOIN users u ON u.id=h.user_id WHERE u.email='semplano@example.com'`)).n), 0);
  // outra pessoa não mexe na introdução deste entrevistador
  assert.equal((await post(`/entrevistas/${id}/introducao`, { intro_phrase: 'welcome', acao: 'guardar' }, cli.cookie)).statusCode, 404);
});
