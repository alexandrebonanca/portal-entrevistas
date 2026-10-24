import { inflateRawSync } from 'node:zlib';
import { sniff } from './media.ts';

/**
 * Texto de uma resposta escrita: documento Word (.docx) ou texto simples (.txt). Sem dependências: o .docx é um ZIP e só
 * se lê o documento principal (word/document.xml), com tetos a cada passo (ficheiro, entradas, XML descomprimido), para
 * um ZIP malicioso (bomba de compressão, ZIP64, cifrado, desvios fora do ficheiro) não gastar memória nem tempo.
 */
export const DOC_MAX_BYTES = 2 * 1024 * 1024;
/** Teto do XML descomprimido: um documento de ~1 000 palavras tem dezenas de KB; o resto é formatação. */
export const DOC_MAX_XML = 8 * 1024 * 1024;
const MAX_ENTRIES = 2000;
const MAX_RELS = 64 * 1024;

export type DocErrorCode = 'format' | 'empty' | 'tooBig';
export class DocError extends Error {
  code: DocErrorCode;
  constructor(code: DocErrorCode, msg?: string) { super(msg ?? code); this.code = code; }
}

export interface AnswerText { text: string; words: number; format: 'docx' | 'txt' }

export const countWords = (s: string) => (s.match(/\S+/g) ?? []).length;

export function extractAnswerText(buf: Buffer): AnswerText {
  if (!Buffer.isBuffer(buf) || !buf.length) throw new DocError('empty');
  if (buf.length > DOC_MAX_BYTES) throw new DocError('tooBig');
  const format = buf.subarray(0, 2).toString('latin1') === 'PK' ? 'docx' : 'txt';
  const text = normalize(format === 'docx' ? docxText(buf) : plainText(buf));
  const words = countWords(text);
  if (!words) throw new DocError('empty');
  return { text, words, format };
}

// ---- ZIP ----
function findEocd(b: Buffer) {
  const stop = Math.max(0, b.length - 22 - 0xffff);
  for (let i = b.length - 22; i >= stop; i--) if (b.readUInt32LE(i) === 0x06054b50) return i;
  return -1;
}

interface Entry { name: string; method: number; flags: number; csize: number; usize: number; local: number }
function entries(b: Buffer): Entry[] {
  const e = findEocd(b);
  if (e < 0) throw new DocError('format', 'ZIP sem diretório central');
  const n = b.readUInt16LE(e + 10), size = b.readUInt32LE(e + 12), off = b.readUInt32LE(e + 16);
  if (n === 0xffff || size === 0xffffffff || off === 0xffffffff) throw new DocError('format', 'ZIP64 não suportado');
  if (n > MAX_ENTRIES || off + size > e) throw new DocError('format', 'diretório central inválido');
  const out: Entry[] = [];
  let p = off;
  for (let i = 0; i < n; i++) {
    if (p + 46 > e || b.readUInt32LE(p) !== 0x02014b50) throw new DocError('format', 'entrada do diretório inválida');
    const nl = b.readUInt16LE(p + 28), xl = b.readUInt16LE(p + 30), cl = b.readUInt16LE(p + 32);
    if (p + 46 + nl > e) throw new DocError('format', 'nome fora do diretório');
    out.push({ flags: b.readUInt16LE(p + 8), method: b.readUInt16LE(p + 10), csize: b.readUInt32LE(p + 20), usize: b.readUInt32LE(p + 24), local: b.readUInt32LE(p + 42), name: b.toString('utf8', p + 46, p + 46 + nl) });
    p += 46 + nl + xl + cl;
  }
  return out;
}

