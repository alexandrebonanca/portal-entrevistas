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

export const FONT = "DejaVu Sans, Arial, Helvetica, sans-serif";
/** Geometria das legendas gravadas: o grafismo (rodapés) fica sempre acima da caixa mais alta (3 linhas). */
export const SUB = { lineH: 46, pad: 30, bottom: 36, maxLines: 3 };
export const SUBS_TOP = H - (SUB.maxLines * SUB.lineH + SUB.pad) - SUB.bottom;

async function blurredFill(sharp: any, img: Buffer) {
  return sharp(img).rotate().resize(W, H, { fit: 'cover' }).blur(28).modulate({ brightness: 0.55 }).toBuffer();
}
const initialsCard = (name: string, color: string) => {
  const ini = name.split(/\s+/).filter(Boolean).slice(0, 2).map(p => p[0]?.toUpperCase()).join('') || '?';
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="560" height="560"><rect width="560" height="560" rx="40" fill="${color}"/><text x="280" y="330" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="200" fill="#fff">${esc(ini)}</text></svg>`);
};

/**
 * Fundos de cada plano (sem legendas). As fotografias usadas são apenas as autorizadas; nunca se gera a aparência de ninguém.
 * Nos grandes planos o nome já não fica fixo: aparece no rodapé animado quando a pessoa fala pela primeira vez (graphics.ts).
 */
export async function renderBases(opts: {
  cover: Buffer; title: string; brand: string;
  host: { name: string; role?: string; photo: Buffer | null }; guest: { name: string; role?: string; photo: Buffer | null };
}): Promise<Record<Scene | 'animHost' | 'animGuest', Buffer>> {
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
${([[opts.host, left + P / 2, 'Host'], [opts.guest, left + P + gap + P / 2, 'Guest']] as const).map(([p, cx, r]) => `<text x="${cx}" y="${top + P + 40}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="28" fill="#fff">${esc(p.name)}</text>
<text x="${cx}" y="${top + P + 66}" text-anchor="middle" font-family="${FONT}" font-size="18" fill="#fff" opacity=".8">${esc((p.role || r).slice(0, 40))}</text>`).join('')}
<text x="${W / 2}" y="58" text-anchor="middle" font-family="${FONT}" font-size="26" letter-spacing="4" fill="#fff" opacity=".85">${esc(opts.title.toUpperCase().slice(0, 60))}</text>
<text x="${W - 24}" y="${H - 18}" text-anchor="end" font-family="${FONT}" font-size="16" fill="#fff" opacity=".7">Composite image · asynchronous interview</text></svg>`);
  const studio = await sharp(bg).composite([
    { input: studioSvg },
    { input: await portrait(opts.host, P, '#7a4a1f'), left: Math.round(left), top },
    { input: await portrait(opts.guest, P, '#2f5d6b'), left: Math.round(left + P + gap), top },
  ]).jpeg({ quality: 88 }).toBuffer();

  // Grande plano: fotografia autorizada em altura total sobre o mesmo fundo (o nome entra no rodapé animado).
  const close = async (p: { name: string; photo: Buffer | null }, color: string) => {
    const img = p.photo
      ? await sharp(p.photo).rotate().resize({ height: H, width: Math.round(H * 0.9), fit: 'cover', position: 'attention' }).toBuffer()
      : await sharp(initialsCard(p.name, color)).resize(H - 160, H - 160).toBuffer();
    const meta = await sharp(img).metadata();
    return sharp(bg).composite([{ input: img, left: Math.round((W - (meta.width ?? 0)) / 2), top: Math.round((H - (meta.height ?? 0)) / 2) }]).jpeg({ quality: 88 }).toBuffer();
  };
  // Fundo para os planos animados: o mesmo enquadramento, sem a fotografia (o clipe animado é sobreposto ao centro).
  const animBase = await sharp(bg).jpeg({ quality: 88 }).toBuffer();
  return { cover, studio, host: await close(opts.host, '#7a4a1f'), guest: await close(opts.guest, '#2f5d6b'), animHost: animBase, animGuest: animBase };
}

