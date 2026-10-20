import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cuesFromWords, toVtt, toSrt, fixOverlaps, checkCues } from '../src/subtitles.ts';
import { validateScript } from '../src/ai/openai.ts';
import { wrapTitle } from '../src/cover.ts';
import { sniff } from '../src/media.ts';

test('cues usam tempos medidos e não se sobrepõem', () => {
  const words = [{ word: 'Hello', start: 0, end: 0.4 }, { word: 'world.', start: 0.5, end: 1 }, { word: 'Second', start: 1.2, end: 1.6 }, { word: 'sentence', start: 1.7, end: 2.2 }];
  const cues = cuesFromWords(words, { id: 's', role: 'guest', text: 'x', startMs: 10_000, durationMs: 2500 }, 'en');
  assert.equal(cues[0].startMs, 10_000);
  assert.deepEqual(checkCues(fixOverlaps(cues), 20_000), []);
  assert.match(toVtt(cues), /^WEBVTT\n\n1\n00:00:10\.000 --> /);
  assert.match(toSrt(cues), /00:00:10,000 --> /);
});
test('sem palavras: uma cue com o intervalo exato do segmento', () => {
  const c = cuesFromWords([], { id: 's', role: 'host', text: 'Hi', startMs: 500, durationMs: 1500 }, 'en');
  assert.equal(c.length, 1); assert.equal(c[0].endMs, 2000);
});
test('validação do guião: editorial nunca é do convidado; falas sem fonte são sinalizadas', () => {
  const r = validateScript({ titleEnglish: 'T', segments: [
    { id: 'a', speakerRole: 'guest', textEnglish: 'Intro fake', transformationType: 'editorial_intro' },
    { id: 'b', speakerRole: 'guest', textEnglish: 'Resposta', sourceQuestionId: 'nope', transformationType: 'translated_answer' },
    { id: 'c', speakerRole: 'host', textEnglish: 'x', transformationType: 'invented_type' },
  ] }, { title: 'T', objective: '', items: [{ questionId: 'q1', question: 'Q', status: 'answered', answer: 'A' }] });
  assert.equal(r.segments[0].speakerRole, 'host');
  assert.ok(r.blockingIssues.length >= 2);
  assert.ok(r.reviewFlags.some(f => f.segmentId === 'b'));
  assert.equal(r.segments.length, 2);
});
test('título da capa quebra em linhas e limita', () => {
  const l = wrapTitle('A very long interview title about fibre optics in the Iberian market and beyond', 18, 4);
  assert.ok(l.length <= 4 && l.every(x => x.length <= 18));
});
test('WebM em fluxo (como o MediaRecorder do Chrome/Android, sem duração no cabeçalho) é aceite e medido', async () => {
  const { spawnSync } = await import('node:child_process');
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path;
  const r = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-c:a', 'libopus', '-f', 'webm', '-live', '1', 'pipe:1'], { maxBuffer: 1e8 });
  assert.equal(r.status, 0);
  const { probeAudio } = await import('../src/media.ts');
  const p = await probeAudio(r.stdout, 'webm');
  assert.equal(p.ok, true);
  assert.ok(p.durationMs > 2800 && p.durationMs < 3300, String(p.durationMs));
  assert.equal(p.silent, false);
});
test('sniff identifica pelo conteúdo', () => {
  assert.equal(sniff(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(20)]))?.mime, 'audio/webm');
  assert.equal(sniff(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A '), Buffer.alloc(8)]))?.mime, 'audio/mp4');
  assert.equal(sniff(Buffer.from('<html>aaaaaaaaaaaaaaaaaaaaaaa')), null);
});

