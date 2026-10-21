import { config } from './config.ts';
import { esc } from './lib.ts';
import { markSvgFile } from './brand.ts';
import { wrapTitle } from './cover.ts';
import { W, H, FONT, SUBS_TOP, CARD_BG, wrapLines, shotsWithin, type Card, type Overlay, type Part, type AudioPiece } from './video.ts';

/**
 * Grafismo do vídeo, sem IA e sem custo por entrevista (todos os planos): cartão de título a seguir ao aviso inicial,
 * rodapé com o nome e a função de cada pessoa quando fala pela primeira vez no seu plano, título de capítulo em cada
 * pergunta e cartão final. O texto é desenhado por nós (sharp, as mesmas fontes das legendas) e animado pelo FFmpeg 4.1
 * (fade e deslize, sem xfade nem tpad), nos episódios só com fotografias e nos animados. Os nomes só aparecem em texto
 * (nunca são ditos pelo Veo).
 */

export const TITLE_CARD_MS = 4000, END_CARD_MS = 4000;
export const LOWER_MS = 5000, LOWER_DELAY_MS = 400, LOWER_MIN_MS = 1600;
export const CHAPTER_MS = 4800, CHAPTER_DELAY_MS = 200, CHAPTER_MIN_MS = 1200;
export const LOWER_H = 104, GFX_X = 40, CHAPTER_Y = 36;
/** Rodapé: acima da zona das legendas gravadas (a caixa de 3 linhas, a maior) ou, num vídeo sem legendas, junto ao fundo. */
export const lowerY = (subtitles: boolean) => (subtitles ? SUBS_TOP - 20 - LOWER_H : H - 56 - LOWER_H);
const EDITORIAL = ['disclosure', 'editorial_intro', 'editorial_outro'];
const COPPER = '#b4691f', COPPER_LIGHT = '#e3a868', INK = '#1c1a17';
const snap = (ms: number) => Math.round(ms / 40) * 40; // 25 fps: grafismo em fotogramas inteiros

/** Texto curto (pergunta no título de capítulo, nomes): corta numa palavra e acaba em reticências. */
export function shortText(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1), sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.!?…-]+$/, '') + '…';
}

export interface People { host: { name: string; role: string }; guest: { name: string; role: string } }
/** Nome e função no vídeo (em inglês, como o episódio): a função escrita pelo entrevistador ou «Host»/«Guest». */
export const peopleOf = (iv: any): People => ({
  host: { name: String(iv.host_name ?? '').trim(), role: String(iv.host_title ?? '').trim() || 'Host' },
  guest: { name: String(iv.guest_name ?? '').trim(), role: String(iv.guest_title ?? '').trim() || 'Guest' },
});

/** Fala no vídeo (tempos do vídeo): `personShot` quando aparece só quem fala (grande plano ou clipe animado). */
export interface GfxSpan { id: string; role: 'host' | 'guest'; kind: string; startMs: number; endMs: number; personShot: boolean }
export interface GfxPlan { lowers: { role: 'host' | 'guest'; startMs: number; endMs: number }[]; chapters: { n: number; text: string; startMs: number; endMs: number }[] }

/** Título de cada pergunta (capítulos do episódio, ligados às falas pelo início no áudio do episódio). */
export function chapterTitles(timing: { id: string; kind: string; startMs: number }[], chapters: { startMs: number; title: string }[] | null | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of timing) {
    if (t.kind !== 'translated_question') continue;
    const c = (chapters ?? []).find(x => x.startMs === t.startMs);
    if (c?.title) out.set(t.id, c.title);
  }
  return out;
}

/**
 * Onde entra o grafismo (tempos do vídeo, em fotogramas inteiros): o rodapé de cada pessoa na primeira fala em que
 * aparece no seu plano (a composição de estúdio já mostra os dois nomes), sem passar o fim dessa fala (nunca fica por
 * cima de outra pessoa); o título de capítulo no início de cada pergunta, até pouco antes do capítulo seguinte.
 */
