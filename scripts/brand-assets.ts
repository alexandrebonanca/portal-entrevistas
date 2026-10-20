// Gera os ficheiros da marca a partir de src/brand.ts: símbolo em SVG e o PNG usado nos emails.
// Uso: node scripts/brand-assets.ts
import { writeFile, mkdir } from 'node:fs/promises';
import { markSvgFile } from '../src/brand.ts';

const { default: sharp } = await import('sharp');
await mkdir('public/img', { recursive: true });
const svg = markSvgFile();
await writeFile('public/img/mark.svg', svg);
// 3× o tamanho mostrado no email (25×24), com fundo transparente.
await writeFile('public/img/mark-email.png', await sharp(Buffer.from(svg), { density: 288 }).resize(75, 72).png().toBuffer());
console.log('public/img/mark.svg e public/img/mark-email.png gerados');