test('plano do vídeo: capa no aviso, estúdio na apresentação, só quem fala a partir da 1.ª pergunta, capa no agradecimento', async () => {
  const { planShots } = await import('../src/video.ts');
  const segs = [
    { id: 'disclosure', role: 'host', kind: 'disclosure', startMs: 0, durationMs: 4000 },
    { id: 's0', role: 'host', kind: 'editorial_intro', startMs: 4800, durationMs: 3000 },
    { id: 'q0', role: 'host', kind: 'translated_question', startMs: 8000, durationMs: 3000 },
    { id: 'a0', role: 'guest', kind: 'translated_answer', startMs: 11500, durationMs: 6000 },
    { id: 'q1', role: 'host', kind: 'translated_question', startMs: 18000, durationMs: 3000 },
    { id: 'a1', role: 'guest', kind: 'translated_answer', startMs: 21500, durationMs: 5000 },
    { id: 'outro', role: 'host', kind: 'editorial_outro', startMs: 27000, durationMs: 4000 },
  ] as any;
  const cues = [{ id: 'c0', startMs: 11500, endMs: 14000, speakerRole: 'guest', text: 'Olá', language: 'pt-PT', revision: 1 }] as any;
  const shots = planShots(segs, 31000, cues);
  const at = (ms: number) => shots.find(s => ms >= s.startMs && ms < s.endMs)!;
  assert.equal(at(1000).scene, 'cover'); assert.equal(at(6000).scene, 'studio');
  assert.equal(at(9000).scene, 'host', 'na 1.ª pergunta só o entrevistador');
  assert.ok(!shots.some(s => s.scene === 'studio' && s.startMs >= 8000), 'o estúdio não volta a aparecer');
  assert.equal(at(12000).scene, 'guest'); assert.equal(at(12000).text, 'Olá');
  assert.equal(at(15000).text, '');
  assert.equal(at(19000).scene, 'host');
  assert.equal(at(28000).scene, 'cover');
  assert.equal(shots[0].startMs, 0); assert.equal(shots[shots.length - 1].endMs, 31000);
  for (let i = 1; i < shots.length; i++) assert.equal(shots[i].startMs, shots[i - 1].endMs, 'sem buracos');
});
test('vozes do episódio por género escolhido, sempre distintas entre papéis', async () => {
  const { episodeVoice } = await import('../src/ai/openai.ts');
  for (const h of ['male', 'female']) for (const g of ['male', 'female']) assert.notEqual(episodeVoice('host', h), episodeVoice('guest', g));
  assert.equal(episodeVoice('host', 'male'), 'ash');
});

test('partes do vídeo: animadas substituem os fotogramas fixos do seu intervalo', async () => {
  const { splitParts, shotsWithin } = await import('../src/video.ts');
  const parts = splitParts([{ startMs: 5000, endMs: 9000 }, { startMs: 12000, endMs: 15000 }], 20000);
  assert.deepEqual(parts.map(p => [p.kind, p.startMs, p.endMs]), [['still', 0, 5000], ['anim', 5000, 9000], ['still', 9000, 12000], ['anim', 12000, 15000], ['still', 15000, 20000]]);
  const sh = shotsWithin([{ startMs: 0, endMs: 6000, scene: 'cover', text: '' }, { startMs: 6000, endMs: 13000, scene: 'host', text: 'x' }] as any, 9000, 12000);
  assert.deepEqual(sh.map(s => [s.startMs, s.endMs]), [[9000, 12000]]);
});
test('composição com parte animada produz MP4 com a duração do áudio', async () => {
  const { spawnSync } = await import('node:child_process');
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path, ffprobe = (await import('@ffprobe-installer/ffprobe')).default.path;
  const sharp = (await import('sharp')).default;
  const { encodeComposite, stillClip } = await import('../src/video.ts');
  const img = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#224' } }).jpeg().toBuffer();
  const face = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#a76' } }).jpeg().toBuffer();
  const audio = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=8', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1e8 }).stdout;
  const clip = await stillClip(ffmpeg, face, 2500); // clipe mais curto do que a parte: o último fotograma mantém-se
  const mp4 = await encodeComposite(ffmpeg, [
    { kind: 'still', startMs: 0, endMs: 3000, shots: [{ startMs: 0, endMs: 3000, scene: 'cover', text: 'Hello' }] },
    { kind: 'anim', startMs: 3000, endMs: 6000, base: img, clip, cues: [{ startMs: 0, endMs: 1500, text: 'Olá' }, { startMs: 1500, endMs: 3000, text: 'Mundo' }] },
    { kind: 'still', startMs: 6000, endMs: 8000, shots: [{ startMs: 6000, endMs: 8000, scene: 'host', text: '' }] },
  ] as any, async () => img, audio);
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'pe-')), 'v.mp4'); writeFileSync(f, mp4);
  const d = parseFloat(spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).stdout.toString());
  assert.ok(Math.abs(d - 8) < 0.3, `duração do vídeo ${d}`);
});