export function planGraphics(spans: GfxSpan[], chapterOf: (id: string) => string | null | undefined, endMs: number): GfxPlan {
  const lowers: GfxPlan['lowers'] = [];
  for (const role of ['host', 'guest'] as const) {
    for (const s of spans) {
      if (s.role !== role || !s.personShot || s.kind === 'disclosure') continue;
      const a = snap(s.startMs + LOWER_DELAY_MS), b = snap(Math.min(s.startMs + LOWER_DELAY_MS + LOWER_MS, s.endMs - 120, endMs));
      if (b - a >= LOWER_MIN_MS) { lowers.push({ role, startMs: a, endMs: b }); break; }
    }
  }
  const qs = spans.filter(s => chapterOf(s.id));
  const chapters = qs.map((s, i) => {
    const a = snap(s.startMs + CHAPTER_DELAY_MS), b = snap(Math.min(a + CHAPTER_MS, (qs[i + 1]?.startMs ?? endMs) - 200, endMs));
    return { n: i + 1, text: shortText(chapterOf(s.id)!, 64), startMs: a, endMs: b };
  }).filter(c => c.endMs - c.startMs >= CHAPTER_MIN_MS);
  return { lowers, chapters };
}

// ---- imagens do grafismo (sharp) ----

/**
 * Largura real (px) de uma linha de texto desenhada com as fontes do servidor (as mesmas do grafismo): desenha-a numa tela
 * larga e mede o que ficou desenhado. A estimativa por carácter cortava o texto em maiúsculas ou com siglas.
 */
export async function textWidth(text: string, size: number, weight: number | 'normal' = 'normal', letterSpacing = 0): Promise<number> {
  if (!text.trim()) return 0;
  const { default: sharp } = await import('sharp');
  const pad = 10, cw = Math.ceil(text.length * size * (1 + letterSpacing / size) * 1.1) + pad * 2 + 20, ch = Math.ceil(size * 1.8);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cw}" height="${ch}"><text x="${pad}" y="${Math.round(size * 1.25)}" font-family="${FONT}" font-weight="${weight}" font-size="${size}"${letterSpacing ? ` letter-spacing="${letterSpacing}"` : ''} fill="#fff">${esc(text)}</text></svg>`;
  try {
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const { info } = await sharp(png).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
    return Math.max(0, Math.abs(info.trimOffsetLeft ?? 0) + info.width - pad);
  } catch { return Math.ceil(text.length * size * 0.62); } // nada desenhado: estimativa larga
}
/** Texto que cabe em `max` px (medido): o original, ou cortado numa palavra com reticências até caber. */
async function fitText(text: string, max: number, size: number, weight: number | 'normal' = 'normal'): Promise<{ text: string; w: number }> {
  let t = text, w = await textWidth(t, size, weight);
  for (let len = text.length; w > max && len > 4;) {
    len = Math.max(4, len - Math.max(1, Math.ceil(len * 0.08)));
    t = shortText(text, len);
    w = await textWidth(t, size, weight);
  }
  return { text: t, w };
}
/** Margem à direita do texto, dentro da caixa do grafismo. */
const GFX_RIGHT_PAD = 36;

/** Rodapé: nome e função numa caixa escura com a barra cobre da marca (largura medida no texto desenhado). */
export async function lowerThirdPng(name: string, role: string): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  // Letra próxima da das legendas (36 px): legível num telemóvel.
  const MAX_W = 760, X = 32, room = MAX_W - X - GFX_RIGHT_PAD;
  const n = await fitText(shortText(name, 30), room, 36, 700), r = await fitText(shortText(role, 44), room, 24);
  const w = Math.round(Math.min(MAX_W, Math.max(320, Math.max(n.w, r.w) + X + GFX_RIGHT_PAD)));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${LOWER_H}"><rect width="${w}" height="${LOWER_H}" rx="10" fill="${INK}" fill-opacity=".86"/><rect width="8" height="${LOWER_H}" rx="4" fill="${COPPER}"/>
