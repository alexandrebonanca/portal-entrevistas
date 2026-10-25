import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import type { Handler } from './jobs.ts';
import { config } from './config.ts';
import { storage } from './storage.ts';
import { saveAsset, withTemp } from './media.ts';
import { generateFictionalPortrait } from './ai/openai.ts';
import { veoGenerate, veoEpisodePrompt, veoPricePerSec, type VeoTier } from './talking.ts';
import { chunkText, veoDuration, startImage, transcribeVeoClip, trimWindow } from './veo-episode.ts';
import { mockTalkingClip, animClipFilter, PUNCH_IN, W, H, run } from './video.ts';

/**
 * Laboratório — continuidade entre clipes do Google Veo (só administradores, retrato fictício).
 * Gera a mesma fala em pedaços de duas maneiras e monta três versões para comparar os cortes:
 *  A. «como hoje»: todos os pedaços a partir do retrato (a pose volta à da fotografia em cada corte);
 *  B. a mesma montagem de A com plano normal e apertado alternados nos cortes (PUNCH_IN, sem custo);
 *  C. «encadeado»: cada pedaço começa no fotograma onde o anterior foi cortado (continuidade de pose).
 * O pedaço 1 é o mesmo em A e C (pago uma vez); cada clipe fica guardado e uma nova tentativa não o paga outra vez.
 */
export const LAB_CONTINUITY_MAX_CHUNKS = 3;

const ffmpegPath = async () => process.env.FFMPEG_PATH || (await import('@ffmpeg-installer/ffmpeg')).default.path;

interface ClipOut { buf: Buffer; a: number; b: number; text: string; heard: string; dur: number; usd: number }

export const veoContinuity: Handler = async (job, { db, progress }) => {
  const ffmpeg = await ffmpegPath();
  const tier: VeoTier = job.input.tier === 'lite' ? 'lite' : 'fast';
  const mock = config.openai.mock;
  const prevP = await db.one(`SELECT id, storage_key FROM assets WHERE kind='lab_portrait' AND meta->>'jobId'=$1 LIMIT 1`, [job.id]);
  let portrait: Buffer, portraitId: string;
  if (prevP) { portrait = await storage.get(prevP.storage_key); portraitId = prevP.id; }
  else {
    await progress(2, 100, 'A gerar um retrato fictício');
    portrait = await generateFictionalPortrait();
    portraitId = await saveAsset(db, { interviewId: null, kind: 'lab_portrait', mime: 'image/jpeg', ext: 'jpg', data: portrait, meta: { fictional: true, jobId: job.id } });
  }
  const first = await startImage(portrait);
  const chunks = chunkText(String(job.input.text ?? '')).slice(0, LAB_CONTINUITY_MAX_CHUNKS);
  if (chunks.length < 2) throw new Error('O texto tem de dar pelo menos dois pedaços (frases) para haver cortes.');
  const total = chunks.length * 2 - 1;
  let done = 0;

  const clip = async (name: string, image: Buffer, text: string): Promise<ClipOut> => {
    const prev = await db.one(`SELECT storage_key, meta FROM assets WHERE kind='lab_video' AND meta->>'jobId'=$1 AND meta->>'clip'=$2 LIMIT 1`, [job.id, name]);
    if (prev) return { buf: await storage.get(prev.storage_key), ...prev.meta };
    const dur = veoDuration(text);
    await progress(5 + Math.round((done / total) * 80), 100, `Clipe ${name}: a gerar no Google Veo`);
    const video = mock ? await mockTalkingClip(ffmpeg, image, dur * 1000) : (await veoGenerate({ image, prompt: veoEpisodePrompt({ role: 'host', text, voice: 'male' }), durationSeconds: dur, tier })).video;
    const tr = await transcribeVeoClip(video, text, dur);
    const { a, b } = trimWindow(tr.words, dur * 1000, text);
    const meta = { jobId: job.id, clip: name, text, heard: tr.words.map(w => w.word).join(' '), dur, a, b, usd: mock ? 0 : dur * veoPricePerSec(tier) };
    await saveAsset(db, { interviewId: null, kind: 'lab_video', mime: 'video/mp4', ext: 'mp4', data: video, meta });
    done++;
    return { buf: video, ...meta };
  };
  /** Fotograma do clipe no ponto de corte (o último que entra na montagem), como imagem inicial do pedaço seguinte. */
  const frameAt = (c: ClipOut) => withTemp(async dir => {
    const i = join(dir, 'c.mp4'), o = join(dir, 'f.jpg');
    await writeFile(i, c.buf);
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-ss', (Math.max(0, c.b - 80) / 1000).toFixed(3), '-i', i, '-frames:v', '1', '-q:v', '2', o], 60_000);
    if (r.code !== 0) throw new Error('Falha a tirar o fotograma de corte: ' + r.stderr.slice(-200));
    return readFile(o);
  });

  const same: ClipOut[] = [];
  for (const [k, text] of chunks.entries()) same.push(await clip(`A${k + 1}`, first.image, text));
  const chained: ClipOut[] = [same[0]];
  for (let k = 1; k < chunks.length; k++) chained.push(await clip(`C${k + 1}`, (await startImage(await frameAt(chained[k - 1]))).image, chunks[k]));

  await progress(88, 100, 'A montar as três versões');
  const variants = [
    { id: 'same', label: 'A — como hoje (cada clipe parte do retrato)', pieces: same.map(c => ({ c, zoom: 1 })) },
    { id: 'punch', label: 'B — como hoje, com plano apertado alternado nos cortes', pieces: same.map((c, k) => ({ c, zoom: k % 2 ? PUNCH_IN : 1 })) },
    { id: 'chain', label: 'C — encadeado (cada clipe parte do fotograma do corte anterior)', pieces: chained.map(c => ({ c, zoom: 1 })) },
  ];
  const out: any[] = [];
  for (const v of variants) {
    const prev = await db.one(`SELECT id FROM assets WHERE kind='lab_video' AND meta->>'jobId'=$1 AND meta->>'variant'=$2 LIMIT 1`, [job.id, v.id]);
    if (prev) { out.push({ id: v.id, label: v.label, videoAssetId: prev.id }); continue; }
    const mp4 = await assemble(ffmpeg, v.pieces);
    const id = await saveAsset(db, { interviewId: null, kind: 'lab_video', mime: 'video/mp4', ext: 'mp4', data: mp4, meta: { jobId: job.id, variant: v.id, label: v.label } });
    out.push({ id: v.id, label: v.label, videoAssetId: id });
  }
  const usd = [...same, ...chained.slice(1)].reduce((x, c) => x + c.usd, 0);
  await progress(100, 100, 'Concluído');
  return { variants: out, portraitAssetId: portraitId, chunks, tier, usd, clips: [...same, ...chained.slice(1)].map(c => ({ text: c.text, heard: c.heard, a: c.a, b: c.b })) };
};

