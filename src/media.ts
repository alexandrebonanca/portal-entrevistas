import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { storage } from './storage.ts';
import { sha256 } from './lib.ts';
import type { Db } from './db.ts';

/** Identifica o tipo real pelo conteúdo (não pela extensão nem pelo Content-Type do cliente). */
export function sniff(buf: Buffer): { kind: 'audio' | 'image'; mime: string; ext: string } | null {
  if (buf.length < 16) return null;
  const h = buf.subarray(0, 16);
  if (h[0] === 0x1a && h[1] === 0x45 && h[2] === 0xdf && h[3] === 0xa3) return { kind: 'audio', mime: 'audio/webm', ext: 'webm' };
  if (h.toString('latin1', 0, 4) === 'OggS') return { kind: 'audio', mime: 'audio/ogg', ext: 'ogg' };
  if (h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WAVE') return { kind: 'audio', mime: 'audio/wav', ext: 'wav' };
  if (h.toString('latin1', 4, 8) === 'ftyp') return { kind: 'audio', mime: 'audio/mp4', ext: 'm4a' };
  if (h.toString('latin1', 0, 3) === 'ID3' || (h[0] === 0xff && (h[1] & 0xe0) === 0xe0)) return { kind: 'audio', mime: 'audio/mpeg', ext: 'mp3' };
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (h.toString('latin1', 1, 4) === 'PNG') return { kind: 'image', mime: 'image/png', ext: 'png' };
  return null;
}

/** Remove APP1 (EXIF/XMP) e APP13 de um JPEG, mantendo o resto intacto. */
export function stripJpegMetadata(buf: Buffer): Buffer {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const out: Buffer[] = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda) break; // início dos dados da imagem
    const len = buf.readUInt16BE(i + 2);
    const seg = buf.subarray(i, i + 2 + len);
    if (marker !== 0xe1 && marker !== 0xed) out.push(seg);
    i += 2 + len;
  }
  out.push(buf.subarray(i));
  return Buffer.concat(out);
}

