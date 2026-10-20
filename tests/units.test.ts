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
  ] as any, async () => img, track, undefined, 'wav');
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
  const { wordDiff, fidelityOk } = await import('../src/veo-episode.ts');
  const t = 'Thank you, Ana, for sharing your time with us.';
  assert.deepEqual(wordDiff(t, 'Thank you Ana for sharing your time with us'), { edits: 0, n: 9, wer: 0 });
  assert.equal(wordDiff(t, 'Thank you, Anna, for sharing your time with us.').edits, 1);
  assert.ok(fidelityOk(wordDiff(t, 'Thank you, Anna, for sharing your time with us.')), 'um nome mal transcrito não obriga a pagar outra vez');
  assert.ok(!fidelityOk(wordDiff(t, 'Thank you for joining us today.')), 'texto diferente falha');
  assert.ok(!fidelityOk(wordDiff(t, '')), 'clipe sem fala falha');
});

test('Veo: planos fixos cortados nas legendas', async () => {
  const { stillShots } = await import('../src/veo-episode.ts');
  const shots = stillShots('cover', 0, 4000, [{ startMs: 400, endMs: 2000, text: 'A' }, { startMs: 2000, endMs: 3600, text: 'B' }]);
  assert.deepEqual(shots.map(x => [x.startMs, x.endMs, x.text]), [[0, 400, ''], [400, 2000, 'A'], [2000, 3600, 'B'], [3600, 4000, '']]);
});
