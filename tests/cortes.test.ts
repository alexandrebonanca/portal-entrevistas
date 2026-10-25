import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const { animClipFilter, PUNCH_IN, mockTalkingClip, buildAudioTrack } = await import('../src/video.ts');
const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
const ffmpeg = process.env.FFMPEG_PATH || ff.path;
const sharp = (await import('sharp')).default;

const dims = (file: string) => {
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /, (\d{2,5})x(\d{2,5})[, ]/.exec(r.stderr);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

test('plano normal: o mesmo filtro de sempre (vídeos já gerados não mudam)', () => {
  assert.equal(animClipFilter(undefined), 'setpts=PTS-STARTPTS,scale=-2:720,setsar=1');
  assert.equal(animClipFilter(1), 'setpts=PTS-STARTPTS,scale=-2:720,setsar=1');
  assert.ok(PUNCH_IN > 1.1 && PUNCH_IN < 1.3, 'aperto discreto, sem perder a cara');
});

test('plano apertado: amplia e recorta ao enquadramento, horizontal e vertical', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qi-cortes-'));
  const img = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#468' } }).jpeg().toBuffer();
  for (const [vertical, want] of [[false, [1280, 720]], [true, null]] as const) {
    const clip = join(dir, `c${vertical}.mp4`), out = join(dir, `o${vertical}.mp4`);
    writeFileSync(clip, await mockTalkingClip(ffmpeg, img, 1000, vertical));
    const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', clip, '-vf', animClipFilter(PUNCH_IN), '-an', '-frames:v', '5', out], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const d = dims(out)!;
    assert.equal(d[1], 720, 'altura do vídeo');
    if (want) assert.deepEqual(d, want); else assert.ok(d[0] < 720, 'vertical: fica estreito, centrado sobre o fundo');
  }
});

test('som dos clipes com fades curtos nas pontas: sem estalidos e com a duração certa', async () => {
  const img = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#333' } }).jpeg().toBuffer();
  const clip = await mockTalkingClip(ffmpeg, img, 2000);
  const track = await buildAudioTrack(ffmpeg, [{ durMs: 900, src: clip, ext: 'mp4', offsetMs: 200 }, { durMs: 700, src: clip, ext: 'mp4', offsetMs: 0 }]);
  const dir = mkdtempSync(join(tmpdir(), 'qi-som-')), f = join(dir, 't.m4a');
  writeFileSync(f, track);
  const r = spawnSync(ffmpeg, ['-hide_banner', '-i', f], { encoding: 'utf8' });
  const m = /Duration: 00:00:(\d+\.\d+)/.exec(r.stderr);
  assert.ok(m && Math.abs(Number(m[1]) - 1.6) < 0.1, `duração ${m?.[1]}`);
  assert.ok(readFileSync(f).length > 1000);
});

test('clipes encadeados: fotograma de corte em JPEG, à medida do clipe', async () => {
  const { cutFrame, veoChain } = await import('../src/veo-episode.ts');
  assert.equal(veoChain(), true, 'ligado por omissão');
  const img = await sharp({ create: { width: 1280, height: 720, channels: 3, background: '#468' } }).jpeg().toBuffer();
  const clip = await mockTalkingClip(ffmpeg, img, 2000);
  const f = await cutFrame(ffmpeg, clip, 1500);
  assert.equal(f.subarray(0, 2).toString('hex'), 'ffd8');
  const m = await sharp(f).metadata();
  assert.deepEqual([m.width, m.height], [1280, 720]);
});

test('clipe com margens (HeyGen em 16:9 de uma fotografia quadrada): o recorte à proporção da fotografia tira-as', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qi-crop-'));
  const img = await sharp({ create: { width: 640, height: 360, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  const clip = join(dir, 'c.mp4'), out = join(dir, 'o.mp4');
  writeFileSync(clip, await mockTalkingClip(ffmpeg, img, 1000));
  const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-i', clip, '-vf', animClipFilter(1, 1280, 720, 1), '-an', '-frames:v', '3', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(dims(out), [720, 720]);
});