<text x="${X}" y="48" font-family="${FONT}" font-weight="700" font-size="36" fill="#fff">${esc(n.text)}</text><text x="${X}" y="86" font-family="${FONT}" font-size="24" fill="${COPPER_LIGHT}">${esc(r.text)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Título de capítulo: «QUESTION n» e o texto curto da pergunta (até 2 linhas), no canto superior esquerdo. */
export async function chapterPng(n: number, text: string): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  const MAX_W = 780, X = 30, room = MAX_W - X - GFX_RIGHT_PAD;
  const lines: string[] = [];
  let widest = await textWidth(`QUESTION ${n}`, 18, 700, 2);
  for (const l of wrapLines(text, 34, 2)) { const f = await fitText(l, room, 30, 600); lines.push(f.text); widest = Math.max(widest, f.w); }
  const w = Math.round(Math.min(MAX_W, Math.max(320, widest + X + GFX_RIGHT_PAD)));
  const h = 66 + lines.length * 38;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" rx="10" fill="${INK}" fill-opacity=".8"/><rect width="${w}" height="6" rx="3" fill="${COPPER}"/>
<text x="30" y="42" font-family="${FONT}" font-weight="700" font-size="18" letter-spacing="2" fill="${COPPER_LIGHT}">QUESTION ${n}</text>
${lines.map((l, i) => `<text x="30" y="${82 + i * 38}" font-family="${FONT}" font-weight="600" font-size="30" fill="#fff">${esc(l)}</text>`).join('')}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** Fundo dos cartões: a capa do episódio desfocada, maior do que o vídeo (para deslizar), com um véu escuro; e o brilho cobre. */
export async function cardBackground(cover: Buffer): Promise<{ bg: Buffer; glow: Buffer }> {
  const { default: sharp } = await import('sharp');
  const { w, h, glow: G } = CARD_BG;
  const veil = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".3"/><stop offset="1" stop-color="#000" stop-opacity=".58"/></linearGradient>
<linearGradient id="c" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="${COPPER}" stop-opacity=".22"/><stop offset=".6" stop-color="${COPPER}" stop-opacity="0"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#v)"/><rect width="${w}" height="${h}" fill="url(#c)"/></svg>`);
  const bg = await sharp(cover).rotate().resize(w, h, { fit: 'cover' }).blur(30).modulate({ brightness: 0.62 }).composite([{ input: veil }]).jpeg({ quality: 86 }).toBuffer();
  const glow = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${G}" height="${G}"><defs><radialGradient id="g"><stop offset="0" stop-color="${COPPER_LIGHT}" stop-opacity=".42"/><stop offset=".55" stop-color="${COPPER}" stop-opacity=".16"/><stop offset="1" stop-color="${COPPER}" stop-opacity="0"/></radialGradient></defs><circle cx="${G / 2}" cy="${G / 2}" r="${G / 2}" fill="url(#g)"/></svg>`)).png().toBuffer();
  return { bg, glow };
}

/** Símbolo e nome da marca centrados em (cx, y), para os cartões (fundo escuro: «quiet» cobre claro, «interview» branco). */
const brandSvg = (cy: number, size: number) => {
  const b = config.brand, two = /^quietinterview$/i.test(b);
  const markH = Math.round(size * 1.15), markW = Math.round(markH * 80 / 76), gap = Math.round(size * 0.35);
  const textW = Math.round(b.length * size * 0.6), x0 = Math.round((W - (markW + gap + textW)) / 2);
  return `<g transform="translate(${x0} ${cy - markH / 2}) scale(${markH / 76})">${markSvgFile(COPPER, '#fffdf8')}</g>
<text x="${x0 + markW + gap}" y="${cy + size * 0.36}" font-family="${FONT}" font-weight="700" font-size="${size}">${two ? `<tspan fill="${COPPER_LIGHT}">quiet</tspan><tspan fill="#fff">interview</tspan>` : `<tspan fill="#fff">${esc(b)}</tspan>`}</text>`;
};
/** Camada de texto do cartão recortada ao que tem desenhado (menos píxeis a misturar em cada fotograma) e a sua posição. */
const layer = async (inner: string): Promise<{ png: Buffer; x: number; y: number }> => {
  const { default: sharp } = await import('sharp');
  const full = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${inner}</svg>`)).png().toBuffer();
  try {
    const { data, info } = await sharp(full).trim({ threshold: 1 }).png().toBuffer({ resolveWithObject: true });
    return { png: data, x: Math.abs(info.trimOffsetLeft ?? 0), y: Math.abs(info.trimOffsetTop ?? 0) };
  } catch { return { png: full, x: 0, y: 0 }; } // nada a recortar
};

/** Cartão de título: marca, título do episódio e «with <convidado>», a entrar por esta ordem. */
export async function titleCard(bgs: { bg: Buffer; glow: Buffer }, title: string, guest: string): Promise<Card> {
  const lines = wrapTitle(title, 26, 3), size = lines.length > 2 ? 52 : 60, lh = Math.round(size * 1.2);
  const y0 = Math.round(330 - ((lines.length - 1) * lh) / 2);
  const after = y0 + (lines.length - 1) * lh;
  return { ...bgs, layers: [
    { ...await layer(brandSvg(118, 30)), inMs: 200, rise: 12 },
    { ...await layer(lines.map((l, i) => `<text x="${W / 2}" y="${y0 + i * lh}" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${size}" fill="#fff">${esc(l)}</text>`).join('')), inMs: 500, rise: 28 },
    ...(guest ? [{ ...await layer(`<rect x="${W / 2 - 50}" y="${after + 40}" width="100" height="4" rx="2" fill="${COPPER}"/><text x="${W / 2}" y="${after + 100}" text-anchor="middle" font-family="${FONT}" font-size="34" fill="#fff" opacity=".92">with ${esc(shortText(guest, 44))}</text>`), inMs: 1100, rise: 18 }] : []),
  ] };
}

