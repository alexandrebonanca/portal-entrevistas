import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { esc } from './lib.ts';
import { withTemp } from './media.ts';
import type { Cue } from './subtitles.ts';

export const W = 1280, H = 720;
export type Scene = 'cover' | 'studio' | 'host' | 'guest';
export interface Seg { id: string; role: 'host' | 'guest'; kind: string; startMs: number; durationMs: number }
export interface Shot { startMs: number; endMs: number; scene: Scene; text: string }

/**
 * Planeia o vídeo: capa durante o aviso; composição de estúdio (os dois) durante a apresentação;
 * a partir da primeira pergunta, só quem fala, em grande plano; capa novamente no agradecimento final.
 * As pausas pertencem ao plano anterior.
 */
export function planShots(segs: Seg[], totalMs: number, cues: Cue[] | null): Shot[] {
  const scenes = segs.map((s, i) => {
    let scene: Scene;
    if (s.kind === 'disclosure' || s.kind === 'editorial_outro') scene = 'cover';
    else if (s.kind === 'editorial_intro') scene = 'studio';
    else scene = s.role;
    return { start: i === 0 ? 0 : s.startMs, end: i + 1 < segs.length ? segs[i + 1].startMs : totalMs, scene };
  });
  // Pontos de mudança: limites dos planos e das legendas.
  const cuts = new Set<number>([0, totalMs]);
  for (const s of scenes) { cuts.add(s.start); cuts.add(s.end); }
  for (const c of cues ?? []) { if (c.startMs < totalMs) cuts.add(c.startMs); if (c.endMs < totalMs) cuts.add(c.endMs); }
  const pts = [...cuts].filter(t => t >= 0 && t <= totalMs).sort((a, b) => a - b);
  const shots: Shot[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (b - a < 40) continue; // intervalos ínfimos não justificam um fotograma
    const mid = (a + b) / 2;
    const scene = (scenes.find(s => mid >= s.start && mid < s.end) ?? scenes[scenes.length - 1])?.scene ?? 'cover';
    const text = cues?.find(c => mid >= c.startMs && mid < c.endMs)?.text ?? '';
    const prev = shots[shots.length - 1];
    if (prev && prev.scene === scene && prev.text === text && prev.endMs === a) prev.endMs = b;
    else shots.push({ startMs: a, endMs: b, scene, text });
  }
  if (shots.length) { shots[0].startMs = 0; shots[shots.length - 1].endMs = totalMs; }
  return shots;
}

export function wrapLines(text: string, max = 52, maxLines = 3): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > max) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.length > maxLines ? [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')] : lines;
}

const FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";

