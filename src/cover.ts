import { escXml } from './lib.ts';

/** Quebra o título em linhas pelo número de caracteres (o texto é desenhado por nós, nunca pelo modelo de imagem). */
export function wrapTitle(title: string, maxChars = 18, maxLines = 5): string[] {
  const words = title.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > maxChars) { lines.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const rest = lines.splice(maxLines - 1).join(' '); lines.push(rest.slice(0, maxChars - 1) + '…'); }
  return lines;
}

/** Diâmetro dos retratos redondos da capa. */
const PORTRAIT = 220;
/**
 * Píxeis máximos de uma fotografia (50 MP, acima das de um telemóvel nas definições habituais): o sharp recusa as maiores
 * pelo cabeçalho, antes de as descodificar. Desde que o envio descodifica cada fotografia (photoDecodes), uma imagem enorme
 * (por exemplo, um PNG pequeno com dimensões gigantes) ocuparia o servidor web; antes, só o trabalho a descodificava.
 */
export const PHOTO_MAX_PIXELS = 50_000_000;
/** Retrato redondo de uma fotografia (rodada pela orientação e recortada); falha se a fotografia não se descodificar. */
async function portrait(sharp: any, photo: Buffer): Promise<Buffer> {
  const d = PORTRAIT;
  const mask = Buffer.from(`<svg width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#fff"/></svg>`);
  return sharp(photo, { limitInputPixels: PHOTO_MAX_PIXELS }).rotate().resize(d, d, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
}

/**
 * A fotografia descodifica-se por inteiro, como na capa, e não passa PHOTO_MAX_PIXELS (o POST /api/g/fotos e o da
 * fotografia do entrevistador recusam as que não). Antes, uma fotografia com a assinatura JPEG e o conteúdo corrompido
 * passava a verificação do formato e só falhava no sharp, dentro do trabalho do episódio, depois de pagas a voz, os tempos
 * das legendas e as traduções, em cada uma das 3 tentativas.
 */
export async function photoDecodes(photo: Buffer): Promise<boolean> {
  const { default: sharp } = await import('sharp');
  return portrait(sharp, photo).then(() => true, () => false);
}

/**
 * Capa e miniatura. O texto vem sem os caracteres que o XML não admite (escXml); uma fotografia que não se descodifica
 * (ou passa PHOTO_MAX_PIXELS) fica de fora (as que já estavam guardadas antes da verificação no envio), e um fundo que não
 * se descodifica dá lugar ao
 * fundo em gradiente: a capa não falha por causa das entradas. `photos`: os índices (em `opts.photos`) das que entraram.
 */
export async function composeCover(opts: {
  title: string; subtitle: string; brand: string; background?: Buffer | null; photos?: Buffer[]; palette?: string[];
}): Promise<{ cover: Buffer; thumb: Buffer; photos: number[] }> {
  const { default: sharp } = await import('sharp');
  const S = 1400;
  const [c1, c2] = [opts.palette?.[0] ?? '#1c1a17', opts.palette?.[1] ?? '#b4691f'];
  const safe = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#1c1a17');
  let base: Buffer | null = opts.background ? await sharp(opts.background).resize(S, S, { fit: 'cover' }).toBuffer().catch(() => null) : null;
  if (!base) {
    base = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${safe(c1)}"/><stop offset="1" stop-color="${safe(c2)}"/></linearGradient></defs><rect width="${S}" height="${S}" fill="url(#g)"/><circle cx="1150" cy="250" r="380" fill="#fff" opacity=".07"/><circle cx="200" cy="1250" r="300" fill="#fff" opacity=".06"/></svg>`)).png().toBuffer();
  }
  const ph: { i: number; img: Buffer }[] = [];
  for (const [i, photo] of (opts.photos ?? []).entries()) {
    if (ph.length === 2) break;
    const img = await portrait(sharp, photo).catch(() => null);
    if (img) ph.push({ i, img });
  }
  const lines = wrapTitle(opts.title);
  const size = lines.length > 3 ? 104 : 124;
  const y0 = 700 - (lines.length - 1) * size * 0.55;
  const text = lines.map((l, i) => `<text x="90" y="${y0 + i * size * 1.1}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="700" font-size="${size}" fill="#fff">${escXml(l)}</text>`).join('');
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".55" stop-color="#000" stop-opacity=".62"/><stop offset="1" stop-color="#000" stop-opacity=".82"/></linearGradient></defs>
<rect width="${S}" height="${S}" fill="url(#s)"/>
<text x="90" y="150" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="40" letter-spacing="8" fill="#fff" opacity=".85">${escXml(opts.brand.toUpperCase())}</text>
${text}
<text x="90" y="${S - (ph.length ? 330 : 110)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="46" fill="#fff" opacity=".92">${escXml(opts.subtitle)}</text></svg>`);
  const layers: any[] = [{ input: overlay }, ...ph.map((p, k) => ({ input: p.img, left: 90 + k * (PORTRAIT + 30), top: S - PORTRAIT - 90 }))];
  const cover = await sharp(base).composite(layers).jpeg({ quality: 88 }).toBuffer();
  const thumb = await sharp(cover).resize(300, 300).jpeg({ quality: 82 }).toBuffer();
  return { cover, thumb, photos: ph.map(p => p.i) };
}