export async function saveAsset(db: Db, opts: {
  interviewId: string | null; kind: string; mime: string; ext: string; data: Buffer; durationMs?: number | null; meta?: object;
}) {
  const id = randomUUID();
  const key = `${opts.interviewId ?? 'shared'}/${opts.kind}/${id}.${opts.ext}`;
  await storage.put(key, opts.data);
  await db.query(
    `INSERT INTO assets(id, interview_id, kind, mime, size, sha256, storage_key, duration_ms, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, opts.interviewId, opts.kind, opts.mime, opts.data.length, sha256(opts.data), key, opts.durationMs ?? null, JSON.stringify(opts.meta ?? {})]);
  return id;
}

let ffmpegPath: string | undefined;
let ffprobePath: string | undefined;
async function bins() {
  if (!ffmpegPath) {
    ffmpegPath = process.env.FFMPEG_PATH || (await import('@ffmpeg-installer/ffmpeg')).default.path;
    ffprobePath = process.env.FFPROBE_PATH || (await import('@ffprobe-installer/ffprobe')).default.path;
  }
  return { ffmpeg: ffmpegPath!, ffprobe: ffprobePath! };
}

/** Executa um binário sem shell (sem interpolação em linha de comandos), com limite de tempo. */
function run(bin: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Tempo excedido no processamento multimédia')); }, timeoutMs);
    p.stdout.on('data', d => (stdout += d)); p.stderr.on('data', d => (stderr = (stderr + d).slice(-8000)));
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

export async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pe-'));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** O ficheiro tem faixa de som? 'error' quando o ffprobe falha (não se sabe: não é o mesmo que «sem som»). */
export async function hasAudioStream(data: Buffer, ext: string): Promise<'yes' | 'no' | 'error'> {
  return withTemp(async dir => {
    const f = join(dir, `in.${ext}`);
    await writeFile(f, data);
    const { ffprobe } = await bins();
    const r = await run(ffprobe, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', f], 30_000).catch(() => ({ code: -1, stdout: '', stderr: '' }));
    if (r.code !== 0) return 'error';
    return r.stdout.trim().length > 0 ? 'yes' : 'no';
  });
}

/** Valida que o ficheiro descodifica e devolve a duração real. */
export async function probeAudio(data: Buffer, ext: string): Promise<{ ok: boolean; durationMs: number; silent: boolean }> {
  return withTemp(async dir => {
    const f = join(dir, `in.${ext}`);
    await writeFile(f, data);
    const { ffprobe, ffmpeg } = await bins();
    const pr = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f], 30_000);
    let dur = parseFloat(pr.stdout);
    if (!Number.isFinite(dur) || pr.code !== 0) {
      // O MediaRecorder (Chrome/Android) grava WebM em fluxo, sem duração no cabeçalho: descodificar para medir.
      // -progress escreve out_time_us no stdout independentemente do nível de log (com -v error a linha "time=" não aparece).
      const dec = await run(ffmpeg, ['-v', 'error', '-nostdin', '-i', f, '-f', 'null', '-progress', 'pipe:1', '-'], 60_000);
      const times = [...dec.stdout.matchAll(/out_time_(?:us|ms)=(\d+)/g)].map(x => Number(x[1]));
      if (dec.code !== 0 || !times.length) return { ok: false, durationMs: 0, silent: true };
      dur = Math.max(...times) / 1_000_000; // out_time_ms também vem em microssegundos (particularidade do FFmpeg)
    }
    const vol = await run(ffmpeg, ['-v', 'info', '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], 60_000);
    const mm = /max_volume:\s*(-?[\d.]+) dB/.exec(vol.stderr);
    const silent = mm ? parseFloat(mm[1]) < -55 : false;
    return { ok: true, durationMs: Math.round(dur * 1000), silent };
  });
}

export async function toMp3ForTranscription(data: Buffer, ext: string): Promise<Buffer> {
  return withTemp(async dir => {
    const i = join(dir, `in.${ext}`), o = join(dir, 'out.mp3');
    await writeFile(i, data);
    const { ffmpeg } = await bins();
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-i', i, '-ac', '1', '-ar', '16000', '-b:a', '48k', o]);
    if (r.code !== 0) throw new Error('Falha ao preparar áudio: ' + r.stderr.slice(-300));
    return readFile(o);
  });
}

/** Junta segmentos de áudio com pausas, normaliza (derivado) e exporta MP3. Os originais não são tocados. */
export async function assembleEpisode(parts: { data: Buffer; ext: string; pauseAfterMs: number }[], opts: { fadeMs?: number } = {}) {
  return withTemp(async dir => {
    const { ffmpeg, ffprobe } = await bins();
    const files: string[] = [];
    for (let i = 0; i < parts.length; i++) {
      const raw = join(dir, `p${i}.${parts[i].ext}`), wav = join(dir, `n${i}.wav`);
      await writeFile(raw, parts[i].data);
      const pad = Math.round((parts[i].pauseAfterMs / 1000) * 44100); // amostras (pad_len funciona em todas as versões do FFmpeg)
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-i', raw, '-ac', '1', '-ar', '44100', '-af', `aresample=44100,apad=pad_len=${pad}`, wav]);
      if (r.code !== 0) throw new Error('Falha a normalizar segmento: ' + r.stderr.slice(-300));
      files.push(wav);
    }
    const list = join(dir, 'list.txt');
    await writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
    const joined = join(dir, 'joined.wav');
    let r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', joined]);
    if (r.code !== 0) throw new Error('Falha a concatenar: ' + r.stderr.slice(-300));
    const fade = (opts.fadeMs ?? 400) / 1000;
    const dprobe = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', joined], 30_000);
    const total = parseFloat(dprobe.stdout) || 0;
    const out = join(dir, 'episode.mp3');
    // Alvo editorial configurável: -16 LUFS, true peak -1.5 dBTP (não é requisito legal universal).
    r = await run(ffmpeg, ['-y', '-v', 'error', '-i', joined, '-af',
      `loudnorm=I=-16:TP=-1.5:LRA=11,afade=t=in:d=${fade},afade=t=out:st=${Math.max(0, total - fade).toFixed(3)}:d=${fade}`,
      '-ar', '44100', '-b:a', '128k', out], 300_000);
    if (r.code !== 0) throw new Error('Falha a exportar: ' + r.stderr.slice(-300));
    const meas = await run(ffmpeg, ['-v', 'info', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], 120_000);
    const peak = /max_volume:\s*(-?[\d.]+) dB/.exec(meas.stderr);
    const mp3 = await readFile(out);
    return { mp3, durationMs: Math.round(total * 1000), maxVolumeDb: peak ? parseFloat(peak[1]) : null, clipping: peak ? parseFloat(peak[1]) >= -0.1 : false };
  });
}

export async function audioDurationMs(data: Buffer, ext: string) {
  const p = await probeAudio(data, ext);
  return p.durationMs;
}

/** WAV mono 16-bit, usado apenas pelo modo simulado (AI_MOCK) para testar a cadeia sem serviços externos. */
export function makeToneWav(seconds: number, freq = 330): Buffer {
  const rate = 24000, n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 6000), 44 + i * 2);
  return buf;
}