/** Cartão final: agradecimento, marca e endereço do site. */
export async function endCard(bgs: { bg: Buffer; glow: Buffer }): Promise<Card> {
  return { ...bgs, layers: [
    { ...await layer(`<text x="${W / 2}" y="250" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="46" fill="#fff">Thank you for watching</text>`), inMs: 200, rise: 20 },
    { ...await layer(brandSvg(372, 54)), inMs: 700, rise: 16 },
    { ...await layer(`<text x="${W / 2}" y="470" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="32" fill="${COPPER_LIGHT}">${esc(config.brandSite)}</text>`), inMs: 1100, rise: 12 },
  ] };
}

/** Rodapés e títulos de capítulo como grafismo para o encodeComposite (sem nome, não há rodapé dessa pessoa). */
export async function graphicsOverlays(plan: GfxPlan, people: People, subtitles: boolean): Promise<Overlay[]> {
  const out: Overlay[] = [];
  for (const l of plan.lowers) if (people[l.role].name) out.push({ startMs: l.startMs, endMs: l.endMs, x: GFX_X, y: lowerY(subtitles), png: await lowerThirdPng(people[l.role].name, people[l.role].role) });
  for (const c of plan.chapters) out.push({ startMs: c.startMs, endMs: c.endMs, x: GFX_X, y: CHAPTER_Y, png: await chapterPng(c.n, c.text) });
  return out;
}
export const graphicsMeta = (overlays: Overlay[], plan: GfxPlan) => ({ titleCard: true, endCard: true, lowerThirds: overlays.length - plan.chapters.length, chapters: plan.chapters.length });

