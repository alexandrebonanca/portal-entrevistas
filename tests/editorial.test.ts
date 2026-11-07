import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

process.env.AI_MOCK = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));

const E = await import('../src/editorial.ts');
const { storeZip } = await import('../src/zip.ts');
const { shiftCues, videoTracks } = await import('../src/subtitles.ts');
const { answerKeyPoints } = await import('../src/ai/openai.ts');
const { makeToneWav, probeAudio } = await import('../src/media.ts');
const { stillClip } = await import('../src/video.ts');
const sharp = (await import('sharp')).default;
const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
const ffmpeg = process.env.FFMPEG_PATH || ff.path;

test('editorial: tema curto, legendas no tempo do vídeo e faixas do leitor', () => {
  assert.equal(E.shortTopic('Market entry?'), 'Market entry');
  const t = E.shortTopic('How did you organise the people, the batteries and the software so that every site could answer?');
  assert.ok(t.length <= 46 && t.endsWith('…'), t);
  assert.deepEqual(shiftCues([{ startMs: 0, endMs: 1000, text: 'a' }], 3000), [{ startMs: 3000, endMs: 4000, text: 'a' }]);
  const tr = videoTracks({ subtitles: { en: [], 'pt-PT': [], 'x"><script>': [] } }, l => `/e/s/subs/${l}.vtt?video=1&x=1`);
  assert.equal((tr.match(/<track /g) ?? []).length, 2, 'só códigos de idioma válidos');
  assert.match(tr, /label="Português" src="\/e\/s\/subs\/pt-PT\.vtt\?video=1&amp;x=1"/);
});

test('editorial: ideias-chave (simuladas) com tema e três pontos curtos por resposta', async () => {
  const m = await answerKeyPoints([{ id: 'a0', question: 'What changed in hotel operations after the pandemic?', answer: 'Teams became leaner, guests expect digital check-in, and revenue management moved to daily pricing decisions.' }]);
  const k = m.get('a0')!;
  assert.ok(k.topic.length > 0 && k.topic.length <= 40);
  assert.equal(k.points.length, 3); assert.ok(k.points.every(p => p.length > 0 && p.length <= 32));
});

test('editorial: ZIP de entrega válido (STORE, nomes UTF-8)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zip-'));
  const f = join(dir, 'x.zip');
  writeFileSync(f, Buffer.concat(storeZip([{ name: 'vídeo.mp4', data: Buffer.from('abc') }, { name: 'legendas/a.en.srt', data: Buffer.from('1\n') }])));
  const out = execFileSync('unzip', ['-t', f]).toString();
  assert.match(out, /No errors detected/);
});

test('editorial: monta o vídeo (abertura, aviso, falas com tema, ideias-chave, final) com a duração certa', async () => {
  const durationMs = 26_000;
  const mp3 = execFileSync(ffmpeg, ['-v', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 'mp3', 'pipe:1'], { input: makeToneWav(durationMs / 1000) });
  const photo = await sharp({ create: { width: 300, height: 400, channels: 3, background: '#88a' } }).jpeg().toBuffer();
  const clip = await stillClip(ffmpeg, photo, 2000);
  const segs = [
    { id: 'disclosure', role: 'host' as const, kind: 'disclosure', startMs: 0, endMs: 2000 },
    { id: 'q0', role: 'host' as const, kind: 'translated_question', startMs: 2000, endMs: 4000 },
    { id: 'a0', role: 'guest' as const, kind: 'translated_answer', startMs: 4000, endMs: 26_000 },
  ];
  const r = await E.editorialVideo({
    ffmpeg, size: { w: 640, h: 360 }, audio: mp3, durationMs, segs, clip: id => (id === 'q0' ? async () => clip : null),
    photos: { host: photo, guest: null }, people: { host: { name: 'Alex Rodrigues', role: 'CEO · Hotel Training Academy' }, guest: { name: 'Jorge Beldade', role: 'Former hotel director' } },
    promoter: 'Hotel Training Academy', title: 'Hotels after the pandemic', chapters: new Map([['q0', 'Operations today']]),
    keyPoints: new Map([['a0', ['Leaner teams', 'Digital check-in', 'Daily pricing']]]), writtenAnswers: false, animated: true,
    cues: [{ startMs: 500, endMs: 1800, text: 'Aviso inicial.' }, { startMs: 2100, endMs: 3900, text: 'Como estão os hotéis hoje?' }, { startMs: 4200, endMs: 9000, text: 'Equipas mais pequenas e check-in digital.' }],
  });
  assert.equal(r.mp4.subarray(4, 8).toString('latin1'), 'ftyp');
  assert.equal(r.totalMs, E.OPEN_MS + durationMs + E.CLOSE_MS);
  assert.deepEqual(r.chapters, [{ title: 'Operations today', time: 5 }], 'capítulo no tempo do vídeo (3 s de abertura + 2 s)');
  assert.deepEqual([r.meta.lowerThirds, r.meta.topics, r.meta.keyPointCards, r.meta.animatedParts, r.meta.stillParts], [2, 1, 3, 1, 1]);
  assert.equal(r.meta.subtitles, 3, 'legendas gravadas na imagem: aviso, pergunta e resposta');
  const pr = await probeAudio(r.mp4, 'mp4');
  assert.ok(Math.abs(pr.durationMs - r.totalMs) < 400, `duração ${pr.durationMs} vs ${r.totalMs}`);
});

test('custos internos: só os administradores listados em COST_VIEWERS (por omissão, o dono) veem dólares', async () => {
  const { seesCosts } = await import('../src/costs.ts');
  const prev = process.env.COST_VIEWERS; delete process.env.COST_VIEWERS;
  assert.equal(seesCosts({ role: 'admin', email: 'AlexandreBonanca@gmail.com' }), true, 'o dono, sem configurar nada');
  assert.equal(seesCosts({ role: 'admin', email: 'hoteltrainingacademy@gmail.com' }), false, 'outro administrador vê como cliente');
  assert.equal(seesCosts({ role: 'user', email: 'alexandrebonanca@gmail.com' }), false, 'só administradores');
  process.env.COST_VIEWERS = 'a@x.pt, b@x.pt';
  assert.equal(seesCosts({ role: 'admin', email: 'b@x.pt' }), true);
  assert.equal(seesCosts({ role: 'admin', email: 'alexandrebonanca@gmail.com' }), false, 'a lista substitui o valor por omissão');
  if (prev === undefined) delete process.env.COST_VIEWERS; else process.env.COST_VIEWERS = prev;
});