export async function subtitleFrame(base: Buffer, text: string): Promise<Buffer> {
  if (!text) return base;
  const { default: sharp } = await import('sharp');
  const lines = wrapLines(text, 52, SUB.maxLines);
  const lh = SUB.lineH, boxH = lines.length * lh + SUB.pad, y0 = H - boxH - SUB.bottom;
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

// ---------------------------------------------------------------------------------------------
// Vídeo por partes: fixas (fotogramas), animadas (clipe por fala) e cartões (fundo em movimento com texto),
// codificadas separadamente com os mesmos parâmetros e depois juntas sem recodificar.

/** Legenda num PNG transparente do tamanho do vídeo (para sobrepor a um clipe). */
export async function subtitleOverlay(text: string): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const lines = wrapLines(text, 52, SUB.maxLines);
  const lh = SUB.lineH, boxH = lines.length * lh + SUB.pad, y0 = H - boxH - SUB.bottom;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${W / 2 - 560}" y="${y0}" width="1120" height="${boxH}" rx="12" fill="#000" opacity=".68"/>
${lines.map((l, i) => `<text x="${W / 2}" y="${y0 + 46 + i * lh}" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="36" fill="#fff">${esc(l)}</text>`).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Aviso «AI-animated portrait» (ou o do Veo) e legenda numa única imagem transparente. */
export async function animatedOverlay(text: string, notice = 'AI-animated portrait'): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const layers: any[] = [{ input: await animatedNotice(notice) }];
  if (text) layers.push({ input: await subtitleOverlay(text) });
  return sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer();
}

/** Aviso visível obrigatório sobre os planos animados (canto superior direito; o nome entra no rodapé animado). */
export async function animatedNotice(label = 'AI-animated portrait'): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const bw = Math.max(336, Math.round(label.length * 11.5) + 48);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect x="${W - 36 - bw}" y="36" width="${bw}" height="44" rx="8" fill="#000" opacity=".6"/>
<text x="${W - 36 - bw / 2}" y="65" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="20" fill="#fff">${esc(label)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/**
 * Grafismo sobre a imagem (rodapé com nome e função, título de capítulo): PNG com transparência, colocado em (x, y),
 * que entra com fade e deslize a partir da esquerda e sai com fade. Tempos absolutos na linha temporal do vídeo.
 */
export interface Overlay { startMs: number; endMs: number; x: number; y: number; png: Buffer }
/**
 * Cartão (título no início, agradecimento no fim): fundo em movimento lento (recorte que desliza sobre a capa desfocada,
 * maior do que o vídeo, e um brilho que a atravessa) e camadas de texto, recortadas ao seu tamanho e colocadas em (x, y),
 * que entram com fade e uma pequena subida.
 */
export interface Card { bg: Buffer; glow: Buffer; layers: { png: Buffer; x: number; y: number; inMs: number; rise?: number }[] }

export type Part =
  | { kind: 'still'; startMs: number; endMs: number; shots: Shot[] }
  | { kind: 'anim'; startMs: number; endMs: number; base: Buffer; clip: Buffer | (() => Promise<Buffer>); clipOffsetMs?: number; notice?: string; cues: { startMs: number; endMs: number; text: string }[] }
  | { kind: 'card'; startMs: number; endMs: number; card: Card };

/** Fundo dos cartões: imagem de CARD_BG, recortada a W×H numa posição que muda a cada fotograma (expressões do FFmpeg 4.1). */
export const CARD_BG = { w: 1600, h: 900, glow: 640 };
const PAN_X = '160+140*sin(2*PI*t/11)', PAN_Y = '90+76*sin(2*PI*t/13+1)';
const GLOW_X = '-160+170*t', GLOW_Y = '-70+40*sin(t)';
const GFX_SLIDE = 36; // píxeis do deslize do grafismo

let encoderCache: string[] | null = null;
async function videoEncoder(ffmpeg: string): Promise<string[]> {
  if (encoderCache) return encoderCache;
  const r = await run(ffmpeg, ['-hide_banner', '-h', 'encoder=libx264'], 30_000).catch(() => ({ code: 1, stderr: '' }));
  encoderCache = r.code === 0 && !/Unknown encoder/i.test(r.stderr)
    // Sem imagens B (-bf 0): pedaços de 1–2 fotogramas e pedaços longos ficam com os mesmos tempos e juntam-se sem desvio.
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-bf', '0', '-pix_fmt', 'yuv420p', '-r', '25']
    : ['-c:v', 'mpeg4', '-q:v', '4', '-pix_fmt', 'yuv420p', '-r', '25'];
  return encoderCache;
}

/** Divide a linha temporal: os intervalos animados substituem os fotogramas fixos desse período. */
export function splitParts(anims: { startMs: number; endMs: number }[], totalMs: number): { kind: 'still' | 'anim'; startMs: number; endMs: number; animIndex?: number }[] {
  const out: { kind: 'still' | 'anim'; startMs: number; endMs: number; animIndex?: number }[] = [];
  let t = 0;
  const sorted = anims.map((a, i) => ({ ...a, i })).sort((a, b) => a.startMs - b.startMs);
  for (const a of sorted) {
    if (a.startMs > t) out.push({ kind: 'still', startMs: t, endMs: a.startMs });
    out.push({ kind: 'anim', startMs: Math.max(a.startMs, t), endMs: a.endMs, animIndex: a.i });
    t = a.endMs;
  }
  if (t < totalMs) out.push({ kind: 'still', startMs: t, endMs: totalMs });
  return out.filter(p => p.endMs - p.startMs >= 40);
}

/** Recorta os planos fixos ao intervalo [a, b). */
export function shotsWithin(shots: Shot[], a: number, b: number): Shot[] {
  return shots.filter(s => s.endMs > a && s.startMs < b).map(s => ({ ...s, startMs: Math.max(s.startMs, a), endMs: Math.min(s.endMs, b) }));
}

/**
 * Grafismo gravado à parte, uma só vez (PNG em MOV, com transparência e a animação já aplicada): cada pedaço do vídeo
 * usa o troço que lhe cabe (-ss), mesmo quando o grafismo atravessa vários pedaços (legendas, partes animadas).
 */
async function bakeOverlay(ffmpeg: string, dir: string, i: number, o: Overlay): Promise<string> {
  const png = join(dir, `gfx${i}.png`), out = join(dir, `gfx${i}.mov`);
  await writeFile(png, o.png);
  const n = Math.max(1, Math.round((o.endMs - o.startMs) / 40)), d = n * 0.04, f = Math.min(0.4, d / 4), S = GFX_SLIDE;
  // Deslize: recorte a mover-se sobre o PNG alargado à direita com transparência (o crop aceita 't' a cada fotograma).
  const g = `[0:v]format=rgba,pad=iw+${S}:ih:0:0:color=black@0,crop=iw-${S}:ih:x='${S}*pow(max(0,1-t/0.5),2)':y=0,fade=t=in:st=0:d=${f.toFixed(3)}:alpha=1,fade=t=out:st=${(d - f).toFixed(3)}:d=${f.toFixed(3)}:alpha=1[o]`;
  const r = await run(ffmpeg, ['-y', '-v', 'error', '-loop', '1', '-framerate', '25', '-i', png, '-filter_complex', g, '-map', '[o]', '-frames:v', String(n), '-c:v', 'png', '-pix_fmt', 'rgba', '-f', 'mov', out], 120_000);
  if (r.code !== 0) throw new Error('Falha a preparar o grafismo: ' + r.stderr.slice(-300));
  return out;
}

/** Cartão com o fundo em movimento: uma só chamada ao FFmpeg, com o fundo, o brilho e as camadas de texto. */
async function encodeCard(ffmpeg: string, enc: string[], dir: string, p: number, card: Card, n: number, out: string) {
  const bg = join(dir, `card${p}.jpg`), glow = join(dir, `glow${p}.png`);
  await writeFile(bg, card.bg); await writeFile(glow, card.glow);
  const loop = (f: string) => ['-loop', '1', '-framerate', '25', '-i', f];
  const ins = [...loop(bg), ...loop(glow)];
  const g = [`[0:v]crop=${W}:${H}:x='${PAN_X}':y='${PAN_Y}',setsar=1,format=yuv420p[b0]`, '[1:v]format=rgba[gl]', `[b0][gl]overlay=x='${GLOW_X}':y='${GLOW_Y}'[b1]`];
  let cur = 'b1';
  for (const [k, l] of card.layers.entries()) {
    const f = join(dir, `card${p}_${k}.png`);
    await writeFile(f, l.png);
    ins.push(...loop(f));
    const st = (l.inMs / 1000).toFixed(3);
    g.push(`[${k + 2}:v]format=rgba,fade=t=in:st=${st}:d=0.6:alpha=1[l${k}]`, `[${cur}][l${k}]overlay=x=${l.x}:y='${l.y}+${l.rise ?? 0}*pow(max(0,1-max(0,t-${st})/0.7),2)'[c${k}]`);
    cur = `c${k}`;
  }
  // Entra e sai pelo preto (o FFmpeg 4.1 não tem xfade): transição suave com os planos vizinhos.
  const d = (n * 40) / 1000;
  g.push(`[${cur}]fade=t=in:st=0:d=0.4,fade=t=out:st=${Math.max(0, d - 0.5).toFixed(3)}:d=0.5,fps=25,format=yuv420p[out]`);
  const r = await run(ffmpeg, ['-y', '-v', 'error', '-threads', '2', ...ins, '-filter_complex', g.join(';'), '-map', '[out]', ...enc, '-threads', '2', '-frames:v', String(n), '-an', out], 600_000);
  if (r.code !== 0) throw new Error('Falha a codificar o cartão: ' + r.stderr.slice(-300));
}

/**
 * Monta o vídeo por partes (fixas, animadas e cartões), codificadas separadamente com os mesmos parâmetros e juntas sem
 * recodificar. O grafismo (`overlays`) corta as partes nos seus limites: só os pedaços com grafismo levam filtros por
 * fotograma; o resto continua a ser codificado a partir de imagens fixas (barato em CPU e memória).
 */
export async function encodeComposite(ffmpeg: string, parts: Part[], frameFor: (s: Shot) => Promise<Buffer>, audio: Buffer, onProgress?: (i: number, n: number) => Promise<void>, audioExt = 'mp3', overlays: Overlay[] = []): Promise<Buffer> {
  const enc = await videoEncoder(ffmpeg);
  return withTemp(async dir => {
    const files: string[] = [];
    let frameNo = 0;
    // Número de fotogramas por arredondamento acumulado sobre o tempo absoluto: a soma bate sempre certo com a linha
    // temporal (o '-t' por pedaço perdia muitas vezes um fotograma no ffmpeg 4.1 e o desvio face ao som acumulava).
    const fr = (ms: number) => Math.round(ms / 40);
    const baked = new Map<Overlay, string>();
    const bakedOf = async (o: Overlay) => { let f = baked.get(o); if (!f) { f = await bakeOverlay(ffmpeg, dir, baked.size, o); baked.set(o, f); } return f; };
    // Os limites do grafismo cortam as partes: dentro de cada pedaço, cada grafismo ou está todo ativo ou não está.
    const cutsIn = (a: number, b: number) => overlays.flatMap(o => [o.startMs, o.endMs]).filter(x => x > a && x < b);
    const activeIn = (a: number, b: number) => overlays.filter(o => o.startMs <= a && b <= o.endMs && fr(o.endMs) > fr(o.startMs));
    /** Sobreposições do grafismo ativo num pedaço que começa em absA: entradas a partir do índice `first`. */
    const gfx = async (from: string, absA: number, act: Overlay[], first: number) => {
      const ins: string[] = [], g: string[] = [];
      let cur = from;
      for (const [k, o] of act.entries()) {
        ins.push('-ss', ((absA - o.startMs) / 1000).toFixed(3), '-i', await bakedOf(o));
        g.push(`[${cur}][${first + k}:v]overlay=${o.x}:${o.y}:eof_action=pass[g${k}]`);
        cur = `g${k}`;
      }
      return { ins, g, cur };
    };
    const joinPieces = async (pieces: string[], out: string, p: number) => {
      const plist = join(dir, `plist${p}.txt`);
      await writeFile(plist, pieces.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
      const r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', plist, '-c', 'copy', out], 300_000);
      if (r.code !== 0) throw new Error('Falha a juntar os pedaços de uma parte: ' + r.stderr.slice(-300));
    };
    let totalFrames = 0;
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p];
      const nFrames = fr(part.endMs) - fr(part.startMs);
      const out = join(dir, `part${String(p).padStart(4, '0')}.mp4`);
      if (nFrames <= 0) continue;
      totalFrames += nFrames;
      if (part.kind === 'card') await encodeCard(ffmpeg, enc, dir, p, part.card, nFrames, out);
      else if (part.kind === 'still') {
        const pts = [...new Set([part.startMs, part.endMs, ...cutsIn(part.startMs, part.endMs)])].sort((x, y) => x - y);
        const pieces: string[] = [];
        for (let k = 0; k + 1 < pts.length; k++) {
          const a = pts[k], b = pts[k + 1], n = fr(b) - fr(a);
          if (n <= 0) continue;
          const lines: string[] = []; let last = '';
          for (const s of shotsWithin(part.shots, a, b)) {
            const f = join(dir, `f${String(frameNo++).padStart(5, '0')}.jpg`);
            await writeFile(f, await frameFor(s));
            lines.push(`file '${f.replace(/\\/g, '/')}'`, `duration ${((s.endMs - s.startMs) / 1000).toFixed(3)}`);
            last = f;
          }
          if (!last) throw new Error('Parte fixa sem fotogramas');
          lines.push(`file '${last.replace(/\\/g, '/')}'`);
          const list = join(dir, `list${p}_${k}.txt`), piece = pts.length === 2 ? out : join(dir, `piece${p}_${k}.mp4`);
          await writeFile(list, lines.join('\n'));
          const act = activeIn(a, b);
          const c = await gfx('b', a, act, 1);
          const filter = act.length ? ['-filter_complex', ['[0:v]fps=25[b]', ...c.g, `[${c.cur}]format=yuv420p[out]`].join(';'), '-map', '[out]'] : ['-vf', 'fps=25,format=yuv420p'];
          const r = await run(ffmpeg, ['-y', '-v', 'error', '-threads', '2', '-f', 'concat', '-safe', '0', '-i', list, ...c.ins, ...filter, ...enc, '-threads', '2', '-frames:v', String(n), '-an', piece], 900_000);
          if (r.code !== 0) throw new Error('Falha a codificar parte fixa: ' + r.stderr.slice(-300));
          pieces.push(piece);
        }
        if (pieces.length !== 1 || pieces[0] !== out) await joinPieces(pieces, out, p);
      } else {
        // Parte animada cortada legenda a legenda (e nos limites do grafismo): cada pedaço tem só as entradas que usa
        // (fundo, clipe cortado, aviso+legenda e o grafismo ativo), para caber nos 512 MB do servidor.
        const base = join(dir, `base${p}.jpg`), clip = join(dir, `clip${p}.mp4`);
        await writeFile(base, part.base); await writeFile(clip, typeof part.clip === 'function' ? await part.clip() : part.clip);
        const off = part.clipOffsetMs ?? 0;
        const len = part.endMs - part.startMs;
        const cuts = new Set<number>([0, len]);
        for (const c of part.cues) { if (c.startMs > 0 && c.startMs < len) cuts.add(c.startMs); if (c.endMs > 0 && c.endMs < len) cuts.add(c.endMs); }
        for (const x of cutsIn(part.startMs, part.endMs)) cuts.add(x - part.startMs);
        const pts = [...cuts].sort((x, y) => x - y);
        const pieces: string[] = [];
        for (let k = 0; k + 1 < pts.length; k++) {
          const a0 = pts[k], a1 = pts[k + 1];
          const n = fr(part.startMs + a1) - fr(part.startMs + a0);
          if (n <= 0) continue;
          const mid = (a0 + a1) / 2;
          const text = part.cues.find(c => mid >= c.startMs && mid < c.endMs)?.text ?? '';
          const over = join(dir, `ov${p}_${k}.png`), piece = join(dir, `piece${p}_${k}.mp4`);
          await writeFile(over, await animatedOverlay(text, part.notice));
          const d = ((n * 40) / 1000).toFixed(3);
          const c = await gfx('v1', part.startMs + a0, activeIn(part.startMs + a0, part.startMs + a1), 3);
          const g = [`[1:v]setpts=PTS-STARTPTS,scale=-2:${H},setsar=1[c]`, `[0:v]scale=${W}:${H},setsar=1[bg]`, '[bg][c]overlay=(W-w)/2:(H-h)/2:eof_action=repeat[v0]', '[v0][2:v]overlay=0:0[v1]', ...c.g, `[${c.cur}]fps=25,format=yuv420p[out]`].join(';');
          const r = await run(ffmpeg, ['-y', '-v', 'error', '-threads', '2', '-loop', '1', '-framerate', '25', '-i', base, '-ss', ((off + a0) / 1000).toFixed(3), '-t', d, '-i', clip, '-loop', '1', '-framerate', '25', '-i', over, ...c.ins,
            '-filter_complex', g, '-map', '[out]', ...enc, '-threads', '2', '-frames:v', String(n), '-an', piece], 600_000);
          if (r.code !== 0) throw new Error('Falha a codificar parte animada: ' + r.stderr.slice(-300));
          pieces.push(piece);
        }
        await joinPieces(pieces, out, p);
      }
      files.push(out);
      if (onProgress) await onProgress(p + 1, parts.length);
    }
    const list = join(dir, 'parts.txt'), a = join(dir, `audio.${audioExt}`), out = join(dir, 'video.mp4');
    await writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    await writeFile(a, audio);
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-i', a, '-map', '0:v', '-map', '1:a', '-c:v', 'copy',
      // AAC já codificado com a duração exata da imagem: copia-se sem '-shortest' (com cópia, cortava ~0,1 s ao som).
      // MP3 (caminho antigo): completa com silêncio e corta à duração exata da imagem (o '-shortest' cortava ~0,1 s ao fim).
      ...(audioExt === 'm4a' ? ['-c:a', 'copy'] : ['-af', 'apad', '-c:a', 'aac', '-b:a', '128k', '-t', ((totalFrames * 40) / 1000).toFixed(3)]), '-movflags', '+faststart', out], 900_000);
    if (r.code !== 0) throw new Error('Falha a juntar as partes do vídeo: ' + r.stderr.slice(-300));
    return readFile(out);
  });
}