test('vídeo Veo: dezenas de partes animadas mantêm o número exato de fotogramas e o som alinhado', async () => {
  const { spawnSync } = await import('node:child_process');
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path, ffprobe = (await import('@ffprobe-installer/ffprobe')).default.path;
  const sharp = (await import('sharp')).default;
  const { encodeComposite, buildAudioTrack, mockTalkingClip } = await import('../src/video.ts');
  const img = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#224' } }).jpeg().toBuffer();
  const clip = await mockTalkingClip(ffmpeg, img, 4000, false);
  const load = async () => clip;
  const parts: any[] = [], audio: any[] = [];
  let t = 0;
  const durs = [2000, 400, 2400, 1960, 3040, 1200, 2000, 400, 2400, 1960, 3040, 1200, 2000, 2400];
  for (const [k, d] of durs.entries()) {
    if (k % 5 === 4) { parts.push({ kind: 'still', startMs: t, endMs: t + d, shots: [{ startMs: t, endMs: t + d, scene: 'cover', text: '' }] }); audio.push({ durMs: d }); }
    else { parts.push({ kind: 'anim', startMs: t, endMs: t + d, base: img, clip: load, clipOffsetMs: 280, cues: [{ startMs: 0, endMs: Math.round(d / 80) * 40, text: 'A' }, { startMs: Math.round(d / 80) * 40, endMs: d, text: 'B' }] }); audio.push({ durMs: d, src: load, ext: 'mp4', offsetMs: 280 }); }
    t += d;
  }
  const track = await buildAudioTrack(ffmpeg, audio);
  const mp4 = await encodeComposite(ffmpeg, parts, async () => img, track, undefined, 'm4a');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'pe-')), 'v.mp4'); writeFileSync(f, mp4);
  const frames = Number(spawnSync(ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', f]).stdout.toString().trim());
  assert.equal(frames, t / 40, `fotogramas ${frames} face a ${t / 40}`);
  const a = parseFloat(spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).stdout.toString());
  assert.ok(Math.abs(a - t / 1000) < 0.08, `som ${a} face a ${t / 1000}`);
});

test('vídeo: pedaços de 1–2 fotogramas no início e no fim de uma parte animada não deslocam os tempos', async () => {
  const { spawnSync } = await import('node:child_process');
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path, ffprobe = (await import('@ffprobe-installer/ffprobe')).default.path;
  const sharp = (await import('sharp')).default;
  const { encodeComposite, buildAudioTrack, mockTalkingClip } = await import('../src/video.ts');
  const img = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#335' } }).jpeg().toBuffer();
  const clip = await mockTalkingClip(ffmpeg, img, 6000, true);
  const load = async () => clip;
  // parte 1: pedaço de 1 fotograma no início; parte 2: pedaço de 2 fotogramas no fim; parte 3: 1 + meio + 2
  const parts: any[] = [
    { kind: 'still', startMs: 0, endMs: 1200, shots: [{ startMs: 0, endMs: 1200, scene: 'cover', text: '' }] },
    { kind: 'anim', startMs: 1200, endMs: 5840, base: img, clip: load, clipOffsetMs: 520, cues: [{ startMs: 40, endMs: 4640, text: 'A' }] },
    { kind: 'anim', startMs: 5840, endMs: 10560, base: img, clip: load, clipOffsetMs: 0, cues: [{ startMs: 0, endMs: 4640, text: 'B' }] },
    { kind: 'anim', startMs: 10560, endMs: 15200, base: img, clip: load, clipOffsetMs: 280, cues: [{ startMs: 40, endMs: 4560, text: 'C' }] },
  ];
  const total = 15200;
  const track = await buildAudioTrack(ffmpeg, [{ durMs: 1200 }, { durMs: 4640, src: load, ext: 'mp4', offsetMs: 520 }, { durMs: 4720, src: load, ext: 'mp4' }, { durMs: 4640, src: load, ext: 'mp4', offsetMs: 280 }]);
  const mp4 = await encodeComposite(ffmpeg, parts, async () => img, track, undefined, 'm4a');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'pe-')), 'v.mp4'); writeFileSync(f, mp4);
  const pts = spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', f], { maxBuffer: 1e8 }).stdout.toString().trim().split(/\s+/).filter(Boolean).map(Number).sort((x, y) => x - y);
  assert.equal(pts.length, total / 40, `fotogramas ${pts.length}`);
  for (let i = 1; i < pts.length; i++) assert.ok(Math.abs(pts[i] - pts[i - 1] - 0.04) < 0.002, `passo irregular em ${i}: ${pts[i - 1]} → ${pts[i]}`);
  const vdur = parseFloat(spawnSync(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).stdout.toString());
  assert.ok(Math.abs(vdur - total / 1000) < 0.045, `duração da imagem ${vdur}`);
});