/** Junta os pedaços cortados [a, b] de cada clipe (imagem e som), com o plano pedido e fades curtos no som. */
async function assemble(ffmpeg: string, pieces: { c: ClipOut; zoom: number }[]): Promise<Buffer> {
  return withTemp(async dir => {
    const files: string[] = [];
    for (const [k, { c, zoom }] of pieces.entries()) {
      const i = join(dir, `c${k}.mp4`), o = join(dir, `p${k}.mp4`), d = ((c.b - c.a) / 1000).toFixed(3);
      await writeFile(i, c.buf);
      const fadeOut = Math.max(0, (c.b - c.a) / 1000 - 0.03).toFixed(3);
      const vf = `[0:v]${animClipFilter(zoom)},scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=25,format=yuv420p[v]`;
      const af = `[0:a]afade=t=in:d=0.015,loudnorm=I=-16:TP=-1.5:LRA=11,apad,afade=t=out:st=${fadeOut}:d=0.03,aresample=44100[a]`;
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-ss', (c.a / 1000).toFixed(3), '-t', d, '-i', i, '-filter_complex', `${vf};${af}`, '-map', '[v]', '-map', '[a]', '-t', d,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-bf', '0', '-c:a', 'aac', '-ar', '44100', '-ac', '2', o], 300_000);
      if (r.code !== 0) throw new Error('Falha a cortar o clipe: ' + r.stderr.slice(-300));
      files.push(o);
    }
    const list = join(dir, 'l.txt'), out = join(dir, 'out.mp4');
    await writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', out], 300_000);
    if (r.code !== 0) throw new Error('Falha a juntar as partes: ' + r.stderr.slice(-300));
    return readFile(out);
  });
}
