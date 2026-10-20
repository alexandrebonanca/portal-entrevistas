// Prepara as fotografias licenciadas da landing page: recorta (centrado no que interessa), reduz e comprime.
// Uso: node scripts/photos.ts "<pasta das fotos>" hero=ficheiro.jpg interviewer=... guest=... studio=... listen=... ["credits=Texto dos créditos"]
//      O corte procura o que interessa na imagem; para o fixar, acrescente @north, @south, @east, @west ou @centre ao ficheiro (ex.: interviewer=foto.jpg@north).
// Resultado: public/img/photos/<nome>.jpg (1600×1200 o hero, 1200×900 as restantes) e, se indicado, credits.txt.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';

const SLOTS = new Set(['hero', 'interviewer', 'guest', 'studio', 'listen']);
const [src, ...pairs] = process.argv.slice(2);
if (!src || !pairs.length) { console.error('Uso: node scripts/photos.ts "<pasta>" hero=a.jpg guest=b.jpg ... [credits=texto]'); process.exit(1); }
if (!existsSync(src) || !statSync(src).isDirectory()) { console.error(`Pasta não encontrada: ${src}`); process.exit(1); }
const { default: sharp } = await import('sharp');
// Valida e prepara tudo antes de escrever (um erro a meio não deixa a pasta pela metade).
let credits: string | null = null;
const ready: [string, Buffer, string][] = [];
for (const p of pairs) {
  const i = p.indexOf('='); const key = p.slice(0, i), val = p.slice(i + 1).trim();
  if (i < 1 || !val) { console.error(`Argumento inválido: «${p}» (use nome=ficheiro.jpg)`); process.exit(1); }
  if (key === 'credits') { credits = val; continue; }
  if (!SLOTS.has(key)) { console.error(`Nome desconhecido: ${key} (use ${[...SLOTS].join(', ')} ou credits)`); process.exit(1); }
  const [w, h] = key === 'hero' ? [1600, 1200] : [1200, 900];
  const m = /^(.*?)(?:@(north|south|east|west|centre|center))?$/.exec(val)!;
  const file = m[1], position = m[2] ? (m[2] === 'center' ? 'centre' : m[2]) : 'attention';
  try {
    ready.push([key, await sharp(join(src, file)).rotate().resize(w, h, { fit: 'cover', position }).flatten({ background: '#f6f2ea' }).jpeg({ quality: 78, progressive: true, mozjpeg: true }).toBuffer(), val]);
  } catch (e: any) { console.error(`${key}: não foi possível ler ${join(src, file)} (${e.message})`); process.exit(1); }
}
const out = join('public', 'img', 'photos');
await mkdir(out, { recursive: true });
for (const [key, buf, val] of ready) {
  await writeFile(join(out, `${key}.jpg`), buf);
  console.log(`${key}.jpg ← ${val} (${Math.round(buf.length / 1024)} KB)`);
}
if (credits !== null) await writeFile(join(out, 'credits.txt'), credits);