/** Extrai um troço do áudio final (para animar exatamente o que se ouve). */
export async function sliceAudio(ffmpeg: string, audio: Buffer, startMs: number, endMs: number): Promise<Buffer> {
  return withTemp(async dir => {
    const i = join(dir, 'in.mp3'), o = join(dir, 'out.mp3');
    await writeFile(i, audio);
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-ss', (startMs / 1000).toFixed(3), '-t', ((endMs - startMs) / 1000).toFixed(3), '-i', i, '-ac', '1', '-b:a', '96k', o], 120_000);
    if (r.code !== 0) throw new Error('Falha a recortar o áudio: ' + r.stderr.slice(-200));
    return readFile(o);
  });
}

/** Clipe "animado" simulado (imagem fixa) — usado em testes (AI_MOCK). */
export async function stillClip(ffmpeg: string, image: Buffer, ms: number): Promise<Buffer> {
  const enc = await videoEncoder(ffmpeg);
  return withTemp(async dir => {
    const i = join(dir, 'p.jpg'), o = join(dir, 'c.mp4');
    await writeFile(i, image);
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-loop', '1', '-t', (ms / 1000).toFixed(3), '-i', i, '-vf', 'scale=512:512,fps=25,format=yuv420p', ...enc, o], 120_000);
    if (r.code !== 0) throw new Error('Falha no clipe simulado: ' + r.stderr.slice(-200));
    return readFile(o);
  });
}