test('Veo: falhas da Google classificadas (procura elevada é passageira; filtros contam)', async () => {
  const { veoAwait, veoSubmit, VeoBusy, VeoFiltered, VeoOpError, VeoPollError, isKeyRejected } = await import('../src/talking.ts');
  const { PermanentError } = await import('../src/jobs.ts');
  const real = globalThis.fetch;
  const reply = (body: any, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as any;
  try {
    globalThis.fetch = reply({ name: 'op', done: true, error: { code: 8, message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } });
    await assert.rejects(veoAwait('op', 4, undefined, 60_000, 1), (e: any) => e instanceof VeoBusy && !(e instanceof PermanentError));
    globalThis.fetch = reply({ name: 'op', done: true, error: { code: 14, message: 'The service is currently unavailable.' } });
    await assert.rejects(veoAwait('op', 4, undefined, 60_000, 1), (e: any) => e instanceof VeoBusy);
    globalThis.fetch = reply({ name: 'op', done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['We encountered an issue with the audio for your prompt'] } } });
    await assert.rejects(veoAwait('op', 4, undefined, 60_000, 1), (e: any) => e instanceof VeoFiltered && e instanceof VeoOpError && e instanceof PermanentError);
    globalThis.fetch = reply({ name: 'op', done: true, error: { code: 3, message: 'Invalid argument' } });
    await assert.rejects(veoAwait('op', 4, undefined, 60_000, 1), (e: any) => e instanceof VeoOpError && !(e instanceof VeoFiltered));
    globalThis.fetch = reply({ name: 'op', done: true, error: { code: 13, message: 'Internal error encountered.' } });
    await assert.rejects(veoAwait('op', 4, undefined, 60_000, 1), (e: any) => e instanceof VeoOpError && !(e instanceof VeoBusy), 'erro interno conta para o limite');
    // a CONSULTA recusada não diz nada sobre a operação: não é «falhada na Google»
    globalThis.fetch = reply({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400);
    await assert.rejects(veoAwait('op', 4, undefined, 60_000, 1), (e: any) => e instanceof VeoPollError && !(e instanceof VeoOpError) && isKeyRejected(e.message));
    globalThis.fetch = reply({ error: { message: 'Requested entity was not found.' } }, 404);
    await assert.rejects(veoAwait('op', 4, undefined, 60_000, 1), (e: any) => e instanceof VeoPollError && !isKeyRejected(e.message));
    globalThis.fetch = reply({ error: { message: 'backend unavailable' } }, 503);
    await assert.rejects(veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 4 }), (e: any) => e instanceof VeoBusy, 'pedido recusado por indisponibilidade: passageiro');
  } finally { globalThis.fetch = real; }
});

