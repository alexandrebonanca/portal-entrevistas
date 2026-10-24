import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync, crc32 } from 'node:zlib';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { runOne } = await import('../src/jobs.ts');
const { handlers, WRITTEN_FLAG, estimateCost } = await import('../src/pipeline.ts');
const { flushOutbox } = await import('../src/mail.ts');
const { makeToneWav } = await import('../src/media.ts');
const { extractAnswerText, DocError, DOC_MAX_BYTES } = await import('../src/docx.ts');
const { maxAnswerWords, wordsToMs } = await import('../src/limits.ts');
const { FAQ_SEED } = await import('../src/assistant-faq.ts');
const { fillVars } = await import('../src/assistant.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

// ---- ZIP/.docx construídos no teste ----
type ZEntry = { name: string; data: Buffer; stored?: boolean; flags?: number; usize?: number };
function zip(entries: ZEntry[]) {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let off = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const comp = e.stored ? e.data : deflateRawSync(e.data);
    const crc = crc32(e.data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(e.flags ?? 0, 6); lh.writeUInt16LE(e.stored ? 0 : 8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(e.usize ?? e.data.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(e.flags ?? 0, 8); ch.writeUInt16LE(e.stored ? 0 : 8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(e.usize ?? e.data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10); eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docXml = (paras: string[]) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${paras.map(p => `<w:p><w:pPr><w:pStyle w:val="Normal"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>${p}</w:p>`).join('')}<w:sectPr/></w:body></w:document>`;
const run = (t: string) => `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;
const docx = (paras: string[], extra: ZEntry[] = []) => zip([
  { name: '[Content_Types].xml', data: Buffer.from('<Types/>') }, { name: '_rels/.rels', data: Buffer.from(RELS) },
  { name: 'word/document.xml', data: Buffer.from(docXml(paras)) }, ...extra]);
const words = (n: number) => Array.from({ length: n }, (_, i) => `palavra${i}`).join(' ');
const code = (fn: () => unknown) => { try { fn(); return 'ok'; } catch (e) { assert.ok(e instanceof DocError, String(e)); return (e as any).code; } };

test('extração: .docx válido (parágrafos, tabulações, entidades, revisões apagadas fora, texto partido em runs)', () => {
  const b = docx([
    run('Olá, ') + run('mundo') + '<w:r><w:tab/><w:t>&lt;fim&gt; &amp; &#233;&#x20AC;</w:t></w:r>',
    '<w:del><w:r><w:delText>texto apagado</w:delText></w:r></w:del><w:ins><w:r><w:t>inserido</w:t></w:r></w:ins>',
    '', '', '<w:r><w:t>Linha</w:t><w:br/><w:t>seguinte</w:t></w:r>',
  ]);
  const r = extractAnswerText(b);
  assert.equal(r.format, 'docx');
  assert.equal(r.text, 'Olá, mundo <fim> & é€\ninserido\n\nLinha\nseguinte');
  assert.equal(r.words, 8);
  // sem compressão (stored) e com o documento principal noutro caminho, indicado em _rels/.rels
  const alt = zip([{ name: '_rels/.rels', data: Buffer.from(RELS.replace('word/document.xml', '/word/main.xml')), stored: true },
    { name: 'word/main.xml', data: Buffer.from(docXml([run('Caminho próprio')])), stored: true }]);
  assert.equal(extractAnswerText(alt).text, 'Caminho próprio');
  // caixa de texto: o Word grava-a duas vezes (mc:Choice e mc:Fallback); o texto entra uma só vez
  const box = (t: string) => `<w:txbxContent><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:txbxContent>`;
  assert.equal(extractAnswerText(docx([`<w:r><mc:AlternateContent><mc:Choice Requires="wps">${box('Na caixa')}</mc:Choice><mc:Fallback>${box('Na caixa')}</mc:Fallback></mc:AlternateContent></w:r>`])).text, 'Na caixa');
});

test('extração: vazio, grande demais, não-ZIP, ZIP sem Word, cifrado e bomba de compressão são recusados', () => {
  assert.equal(code(() => extractAnswerText(docx(['', '<w:r><w:t>   </w:t></w:r>']))), 'empty');
  assert.equal(code(() => extractAnswerText(Buffer.alloc(0))), 'empty');
  assert.equal(code(() => extractAnswerText(Buffer.alloc(DOC_MAX_BYTES + 1, 0x61))), 'tooBig');
  assert.equal(code(() => extractAnswerText(Buffer.from('%PDF-1.7\n' + 'x'.repeat(100)))), 'format');
  assert.equal(code(() => extractAnswerText(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]))), 'format', '.doc antigo');
  assert.equal(code(() => extractAnswerText(makeToneWav(1))), 'format', 'áudio não é texto');
  assert.equal(code(() => extractAnswerText(Buffer.from('PK\x03\x04 isto não é um zip a sério'))), 'format');
  assert.equal(code(() => extractAnswerText(zip([{ name: 'xl/workbook.xml', data: Buffer.from('<x/>') }]))), 'format', 'ZIP sem documento Word');
  assert.equal(code(() => extractAnswerText(zip([{ name: 'word/document.xml', data: Buffer.from(docXml([run('x')])), flags: 1 }]))), 'format', 'cifrado');
  // bomba: 20 MB de XML comprimidos em poucos KB; recusada pelo tamanho declarado e, se este mentir, pelo teto do zlib
  const huge = Buffer.from(docXml([run('a'.repeat(20 * 1024 * 1024))]));
  const bomb = zip([{ name: 'word/document.xml', data: huge }]);
  assert.ok(bomb.length < DOC_MAX_BYTES, `bomba pequena (${bomb.length} B)`);
  assert.equal(code(() => extractAnswerText(bomb)), 'tooBig');
  assert.equal(code(() => extractAnswerText(zip([{ name: 'word/document.xml', data: huge, usize: 1000 }]))), 'tooBig', 'tamanho declarado falso');
  // desvio do cabeçalho local fora do ficheiro
  const bad = zip([{ name: 'word/document.xml', data: Buffer.from(docXml([run('x')])) }]); const cdOff = bad.readUInt32LE(bad.length - 6); bad.writeUInt32LE(0x7fffffff, cdOff + 42);
  assert.equal(code(() => extractAnswerText(bad)), 'format');
  // XML malformado feito para retrocesso quadrático nas expressões: tem de acabar depressa
  const t0 = Date.now();
  const evil = Buffer.from(`<w:document ${W}>` + '<w:t <w:br <w:tab '.repeat(300_000));
  assert.equal(code(() => extractAnswerText(zip([{ name: 'word/document.xml', data: evil }]))), 'empty');
  const evilRels = Buffer.from('<Relationship Type="/officeDocument" '.repeat(1500));
  assert.equal(code(() => extractAnswerText(zip([{ name: '_rels/.rels', data: evilRels }, { name: 'word/document.xml', data: Buffer.from(docXml([run('ok')])) }]))), 'ok');
  assert.ok(Date.now() - t0 < 3000, `linear (${Date.now() - t0} ms)`);
});

test('extração: .txt em UTF-8, Windows-1252 e UTF-16; binário recusado', () => {
  assert.deepEqual(extractAnswerText(Buffer.from('﻿Uma resposta\r\n\r\n\r\n  em   texto. ')), { text: 'Uma resposta\n\nem texto.', words: 4, format: 'txt' });
  assert.equal(extractAnswerText(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x80])).text, 'Café €');
  assert.equal(extractAnswerText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Olá UTF-16', 'utf16le')])).text, 'Olá UTF-16');
  assert.equal(code(() => extractAnswerText(Buffer.from('abc\u0000def ghi jkl mno pqr'))), 'format');
});

// ---- rota e fluxo completo ----
const cookies = (r: any) => Object.fromEntries((r.cookies as any[]).map(c => [c.name, c.value]));
const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v.map(x => [k, x]) : [[k, String(v)]]))).toString();
const post = (url: string, body: any, cookie = '') => app.inject({ method: 'POST', url, payload: form(body), headers: { 'content-type': 'application/x-www-form-urlencoded', cookie } });
const get = (url: string, cookie = '') => app.inject({ method: 'GET', url, headers: { cookie } });
const sendDoc = (qid: string, data: Buffer, cookie: string, extra: any = {}) =>
  app.inject({ method: 'POST', url: `/api/g/respostas/${qid}/documento`, payload: data, headers: { 'content-type': 'application/octet-stream', cookie, ...extra } });