function read(b: Buffer, en: Entry, max = DOC_MAX_XML): Buffer {
  if (en.flags & 1) throw new DocError('format', 'documento cifrado');
  if (en.usize > max) throw new DocError('tooBig');
  const l = en.local;
  if (l + 30 > b.length || b.readUInt32LE(l) !== 0x04034b50) throw new DocError('format', 'cabeçalho local inválido');
  const start = l + 30 + b.readUInt16LE(l + 26) + b.readUInt16LE(l + 28);
  if (start + en.csize > b.length) throw new DocError('format', 'dados fora do ficheiro');
  const data = b.subarray(start, start + en.csize);
  if (en.method === 0) { if (data.length > max) throw new DocError('tooBig'); return data; }
  if (en.method !== 8) throw new DocError('format', 'compressão não suportada');
  try { return inflateRawSync(data, { maxOutputLength: max }); } // o tamanho declarado pode mentir: o teto é do zlib
  catch (e: any) { throw new DocError(e?.code === 'ERR_BUFFER_TOO_LARGE' || e instanceof RangeError ? 'tooBig' : 'format', 'descompressão falhou'); }
}

function docxText(b: Buffer): string {
  const byName = new Map(entries(b).map(x => [x.name, x]));
  // Documento principal: o indicado em _rels/.rels (officeDocument); por omissão, word/document.xml.
  let main = 'word/document.xml';
  const rels = byName.get('_rels/.rels');
  if (rels) {
    for (const m of read(b, rels, MAX_RELS).toString('utf8').matchAll(/<Relationship\b[^<>]*>/g)) {
      const tgt = m[0].includes('/officeDocument"') && /\bTarget="([^"<>]+)"/.exec(m[0])?.[1];
      if (tgt) { main = tgt.replace(/^\/+/, ''); break; }
    }
  }
  const doc = byName.get(main);
  if (!doc || !/\.xml$/i.test(main)) throw new DocError('format', 'sem documento Word');
  return wordXmlText(read(b, doc).toString('utf8'));
}

/** Texto de WordprocessingML: só <w:t> (o apagado com revisões, <w:delText>, fica de fora), parágrafos, quebras e tabulações. */
export function wordXmlText(xml: string): string {
  // As caixas de texto vêm duas vezes (mc:Choice e mc:Fallback): fica só a primeira.
  xml = dropBlocks(xml, '<mc:Fallback', '</mc:Fallback>');
  // [^<>]: nenhuma procura atravessa a etiqueta seguinte, por isso o custo é linear mesmo com XML malformado.
  const re = /<w:t(?:\s[^<>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:(?:br|cr)\b[^<>]*\/>|<w:tab\b[^<>]*\/>/g;
  let out = '';
  for (let m; (m = re.exec(xml));) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0] === '</w:p>') out += '\n';
    else if (m[0].startsWith('<w:tab')) out += ' ';
    else out += '\n';
  }
  return out;
}

function dropBlocks(s: string, open: string, close: string) {
  let out = '', i = 0;
  for (let a; (a = s.indexOf(open, i)) >= 0;) {
    const z = s.indexOf(close, a);
    if (z < 0) break;
    out += s.slice(i, a); i = z + close.length;
  }
  return out + s.slice(i);
}

const decodeXml = (s: string) => s.replace(/&(lt|gt|amp|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi, (_, e: string) => {
  const k = e.toLowerCase();
  if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'amp') return '&'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
  const cp = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
});

// ---- texto simples ----
function plainText(b: Buffer): string {
  let s: string;
  // UTF-16 com BOM antes do sniff (FF FE parece MP3).
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) s = new TextDecoder(b[0] === 0xff ? 'utf-16le' : 'utf-16be').decode(b);
  else {
    // Outros formatos conhecidos (áudio, imagem, PDF, .doc antigo, RTF) não passam por texto.
    const head = b.subarray(0, 8).toString('latin1');
    if (sniff(b) || head.startsWith('%PDF') || head.startsWith('{\\rtf') || head.startsWith('\xd0\xcf\x11\xe0')) throw new DocError('format');
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(b); } // retira o BOM
    catch { s = new TextDecoder('windows-1252').decode(b); }
  }
  if (s.includes('\u0000') || (s.match(/[\u0001-\u0008\u000e-\u001f]/g)?.length ?? 0) > 8) throw new DocError('format', 'binário');
  return s;
}

/** Linhas limpas: sem caracteres de controlo nem invisíveis, sem espaços seguidos nem mais de uma linha em branco. */
function normalize(s: string) {
  return s.normalize('NFC').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f​﻿]/g, '').replace(/[\t  ]+/g, ' ')
    .split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