test('Veo: depois de um 429, nada volta a ser enviado sem confirmar a autorização', async () => {
  const { veoSubmit, VeoCancelled } = await import('../src/talking.ts');
  const real = globalThis.fetch;
  let posts = 0, allowed = true;
  globalThis.fetch = (async () => { posts++; allowed = false; return new Response(JSON.stringify({ error: { message: 'rate limit' } }), { status: 429 }); }) as any;
  try {
    await assert.rejects(veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 4, canSend: async () => allowed, waitMs: () => 1 }), (e: any) => e instanceof VeoCancelled);
    assert.equal(posts, 1, 'a autorização foi retirada durante a espera: não há segundo envio');
    posts = 0; allowed = true;
    await assert.rejects(veoSubmit({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 4, canSend: async () => false, waitMs: () => 1 }), (e: any) => e instanceof VeoCancelled);
    assert.equal(posts, 0, 'sem autorização, nem o primeiro envio');
  } finally { globalThis.fetch = real; }
});

test('vídeo Veo: som dos clipes (com corte no início) e imagem ficam com a mesma duração', async () => {
  const { spawnSync } = await import('node:child_process');
  const ffmpeg = (await import('@ffmpeg-installer/ffmpeg')).default.path, ffprobe = (await import('@ffprobe-installer/ffprobe')).default.path;
  const sharp = (await import('sharp')).default;
  const { encodeComposite, buildAudioTrack, mockTalkingClip } = await import('../src/video.ts');
  const img = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#224' } }).jpeg().toBuffer();
  const tts = spawnSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=200:duration=3', '-f', 'mp3', 'pipe:1'], { maxBuffer: 1e8 }).stdout;
  const clip = await mockTalkingClip(ffmpeg, img, 4000, true);
  const load = async () => clip;
  const track = await buildAudioTrack(ffmpeg, [{ durMs: 1200, src: tts, ext: 'mp3' }, { durMs: 2400, src: load, ext: 'mp4', offsetMs: 400 }, { durMs: 1600 }]);
  const mp4 = await encodeComposite(ffmpeg, [
    { kind: 'still', startMs: 0, endMs: 1200, shots: [{ startMs: 0, endMs: 1200, scene: 'cover', text: 'Aviso' }] },
    { kind: 'anim', startMs: 1200, endMs: 3600, base: img, clip: load, clipOffsetMs: 400, notice: 'AI-generated video · AI voice', who: { name: 'Ana', role: 'Guest' }, cues: [{ startMs: 0, endMs: 1200, text: 'Olá' }, { startMs: 1200, endMs: 2400, text: 'Mundo' }] },
    { kind: 'still', startMs: 3600, endMs: 5200, shots: [{ startMs: 3600, endMs: 5200, scene: 'cover', text: '' }] },
  ] as any, async () => img, track, undefined, 'm4a');
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const f = join(mkdtempSync(join(tmpdir(), 'pe-')), 'v.mp4'); writeFileSync(f, mp4);
  const dur = (sel: string) => parseFloat(spawnSync(ffprobe, ['-v', 'error', '-select_streams', sel, '-show_entries', 'stream=duration', '-of', 'csv=p=0', f]).stdout.toString());
  const v = dur('v:0'), a = dur('a:0');
  assert.ok(Math.abs(v - 5.2) < 0.1, `vídeo ${v}`);
  assert.ok(Math.abs(a - v) < 0.1, `som ${a} face à imagem ${v}`);
});