async function blurredFill(sharp: any, img: Buffer) {
  return sharp(img).rotate().resize(W, H, { fit: 'cover' }).blur(28).modulate({ brightness: 0.55 }).toBuffer();
}
const initialsCard = (name: string, color: string) => {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="560" height="560"><rect width="560" height="560" rx="40" fill="${color}"/><text x="280" y="330" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="200" fill="#fff">${esc(ini)}</text></svg>`);
};

/** Fundos de cada plano (sem legendas). As fotografias usadas são apenas as autorizadas; nunca se gera a aparência de ninguém. */
export async function renderBases(opts: {
  cover: Buffer; title: string; brand: string;
  host: { name: string; photo: Buffer | null }; guest: { name: string; photo: Buffer | null };
}): Promise<Record<Scene, Buffer>> {
  const { default: sharp } = await import('sharp');
  const bg = await blurredFill(sharp, opts.cover);
  const coverSq = await sharp(opts.cover).resize(560, 560).jpeg().toBuffer();
  const cover = await sharp(bg).composite([{ input: coverSq, left: (W - 560) / 2, top: 50 }]).jpeg({ quality: 88 }).toBuffer();

  const portrait = async (p: { name: string; photo: Buffer | null }, size: number, color: string) => {
    const src = p.photo ? await sharp(p.photo).rotate().resize(size, size, { fit: 'cover', position: 'attention' }).toBuffer() : await sharp(initialsCard(p.name, color)).resize(size, size).toBuffer();
    const mask = Buffer.from(`<svg width="${size}" height="${size}"><rect width="${size}" height="${size}" rx="${Math.round(size / 12)}" fill="#fff"/></svg>`);
    return sharp(src).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
  };

  // Composição de estúdio: cenário desenhado + as duas fotografias reais em molduras, identificada como montagem.
  const P = 300, gap = 140, left = (W - (P * 2 + gap)) / 2, top = 96;
  const studioSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<defs><linearGradient id="d" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3a2a1e"/><stop offset="1" stop-color="#1c140e"/></linearGradient></defs>
<rect x="0" y="492" width="${W}" height="228" fill="url(#d)"/><rect x="0" y="486" width="${W}" height="8" fill="#c8803c" opacity=".7"/>
${[left + P / 2, left + P + gap + P / 2].map(cx => `<g fill="#e8e0d4"><rect x="${cx - 14}" y="446" width="28" height="48" rx="14"/><rect x="${cx - 3}" y="492" width="6" height="16"/><rect x="${cx - 26}" y="506" width="52" height="7" rx="3"/></g>`).join('')}
<text x="${left + P / 2}" y="${top + P + 40}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="28" fill="#fff">${esc(opts.host.name)}</text>
<text x="${left + P + gap + P / 2}" y="${top + P + 40}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="28" fill="#fff">${esc(opts.guest.name)}</text>
<text x="${W / 2}" y="58" text-anchor="middle" font-family="${FONT}" font-size="26" letter-spacing="4" fill="#fff" opacity=".85">${esc(opts.title.toUpperCase().slice(0, 60))}</text>
<text x="${W - 24}" y="${H - 18}" text-anchor="end" font-family="${FONT}" font-size="16" fill="#fff" opacity=".7">Composite image · asynchronous interview</text></svg>`);
  const studio = await sharp(bg).composite([
    { input: studioSvg },
    { input: await portrait(opts.host, P, '#7a4a1f'), left: Math.round(left), top },
    { input: await portrait(opts.guest, P, '#2f5d6b'), left: Math.round(left + P + gap), top },
  ]).jpeg({ quality: 88 }).toBuffer();

  // Grande plano: fotografia autorizada em altura total sobre o mesmo fundo, com o nome em rodapé.
  const close = async (p: { name: string; photo: Buffer | null }, color: string, role: string) => {
    const img = p.photo
      ? await sharp(p.photo).rotate().resize({ height: H, width: Math.round(H * 0.9), fit: 'cover', position: 'attention' }).toBuffer()
      : await sharp(initialsCard(p.name, color)).resize(H - 160, H - 160).toBuffer();
    const meta = await sharp(img).metadata();
    const lower = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="40" y="40" width="${Math.max(260, p.name.length * 22 + 60)}" height="86" rx="10" fill="#000" opacity=".55"/>
<text x="68" y="80" font-family="${FONT}" font-weight="700" font-size="30" fill="#fff">${esc(p.name)}</text><text x="68" y="110" font-family="${FONT}" font-size="20" fill="#fff" opacity=".8">${esc(role)}</text></svg>`);
    return sharp(bg).composite([{ input: img, left: Math.round((W - (meta.width ?? 0)) / 2), top: Math.round((H - (meta.height ?? 0)) / 2) }, { input: lower }]).jpeg({ quality: 88 }).toBuffer();
  };
  return { cover, studio, host: await close(opts.host, '#7a4a1f', 'Host'), guest: await close(opts.guest, '#2f5d6b', 'Guest') };
}

export async function subtitleFrame(base: Buffer, text: string): Promise<Buffer> {
  if (!text) return base;
  const { default: sharp } = await import('sharp');
  const lines = wrapLines(text);
  const lh = 46, boxH = lines.length * lh + 30, y0 = H - boxH - 36;
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${W / 2 - 560}" y="${y0}" width="1120" height="${boxH}" rx="12" fill="#000" opacity=".68"/>
${lines.map((l, i) => `<text x="${W / 2}" y="${y0 + 46 + i * lh}" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="36" fill="#fff">${esc(l)}</text>`).join('')}</svg>`);
  return sharp(base).composite([{ input: svg }]).jpeg({ quality: 86 }).toBuffer();
}

function run(bin: string, args: string[], timeoutMs: number): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Tempo excedido a codificar o vídeo')); }, timeoutMs);
    p.stderr.on('data', d => (stderr = (stderr + d).slice(-6000)));
    p.on('error', e => { clearTimeout(t); reject(e); });
    p.on('close', code => { clearTimeout(t); resolve({ code: code ?? -1, stderr }); });
  });
}

/** Codifica o vídeo a partir de fotogramas fixos com duração (sem shell, sem nomes vindos do utilizador). */
export async function encodeVideo(ffmpeg: string, shots: Shot[], frameFor: (s: Shot, i: number) => Promise<Buffer>, audio: Buffer, onProgress?: (i: number, n: number) => Promise<void>): Promise<Buffer> {
  return withTemp(async dir => {
    const lines: string[] = [];
    let last = '';
    for (let i = 0; i < shots.length; i++) {
      const f = join(dir, `f${String(i).padStart(5, '0')}.jpg`);
      await writeFile(f, await frameFor(shots[i], i));
      lines.push(`file '${f.replace(/\\/g, '/')}'`, `duration ${((shots[i].endMs - shots[i].startMs) / 1000).toFixed(3)}`);
      last = f;
      if (onProgress && i % 5 === 0) await onProgress(i, shots.length);
    }
    lines.push(`file '${last.replace(/\\/g, '/')}'`); // o concat ignora a duração do último sem esta repetição
    const list = join(dir, 'list.txt'), a = join(dir, 'audio.mp3'), out = join(dir, 'video.mp4');
    await writeFile(list, lines.join('\n'));
    await writeFile(a, audio);
    const common = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', a, '-vf', 'fps=25,format=yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart'];
    let r = await run(ffmpeg, [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'stillimage', '-crf', '24', out], 900_000);
    if (r.code !== 0) r = await run(ffmpeg, [...common, '-c:v', 'mpeg4', '-q:v', '4', out], 900_000); // reserva se o binário não tiver libx264
    if (r.code !== 0) throw new Error('Falha a codificar o vídeo: ' + r.stderr.slice(-300));
    return readFile(out);
  });
}
