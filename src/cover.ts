import { esc } from './lib.ts';

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

export async function composeCover(opts: {
  title: string; subtitle: string; brand: string; background?: Buffer | null; photos?: Buffer[]; palette?: string[];
}): Promise<{ cover: Buffer; thumb: Buffer }> {
  const { default: sharp } = await import('sharp');
  const S = 1400;
  const [c1, c2] = [opts.palette?.[0] ?? '#1c1a17', opts.palette?.[1] ?? '#b4691f'];
  const safe = (c: string) => (/^#[0-9a-f]{6}$/i.test(c) ? c : '#1c1a17');
  let base: Buffer;
  if (opts.background) {
    base = await sharp(opts.background).resize(S, S, { fit: 'cover' }).toBuffer();
  } else {
    base = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${safe(c1)}"/><stop offset="1" stop-color="${safe(c2)}"/></linearGradient></defs><rect width="${S}" height="${S}" fill="url(#g)"/><circle cx="1150" cy="250" r="380" fill="#fff" opacity=".07"/><circle cx="200" cy="1250" r="300" fill="#fff" opacity=".06"/></svg>`)).png().toBuffer();
  }
  const lines = wrapTitle(opts.title);
  const size = lines.length > 3 ? 104 : 124;
  const y0 = 700 - (lines.length - 1) * size * 0.55;
  const text = lines.map((l, i) => `<text x="90" y="${y0 + i * size * 1.1}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-weight="700" font-size="${size}" fill="#fff">${esc(l)}</text>`).join('');
  const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}">
<defs><linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity=".25"/><stop offset=".55" stop-color="#000" stop-opacity=".62"/><stop offset="1" stop-color="#000" stop-opacity=".82"/></linearGradient></defs>
<rect width="${S}" height="${S}" fill="url(#s)"/>
<text x="90" y="150" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="40" letter-spacing="8" fill="#fff" opacity=".85">${esc(opts.brand.toUpperCase())}</text>
${text}
<text x="90" y="${S - (opts.photos?.length ? 330 : 110)}" font-family="DejaVu Sans, Arial, sans-serif" font-size="46" fill="#fff" opacity=".92">${esc(opts.subtitle)}</text></svg>`);
  const layers: any[] = [{ input: overlay }];
  const ph = (opts.photos ?? []).slice(0, 2);
  for (let i = 0; i < ph.length; i++) {
    const d = 220;
    const mask = Buffer.from(`<svg width="${d}" height="${d}"><circle cx="${d / 2}" cy="${d / 2}" r="${d / 2}" fill="#fff"/></svg>`);
    const img = await sharp(ph[i]).rotate().resize(d, d, { fit: 'cover' }).composite([{ input: mask, blend: 'dest-in' }]).png().toBuffer();
    layers.push({ input: img, left: 90 + i * (d + 30), top: S - d - 90 });
  }
  const cover = await sharp(base).composite(layers).jpeg({ quality: 88 }).toBuffer();
  const thumb = await sharp(cover).resize(300, 300).jpeg({ quality: 82 }).toBuffer();
  return { cover, thumb };
}