test('limpeza de chaves coladas: tira prefixos de código, aspas e espaços sem mexer na chave', async () => {
  const { cleanSecret, secretFingerprint } = await import('../src/settings.ts');
  const k = 'fal_sk_abc123DEF456ghi789';
  for (const raw of [k, ` ${k}\n`, `"${k}"`, `FAL_KEY="${k}"`, `export FAL_KEY=${k}`, `Authorization: Key ${k}`, `Key ${k}`, `Bearer ${k}`, `'${k}';`])
    assert.equal(cleanSecret(raw), k, raw);
  assert.equal(cleanSecret('abc123:sk_live_xyz'), 'abc123:sk_live_xyz', 'formato id:segredo intacto');
  assert.equal(cleanSecret('fal_sk_abc123 0123456789abcdef'), 'fal_sk_abc123:0123456789abcdef', 'fal.ai: ID e segredo colados com espaço');
  assert.equal(cleanSecret('fal_sk_abc123:0123456789abcdef'), 'fal_sk_abc123:0123456789abcdef');
  assert.equal(cleanSecret('sk-proj-AbC'), 'sk-proj-AbC');
  assert.equal(cleanSecret('ABC123:SECRET'), 'ABC123:SECRET', 'identificador em maiúsculas não é confundido com nome de variável');
  assert.match(secretFingerprint(k), /^25 caracteres, começa por «fal_sk_», termina em «…i789»$/);
  assert.match(secretFingerprint('minhapass fal_sk_x'), /espaços/);
  assert.match(secretFingerprint('fal_sk_acn…437832d2'), /vista abreviada/);
  const { isApiKey } = await import('../src/settings.ts');
  assert.equal(isApiKey('FAL_KEY'), true); assert.equal(isApiKey('MOLONI_PASSWORD'), false, 'palavras-passe não são alteradas'); assert.equal(isApiKey('MAIL_FROM'), false);
});

test('Veo: falas divididas em pedaços que cabem num clipe, sem alterar o texto', async () => {
  const { chunkText, veoDuration, VEO_MAX_WORDS } = await import('../src/veo-episode.ts');
  assert.deepEqual(chunkText('Hello and welcome.'), ['Hello and welcome.']);
  assert.deepEqual(chunkText(''), []);
  const long = 'Energy storage matters because the grid needs flexibility. Prices fell 3.5 percent last year, and the trend continues. We expect, however, that regulation, investment and public acceptance will decide the pace of change in Portugal over the next decade.';
  const parts = chunkText(long);
  assert.ok(parts.length >= 3);
  for (const x of parts) assert.ok(x.split(' ').length <= VEO_MAX_WORDS, x);
  assert.equal(parts.join(' '), long, 'juntar os pedaços devolve o texto original');
  assert.ok(parts.some(x => x.includes('3.5 percent')), 'números decimais não partem a frase');
  const run = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
  assert.equal(chunkText(run).join(' '), run);
  assert.equal(veoDuration('Hello and welcome.'), 4);
  assert.equal(veoDuration('one two three four five six seven eight nine ten'), 6);
  assert.equal(veoDuration(Array(15).fill('word').join(' ')), 8);
});

