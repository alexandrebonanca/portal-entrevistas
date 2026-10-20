// Prepara as fotografias licenciadas da landing page: recorta (centrado no que interessa), reduz e comprime.
// Uso: node scripts/photos.ts "<pasta das fotos>" hero=ficheiro.jpg interviewer=... guest=... studio=... listen=... ["credits=Texto dos créditos"]
// Resultado: public/img/photos/<nome>.jpg (1600×1200 o hero, 1200×900 as restantes) e, se indicado, credits.txt.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const SLOTS = new Set(['hero', 'interviewer', 'guest', 'studio', 'listen']);
const [src, ...pairs] = process.argv.slice(2);
if (!src || !pairs.length) { console.error('Uso: node scripts/photos.ts "<pasta>" hero=a.jpg guest=b.jpg ... [credits=texto]'); process.exit(1); }
const { default: sharp } = await import('sharp');
const out = join('public', 'img', 'photos');
await mkdir(out, { recursive: true });
for (const p of pairs) {
  const i = p.indexOf('='); const key = p.slice(0, i), val = p.slice(i + 1).trim();
  if (i < 1 || !val) { console.error(`Argumento inválido: «${p}» (use nome=ficheiro.jpg)`); process.exit(1); }
  if (key === 'credits') { await writeFile(join(out, 'credits.txt'), val); continue; }
  if (!SLOTS.has(key)) { console.error(`Nome desconhecido: ${key} (use ${[...SLOTS].join(', ')} ou credits)`); process.exit(1); }
  const [w, h] = key === 'hero' ? [1600, 1200] : [1200, 900];
  let buf: Buffer;
  try {
    buf = await sharp(join(src, val)).rotate().resize(w, h, { fit: 'cover', position: 'attention' }).flatten({ background: '#f6f2ea' }).jpeg({ quality: 78, progressive: true, mozjpeg: true }).toBuffer();
  } catch (e: any) { console.error(`${key}: não foi possível ler ${join(src, val)} (${e.message})`); process.exit(1); }
  await writeFile(join(out, `${key}.jpg`), buf);
  console.log(`${key}.jpg ← ${val} (${Math.round(buf.length / 1024)} KB)`);
}