/**
 * Cartões na linha temporal do vídeo só com fotografias (ou com retratos animados): o de título entra em `at` (a seguir
 * ao aviso inicial; se calhar dentro de uma parte animada, antes dela) e o final depois da última parte. O que vem
 * depois de `at` desliza a duração do cartão (as legendas das partes animadas são relativas à parte e não mudam).
 */
export function insertCards(parts: Part[], at: number, title: Card, end: Card): { parts: Part[]; at: number } {
  const T = TITLE_CARD_MS;
  at = parts.find(p => p.kind !== 'still' && p.startMs < at && p.endMs > at)?.startMs ?? at;
  const shift = (p: Part): Part => (p.kind === 'still'
    ? { ...p, startMs: p.startMs + T, endMs: p.endMs + T, shots: p.shots.map(s => ({ ...s, startMs: s.startMs + T, endMs: s.endMs + T })) }
    : { ...p, startMs: p.startMs + T, endMs: p.endMs + T });
  const out: Part[] = [];
  const card: Part = { kind: 'card', startMs: at, endMs: at + T, card: title };
  let done = false;
  for (const p of parts) {
    if (!done && p.kind === 'still' && p.startMs < at && p.endMs > at) {
      out.push({ ...p, endMs: at, shots: shotsWithin(p.shots, p.startMs, at) }, card, shift({ ...p, startMs: at, shots: shotsWithin(p.shots, at, p.endMs) }));
      done = true;
      continue;
    }
    if (!done && p.startMs >= at) { out.push(card); done = true; }
    out.push(done ? shift(p) : p);
  }
  if (!done) out.push(card);
  const last = out[out.length - 1].endMs;
  out.push({ kind: 'card', startMs: last, endMs: last + END_CARD_MS, card: end });
  return { parts: out, at };
}

/**
 * Vídeo só com fotografias (ou com retratos animados): partes no tempo do episódio → linha temporal do vídeo com os
 * cartões, o som (o do episódio, com silêncio nos cartões) e o grafismo. Usado pelo trabalho e pela medição.
 */
export async function photoTimeline(o: {
  parts: Part[]; timing: { id: string; role: 'host' | 'guest'; kind: string; startMs: number; durationMs: number }[]; durationMs: number; audio: Buffer;
  cover: Buffer; title: string; people: People; chapters: { startMs: number; title: string }[] | null | undefined; animated: Set<string>; subtitles: boolean;
}) {
  const T = TITLE_CARD_MS, epEnd = snap(o.durationMs);
  const iDisc = o.timing.findIndex(t => t.kind === 'disclosure');
  const bgs = await cardBackground(o.cover);
  const ins = insertCards(o.parts, snap(iDisc >= 0 ? (o.timing[iDisc + 1]?.startMs ?? o.durationMs) : 0), await titleCard(bgs, o.title, o.people.guest.name), await endCard(bgs));
  const at = ins.at;
  const vs = (ms: number) => (ms >= at ? ms + T : ms), ve = (ms: number) => (ms > at ? ms + T : ms);
  const spans: GfxSpan[] = o.timing.map((t, i) => ({ id: t.id, role: t.role, kind: t.kind, startMs: vs(t.startMs), endMs: ve(i + 1 < o.timing.length ? o.timing[i + 1].startMs : o.durationMs),
    personShot: o.animated.has(t.id) || !EDITORIAL.includes(t.kind) }));
  const chap = chapterTitles(o.timing, o.chapters);
  const plan = planGraphics(spans, id => chap.get(id), epEnd + T);
  const overlays = await graphicsOverlays(plan, o.people, o.subtitles);
  const audio: AudioPiece[] = ([{ durMs: at, src: o.audio, ext: 'mp3', offsetMs: 0 }, { durMs: T }, { durMs: epEnd - at, src: o.audio, ext: 'mp3', offsetMs: at }, { durMs: END_CARD_MS }] as AudioPiece[]).filter(x => x.durMs > 0);
  return { parts: ins.parts, audio, overlays, totalMs: epEnd + T + END_CARD_MS, meta: graphicsMeta(overlays, plan) };
}