test('Veo: comparação palavra a palavra entre o guião e o que se ouviu', async () => {
  const { wordDiff, fidelityOk, personNames } = await import('../src/veo-episode.ts');
  const t = 'Thank you, Ana, for sharing your time with us.';
  const names = personNames(['Ana Silva', 'Jose Farias']);
  const same = wordDiff(t, 'Thank you Ana for sharing your time with us', names);
  assert.equal(same.edits, 0); assert.equal(same.n, 9); assert.ok(fidelityOk(same));
  const anna = wordDiff(t, 'Thank you, Anna, for sharing your time with us.', names);
  assert.equal(anna.edits, 1); assert.ok(fidelityOk(anna), 'outra grafia de um nome próprio não obriga a pagar outra vez');
  assert.ok(!fidelityOk(wordDiff(t, 'Thank you for joining us today.', names)), 'texto diferente falha');
  assert.ok(!fidelityOk(wordDiff(t, '', names)), 'clipe sem fala falha');
  // negações, números e palavras curtas nunca se toleram
  assert.ok(!fidelityOk(wordDiff('Yes.', 'No.')));
  assert.ok(!fidelityOk(wordDiff('We do support the new regulation.', 'We do not support the new regulation.')));
  assert.ok(!fidelityOk(wordDiff('I agree with that decision.', "I don't agree with that decision.")));
  assert.ok(!fidelityOk(wordDiff('I support the merger.', 'I oppose the merger.')));
  assert.ok(!fidelityOk(wordDiff('Prices fell 3 percent.', 'Prices fell 4 percent.')));
  assert.ok(!fidelityOk(wordDiff('We had three options.', 'We had two options.')));
  // contrações, hesitações e variantes ortográficas britânico/americano não contam
  assert.ok(fidelityOk(wordDiff("It's a market that doesn't work.", 'It is a market that does not work.')));
  assert.ok(fidelityOk(wordDiff('We need to realise the change.', 'Um, we need to realize the change.')));
  for (const [a, b] of [['the colour of energy', 'the color of energy'], ['in the city centre today', 'in the city center today'], ['we travelled a lot', 'we traveled a lot'], ['a strong defence plan', 'a strong defense plan'], ['the organisation grew', 'the organization grew']])
    assert.ok(fidelityOk(wordDiff(a, b)), `${a} / ${b}`);
  assert.ok(fidelityOk(wordDiff('Welcome, Jose.', 'Welcome, José.', names)), 'nome da pessoa com acento');
  // sinais e símbolos dos números contam: o sentido muda
  for (const [a, b] of [['Revenue grew -3% last year.', 'Revenue grew 3% last year.'], ['It moved -3%.', 'It moved +3%.'], ['A €5 million plan.', 'A $5 million plan.'], ['It takes 2-5 years.', 'It takes 2.5 years.'], ['A 5% fee.', 'A $5 fee.'], ['We have 10+ years.', 'We have 10 years.'], ['A ratio of 3:1.', 'A ratio of 3.1.'], ['About 1/2 of them.', 'About 1.2 of them.']])
    assert.ok(!fidelityOk(wordDiff(a, b)), `${a} / ${b}`);
  for (const [a, b] of [['A 5% fee.', 'A 5 percent fee.'], ['A €5 fee.', 'A €5 fee.'], ['We have three options.', 'We have 3 options.'], ['We sold 1,000 units.', 'We sold 1000 units.'], ['The fibre network.', 'The fiber network.'], ['A colourful neighbourhood.', 'A colorful neighborhood.'], ['Our counsellor.', 'Our counselor.'], ["Ana's view.", "Anna's view."]])
    assert.ok(fidelityOk(wordDiff(a, b, names)), `${a} / ${b}`);
  // nenhum símbolo junto a um número desaparece; a forma dita por extenso coincide
  for (const [a, b] of [['<2 bar', '2 bar'], ['<2 bar', '>2 bar'], ['±5%', '5%'], ['≤10 ohms', '10 ohms'], ['-$5 million', '$5 million'], ['"-3%"', '"3%"'], ['[-5]', '[5]'], ['Range:-5', 'Range: 5'], ['50¢', '50'], ['\u20123%', '3%'], ['~5 years', '5 years']])
    assert.ok(!fidelityOk(wordDiff(a, b)), `${a} / ${b}`);
  for (const [a, b] of [['<2 bar', 'less than 2 bar'], ['±5%', 'plus or minus 5%'], ['-$5 million', 'minus $5 million'], ['≤10 ohms', 'at most 10 ohms'], ['R&D teams', 'R and D teams'], ['The centred design.', 'The centered design.'], ['Fibres and metres.', 'Fibers and meters.']])
    assert.ok(fidelityOk(wordDiff(a, b)), `${a} / ${b}`);
  assert.ok(!fidelityOk(wordDiff('A timbre.', 'A timber.')), 'timbre/timber são palavras diferentes');
  // o nome só se tolera onde é usado como nome
  const { namesUsedIn } = await import('../src/veo-episode.ts');
  const people = personNames(['Will Grant', 'Paula Reis']);
  assert.ok(!fidelityOk(wordDiff('I will grant it.', 'I well grand it.', namesUsedIn('I will grant it.', people))), 'will/grant minúsculos não são nomes');
  assert.ok(fidelityOk(wordDiff('Thank you, Will.', 'Thank you, Wil.', namesUsedIn('Thank you, Will.', people))));
  // trocas que mudam o sentido nunca passam, mesmo com uma letra de diferença ou com maiúscula a meio da frase
  for (const [a, b] of [['Yes, I approved the payment.', 'Yes, he approved the payment.'], ['We will hire people every year.', 'We will fire people every year.'], ['I have this market.', 'I hate this market.'], ['We lose clients.', 'We lost clients.'], ['We lost millions last year.', 'We lost billions last year.'], ['It starts in June.', 'It starts in July.'], ['The EU decided.', 'The US decided.'], ['Right.', 'Fight.'], ['We could do it.', 'We would do it.'], ['You must go.', 'You most go.'], ['It is there.', 'It is here.'], ['Prices rise.', 'Prices rose.'], ['Thank you, Ana.', 'Thank you and.']])
    assert.ok(!fidelityOk(wordDiff(a, b, names)), `${a} / ${b}`);
});