const drain = async () => { while (await runOne(db, handlers)) { /* */ } await flushOutbox(db); };

let owner = '', guest = '', ivId = '', qs: string[] = [];
const ANSWER = 'A fibra chegou às aldeias mais tarde do que às cidades. O maior desafio foi a obra civil.';

test('preparar entrevista e sessão do convidado (em português)', async () => {
  owner = `sid=${cookies(await post('/registar', { name: 'Ana', email: 'ana@example.com', password: 'uma-palavra-passe-longa', terms: '1' })).sid}`;
  const c = await post('/entrevistas', { title: 'Fibra' }, owner);
  ivId = /entrevistas\/([0-9a-f-]{36})/.exec(c.headers.location as string)![1];
  for (const text of ['Qual foi o maior desafio?', 'Que conselho dá?', 'E o futuro?']) await post(`/entrevistas/${ivId}/perguntas`, { text }, owner);
  await post(`/entrevistas/${ivId}/guardar`, { title: 'Fibra', objective_text: 'Mercado', host_name: 'Ana', guest_name: 'Rui', guest_email: 'rui@example.com', interaction_lang: 'pt-PT', answer_lang: 'pt', review_policy: 'guest_preview', subtitle_langs: 'en' }, owner);
  assert.match((await post(`/entrevistas/${ivId}/convidar`, {}, owner)).headers.location as string, /ok=/);
  await flushOutbox(db);
  const m = await db.one(`SELECT text_body FROM emails WHERE interview_id=$1 AND dedupe_key LIKE 'invite:%'`, [ivId]);
  guest = `gs=${cookies(await post(`/i/${/\/i\/([A-Za-z0-9_-]{40,})/.exec(m.text_body)![1]}/abrir`, {})).gs}`;
  qs = (await db.query('SELECT id FROM questions WHERE interview_id=$1 ORDER BY position', [ivId])).map((r: any) => r.id);
});

