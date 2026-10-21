import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

export const sha256 = (v: string | Buffer) => createHash('sha256').update(v).digest('hex');
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const slugify = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'episode';

export async function hashPassword(pw: string) {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}
export async function verifyPassword(pw: string, stored: string) {
  const [alg, s, k] = stored.split('$');
  if (alg !== 'scrypt' || !s || !k) return false;
  const key = await scrypt(pw, Buffer.from(s, 'base64'), 32, SCRYPT);
  const expected = Buffer.from(k, 'base64');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function sign(value: string) {
  return createHmac('sha256', config.secret).update(value).digest('base64url');
}

export const isEmail = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 254;

/** Limitador em memória (por processo): suficiente para o MVP de uma instância. */
const buckets = new Map<string, number[]>();
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter(t => now - t < windowMs);
  if (hits.length >= max) { buckets.set(key, hits); return false; }
  hits.push(now); buckets.set(key, hits);
  return true;
}
/** Vários limites de uma vez (por exemplo, a pessoa e o IP): só conta, em todos, quando todos estão dentro do limite. */
export function rateLimitAll(limits: [key: string, max: number, windowMs: number][]) {
  const now = Date.now();
  const lists = limits.map(([key, max, windowMs]) => { const hits = (buckets.get(key) ?? []).filter(t => now - t < windowMs); buckets.set(key, hits); return { hits, max }; });
  if (lists.some(l => l.hits.length >= l.max)) return false;
  for (const l of lists) l.hits.push(now);
  return true;
}

export const fmtDuration = (ms: number | null | undefined) => {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
/** Dia do calendário em Lisboa (AAAA-MM-DD): «hoje» para os prazos é o dia português, não o do UTC. */
export const lisbonDay = (ms = Date.now()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Lisbon', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
/** Soma dias a uma data AAAA-MM-DD (aritmética de calendário, sem fusos). */
export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
export const fmtDate = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleString('pt-PT', { dateStyle: 'short', timeStyle: 'short' }) : '—';