/**
 * Faixa de áudio contínua (AAC em m4a) a partir de troços com duração exata: som de um clipe ou do áudio do episódio
 * (a partir de offsetMs, completado com silêncio se for curto) ou silêncio. Os troços juntam-se em PCM (exato à amostra).
 */
export type AudioPiece = { durMs: number; src?: Buffer | (() => Promise<Buffer>); ext?: string; offsetMs?: number };
export async function buildAudioTrack(ffmpeg: string, pieces: AudioPiece[]): Promise<Buffer> {
  return withTemp(async dir => {
    const files: string[] = [];
    const written = new Map<any, string>();
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i], o = join(dir, `a${String(i).padStart(4, '0')}.wav`), d = (p.durMs / 1000).toFixed(3);
      const silence = ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', d, '-c:a', 'pcm_s16le', o];
      let r = { code: 1, stderr: '' };
      if (p.src) {
        let f = written.get(p.src);
        if (!f) { f = join(dir, `s${i}.${p.ext ?? 'mp3'}`); await writeFile(f, typeof p.src === 'function' ? await p.src() : p.src); written.set(p.src, f); }
        r = await run(ffmpeg, ['-y', '-v', 'error', '-ss', ((p.offsetMs ?? 0) / 1000).toFixed(3), '-i', f, '-vn', '-af', 'apad', '-t', d, '-ar', '44100', '-ac', '2', '-c:a', 'pcm_s16le', o], 120_000);
        if (r.code !== 0) console.error(`[video] troço de áudio ${i} sem som utilizável, fica silêncio: ${r.stderr.slice(-200)}`);
      }
      if (r.code !== 0) { r = await run(ffmpeg, silence, 60_000); if (r.code !== 0) throw new Error('Falha a gerar silêncio: ' + r.stderr.slice(-200)); }
      files.push(o);
    }
    const list = join(dir, 'alist.txt'), wav = join(dir, 'track.wav'), out = join(dir, 'track.m4a');
    await writeFile(list, files.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
    let r = await run(ffmpeg, ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', wav], 300_000);
    if (r.code !== 0) throw new Error('Falha a juntar o áudio: ' + r.stderr.slice(-300));
    // Uma única codificação contínua (não desloca o som); ~1 MB por minuto em vez de ~10 MB em PCM na memória.
    r = await run(ffmpeg, ['-y', '-v', 'error', '-i', wav, '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', out], 600_000);
    if (r.code !== 0) throw new Error('Falha a codificar o áudio: ' + r.stderr.slice(-300));
    return readFile(out);
  });
}

/** Clipe simulado com imagem e som (testes com AI_MOCK, no lugar do Veo). */
export async function mockTalkingClip(ffmpeg: string, image: Buffer, ms: number, vertical = false): Promise<Buffer> {
  const enc = await videoEncoder(ffmpeg);
  return withTemp(async dir => {
    const i = join(dir, 'p.jpg'), o = join(dir, 'c.mp4');
    await writeFile(i, image);
    const r = await run(ffmpeg, ['-y', '-v', 'error', '-loop', '1', '-t', (ms / 1000).toFixed(3), '-i', i, '-f', 'lavfi', '-t', (ms / 1000).toFixed(3), '-i', 'sine=frequency=300:sample_rate=44100',
      '-vf', `scale=${vertical ? '720:1280' : '1280:720'},fps=25,format=yuv420p`, ...enc, '-c:a', 'aac', '-shortest', o], 120_000);
    if (r.code !== 0) throw new Error('Falha no clipe simulado: ' + r.stderr.slice(-200));
    return readFile(o);
  });
}