test('página da pergunta: opção Word logo abaixo da do áudio, na língua do convidado', async () => {
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, guest);
  const p = (await get('/entrevista/p/1', guest)).body;
  const iAudio = p.indexOf('Carregar um áudio já gravado'), iDoc = p.indexOf('Carregar um ficheiro Word como resposta à questão');
  assert.ok(iAudio > 0 && iDoc > iAudio, 'Word por baixo do áudio');
  assert.match(p, new RegExp(`id="docIn" data-upload="/api/g/respostas/${qs[0]}/documento" accept="\\.docx,\\.txt`));
  assert.match(p, new RegExp(`até 2 MB e ${maxAnswerWords()} palavras`));
  assert.match(p, /<div id="textReview" hidden/);
});

test('upload do Word: autorização, formatos, vazio, tamanho, palavras e tempo total', async () => {
  // participação retirada (último registo recusado): não entra
  await db.query(`INSERT INTO consents(interview_id, purpose, granted, text_version, text_snapshot) VALUES ($1,'participation',false,'t','t')`, [ivId]);
  assert.equal((await sendDoc(qs[0], docx([run(ANSWER)]), guest)).statusCode, 403);
  await post('/entrevista/consentimentos', { participation: '1', adult: '1', processing: '1', publish: '1' }, guest);
  assert.equal((await sendDoc(qs[0], docx([run(ANSWER)]), '')).statusCode, 401, 'sem sessão');

  const f = await sendDoc(qs[0], Buffer.from('%PDF-1.4 não é Word nem texto'), guest);
  assert.equal(f.statusCode, 415); assert.equal(f.json().error, 'format'); assert.match(f.json().message, /\.docx/);
  const e = await sendDoc(qs[0], docx(['']), guest);
  assert.equal(e.statusCode, 422); assert.equal(e.json().error, 'empty'); assert.match(e.json().message, /não tem texto/);
  const big = await sendDoc(qs[0], Buffer.alloc(DOC_MAX_BYTES + 4096, 0x61), guest);
  assert.equal(big.statusCode, 413, 'acima do teto da rota');
  const long = await sendDoc(qs[0], docx([run(words(maxAnswerWords() + 1))]), guest);
  assert.equal(long.statusCode, 422); assert.equal(long.json().error, 'tooLong');
  assert.match(long.json().message, new RegExp(`${maxAnswerWords() + 1} palavras; cada resposta pode ter até ${maxAnswerWords()}`));
  // tempo total: 60 s ≈ 150 palavras; um texto de 200 palavras não cabe
  await db.query('UPDATE interviews SET answer_limit_sec=60 WHERE id=$1', [ivId]);
  const over = await sendDoc(qs[0], docx([run(words(200))]), guest);
  assert.equal(over.statusCode, 422); assert.equal(over.json().error, 'overTotal');
  assert.match(over.json().message, /cabem cerca de 150 palavras/);
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM assets WHERE interview_id=$1 AND kind='answer_text' AND deleted_at IS NULL`, [ivId])).n), 0, 'nada guardado nas recusas');
  await db.query('UPDATE interviews SET answer_limit_sec=NULL WHERE id=$1', [ivId]);
});

test('upload do Word: guarda só o texto, conta como respondida, idempotente e com transcrição «document»', async () => {
  const b = docx([run(ANSWER)]);
  const r = await sendDoc(qs[0], b, guest, { 'x-upload-id': 'doc-1' });
  assert.equal(r.statusCode, 200, r.body);
  const j = r.json();
  assert.equal(j.text, ANSWER); assert.equal(j.words, 18); assert.equal(j.durationMs, wordsToMs(18));
  const dup = (await sendDoc(qs[0], b, guest, { 'x-upload-id': 'doc-1' })).json();
  assert.equal(dup.duplicate, true); assert.equal(dup.text, ANSWER);
  const a = await db.one(`SELECT a.* FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets a ON a.id=t.asset_id WHERE an.question_id=$1`, [qs[0]]);
  assert.equal(a.kind, 'answer_text'); assert.equal(a.duration_ms, wordsToMs(18)); assert.equal(a.meta.via, 'document');
  const { storage } = await import('../src/storage.ts');
  assert.equal((await storage.get(a.storage_key)).toString('utf8'), ANSWER, 'só o texto (o .docx não é guardado)');
  assert.equal(Number((await db.one(`SELECT count(*)::int n FROM answer_takes t JOIN answers an ON an.id=t.answer_id WHERE an.question_id=$1`, [qs[0]])).n), 1);
  const tr = await db.one(`SELECT * FROM transcripts WHERE source_kind='answer_take' AND source_id=$1`, [j.takeId]);
  assert.deepEqual([tr.text, tr.origin, tr.revision, tr.language], [ANSWER, 'document', 1, 'pt']);
  assert.equal((await db.one('SELECT status FROM answers WHERE question_id=$1', [qs[0]])).status, 'answered');
  // a página mostra o texto guardado para confirmar (e não o leitor de áudio)
  const p = (await get('/entrevista/p/1', guest)).body;
  assert.match(p, /<div id="textReview" style="width:100%">[\s\S]*A fibra chegou às aldeias/);
  assert.match(p, /<div id="review" hidden/);
  assert.match(p, /<a id="next"[^>]*aria-disabled="false"/);
  // .txt também serve; uma gravação depois substitui o texto (e o texto substitui uma gravação)
  const t = await sendDoc(qs[1], Buffer.from('Resposta em texto simples.'), guest);
  assert.equal(t.statusCode, 200); assert.equal(t.json().text, 'Resposta em texto simples.');
  const rec = await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[1]}`, payload: makeToneWav(2), headers: { 'content-type': 'audio/wav', cookie: guest } });
  assert.equal(rec.statusCode, 200);
  assert.match((await get('/entrevista/p/2', guest)).body, /<div id="textReview" hidden/);
  // perguntas 3: gravação de voz
  assert.equal((await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[2]}`, payload: makeToneWav(2), headers: { 'content-type': 'audio/wav', cookie: guest } })).statusCode, 200);
  // tempo total conta a leitura estimada
  const { answeredMs } = await import('../src/limits.ts');
  assert.ok((await answeredMs(db, ivId)) >= wordsToMs(18) + 3000);
  // o convidado não descarrega o ficheiro de texto pela rota de media (só vê o texto nas páginas)
  assert.equal((await get(`/api/g/media/${a.id}`, guest)).statusCode, 404);
});

test('revisão do convidado e páginas do entrevistador mostram o texto marcado como resposta escrita', async () => {
  const rv = (await get('/entrevista/rever', guest)).body;
  assert.match(rv, /Resposta escrita \(ficheiro\)<\/span><blockquote class="written">A fibra chegou/);
  assert.equal((rv.match(/<audio /g) ?? []).length, 2, 'as outras duas continuam com leitor');
  const det = (await get(`/entrevistas/${ivId}`, owner)).body;
  assert.match(det, /resposta escrita \(ficheiro\)<\/span><blockquote class="written">A fibra chegou/);
  // texto do convidado escapado nas páginas
  await sendDoc(qs[1], Buffer.from('<script>alert(1)</script> resposta'), guest);
  assert.doesNotMatch((await get(`/entrevistas/${ivId}`, owner)).body, /<script>alert/);
  assert.match((await get('/entrevista/rever', guest)).body, /&lt;script&gt;alert\(1\)&lt;\/script&gt; resposta/);
  // volta a gravação na pergunta 2
  assert.equal((await app.inject({ method: 'POST', url: `/api/g/respostas/${qs[1]}`, payload: makeToneWav(2), headers: { 'content-type': 'audio/wav', cookie: guest } })).statusCode, 200);
});

test('fluxo completo com uma resposta Word: submeter, processar (AI_MOCK), guião assinalado, episódio gerado', async () => {
  assert.match((await post('/entrevista/submeter', {}, guest)).headers.location as string, /obrigado/);
  const snap = (await db.one('SELECT snapshot FROM submissions WHERE interview_id=$1', [ivId])).snapshot;
  assert.equal(snap.answers[0].via, 'document'); assert.equal(snap.answers[1].via, undefined);
  // depois de submeter, nada entra
  assert.equal((await sendDoc(qs[0], docx([run('tarde')]), guest)).statusCode, 409);

  const est = await estimateCost(db, ivId, ['en']);
  const audioMs = Number((await db.one(`SELECT sum(a.duration_ms)::bigint ms FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets a ON a.id=t.asset_id WHERE an.interview_id=$1 AND a.kind='answer_audio'`, [ivId])).ms);
  const { config } = await import('../src/config.ts');
  assert.ok(Math.abs(est.parts.transcription - (audioMs / 60000) * config.prices.transcribePerMin) < 1e-9, 'a transcrição estimada é só a das gravações');
  assert.ok(Math.abs(est.minutes - (audioMs + wordsToMs(18)) / 60000) < 1e-9, 'a leitura estimada conta para a voz e o texto');
  const prod = (await get(`/entrevistas/${ivId}/producao`, owner)).body;
  assert.match(prod, /resposta escrita \(ficheiro\)<\/span><blockquote class="written">A fibra chegou/);

  await post(`/entrevistas/${ivId}/processar`, {}, owner);
  await drain();
  assert.equal((await db.one('SELECT production_status s FROM interviews WHERE id=$1', [ivId])).s, 'editorial_review');
  const usage = await db.query(`SELECT quantity FROM usage_ledger WHERE interview_id=$1 AND kind='transcription_min'`, [ivId]);
  assert.equal(usage.length, 2, 'só as duas gravações pagam transcrição');
  const sc = await db.one(`SELECT * FROM scripts WHERE interview_id=$1 AND status='draft'`, [ivId]);
  const seg = sc.segments.find((s: any) => s.transformationType === 'translated_answer' && s.sourceQuestionId === qs[0]);
  assert.equal(seg.textEnglish, `(EN) ${ANSWER}`, 'o texto do ficheiro é a resposta, sem transcrição');
  assert.deepEqual(sc.review_flags.filter((f: any) => f.reason === WRITTEN_FLAG).map((f: any) => f.segmentId), [seg.id], 'só a fala escrita fica assinalada');
  const page = (await get(`/entrevistas/${ivId}/producao`, owner)).body;
  assert.match(page, /r1 · document/);
  assert.ok(page.includes('Resposta escrita: o convidado carregou um ficheiro'));

  await post(`/entrevistas/${ivId}/guiao/aprovar`, { reviewed: '1' }, owner);
  assert.match((await post(`/entrevistas/${ivId}/gerar`, { subtitle_langs: ['en'] }, owner)).headers.location as string, /ok=/);
  await drain();
  const ep = await db.one('SELECT * FROM episodes WHERE interview_id=$1', [ivId]);
  assert.ok(ep, 'episódio criado');
  assert.ok(ep.technical.timing.some((t: any) => t.id === seg.id && t.role === 'guest' && t.durationMs > 0), 'a resposta escrita é lida pela voz do convidado');
  assert.ok(ep.subtitles.en.some((c: any) => /fibra chegou/.test(c.text)));
});

test('FAQ: entrada do Word para o convidado e para o entrevistador, em pt e en, com o teto de palavras em vigor', () => {
  const g = FAQ_SEED.find(e => e.key === 'convidado-carregar-word')!, i = FAQ_SEED.find(e => e.key === 'respostas-escritas')!;
  assert.equal(g.audience, 'guest'); assert.equal(i.audience, 'interviewer');
  assert.match(g.pt[1], /«Carregar um ficheiro Word como resposta à questão»/);
  assert.match(g.en[1], /«Upload a Word file as your answer»/);
  assert.match(fillVars(g.pt[1]), new RegExp(`até ${maxAnswerWords()} palavras`));
  assert.match(fillVars(i.en[1]), new RegExp(`up to ${maxAnswerWords()} words`));
});