test('Veo: corte do clipe só com tempos coerentes; números e siglas contam como palavras faladas', async () => {
  const { trimWindow, spokenCount, chunkText, veoDuration } = await import('../src/veo-episode.ts');
  const w = (arr: [string, number, number][]) => arr.map(([word, start, end]) => ({ word, start, end }));
  assert.deepEqual(trimWindow(w([['Hello', 0.9, 1.2], ['world.', 1.3, 1.8]]), 4000, 'Hello world.'), { a: 680, b: 2160 });
  assert.deepEqual(trimWindow(w([['world.', 1.3, 1.8]]), 4000, 'Well, world.'), { a: 600, b: 2160 }, 'primeira palavra em falta: margem larga');
  assert.deepEqual(trimWindow(w([['Hello', 0, 0], ['world', 0, 0]]), 4000, 'Hello world'), { a: 0, b: 4000 }, 'tempos degenerados: clipe inteiro');
  assert.deepEqual(trimWindow(w([['Hello', 9.1, 9.4]]), 4000, 'Hello'), { a: 0, b: 4000 }, 'tempos fora do clipe: clipe inteiro');
  assert.deepEqual(trimWindow([], 6000, 'x'), { a: 0, b: 6000 });
  assert.equal(spokenCount('In 2023, the EU invested 3.5 billion euros in R&D.'), 16);
  assert.ok(veoDuration('In 2023, the EU invested 3.5 billion euros in R&D.') === 8);
  for (const x of chunkText('In 2023, 2024 and 2025 the EU, the USA and the UK invested 3.5, 4.5 and 5.5 billion euros in R&D, AI and 5G networks across 27 countries.')) assert.ok(spokenCount(x) <= 15, x);
});

test('Veo: planos fixos cortados nas legendas', async () => {
  const { stillShots } = await import('../src/veo-episode.ts');
  const shots = stillShots('cover', 0, 4000, [{ startMs: 400, endMs: 2000, text: 'A' }, { startMs: 2000, endMs: 3600, text: 'B' }]);
  assert.deepEqual(shots.map(x => [x.startMs, x.endMs, x.text]), [[0, 400, ''], [400, 2000, 'A'], [2000, 3600, 'B'], [3600, 4000, '']]);
});

test('Laboratório: Veo Lite disponível com o modelo e o preço certos', async () => {
  const { PROVIDERS, VEO_LITE_MODEL, veoGenerate } = await import('../src/talking.ts');
  const lite = PROVIDERS.find(p => p.id === 'veo-lite')!;
  assert.ok(lite); assert.equal(lite.pricePerSec, 0.05); assert.equal(lite.ownAudio, false); assert.equal(VEO_LITE_MODEL, 'veo-3.1-lite-generate-preview');
  const real = globalThis.fetch;
  let url = '';
  globalThis.fetch = (async (u: string) => { url = String(u); return new Response(JSON.stringify({ error: { message: 'stop' } }), { status: 400 }); }) as any;
  try { await assert.rejects(veoGenerate({ image: Buffer.from('x'), prompt: 'p', durationSeconds: 8, model: VEO_LITE_MODEL })); }
  finally { globalThis.fetch = real; }
  assert.match(url, /models\/veo-3\.1-lite-generate-preview:predictLongRunning$/, 'o pedido vai para o modelo Lite');
});
