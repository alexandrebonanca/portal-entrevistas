import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.ts';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1 };

/** Duração da sessão de quem tem conta (cookie `sid` e linha em `sessions`), em dias; a página de privacidade mostra-a. */
export const SESSION_DAYS = 14;

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

/** Texto de uma linha: espaços seguidos (e quebras) passam a um só, sem espaços nas pontas. */
export const oneSpace = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function sign(value: string) {
  return createHmac('sha256', config.secret).update(value).digest('base64url');
}

/**
 * Email com forma válida. O comprimento confere-se antes da expressão: numa cadeia longa com muitos «.» e «@», o
 * retrocesso dela cresce com o quadrado do tamanho e pára o processo (100 KB, segundos).
 */
export const isEmail = (s: string) => s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
/** Email que pode servir de contacto ou de Reply-To: válido e não um endereço de exemplo (de uma instalação de desenvolvimento). */
export const isRealEmail = (s: string) => isEmail(s) && !/@example\.(com|org|net)$/i.test(s);

/**
 * Limitador em memória (por processo): suficiente para o MVP de uma instância. Cada chave (IP, email, conta) guarda os
 * instantes dentro da janela e o fim da janela do mais recente; deixa de estar em memória quando já não conta: sem
 * instantes na janela sai logo do Map e, se ninguém voltar a usá-la, a limpeza de cada minuto tira-a (a página de
 * privacidade diz que os IP só ficam em memória enquanto contam).
 */
const buckets = new Map<string, { hits: number[]; until: number }>();
/** Instantes de uma chave ainda dentro da janela. */
const live = (key: string, windowMs: number, now: number) => (buckets.get(key)?.hits ?? []).filter(t => now - t < windowMs);
/** Guarda os instantes da chave até ao fim da janela do mais recente; sem nenhum, a chave sai do Map. */
const keep = (key: string, hits: number[], windowMs: number) => {
  if (hits.length) buckets.set(key, { hits, until: Math.max(...hits) + windowMs }); else buckets.delete(key);
};
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now(), hits = live(key, windowMs, now);
  const ok = hits.length < max;
  if (ok) hits.push(now);
  keep(key, hits, windowMs);
  return ok;
}
/** Vários limites de uma vez (por exemplo, a pessoa e o IP): só conta, em todos, quando todos estão dentro do limite. */
export function rateLimitAll(limits: [key: string, max: number, windowMs: number][]) {
  const now = Date.now();
  const lists = limits.map(([key, max, windowMs]) => ({ key, max, windowMs, hits: live(key, windowMs, now) }));
  const ok = !lists.some(l => l.hits.length >= l.max);
  for (const l of lists) { if (ok) l.hits.push(now); keep(l.key, l.hits, l.windowMs); }
  return ok;
}
/** Se ainda há lugar num limite, sem o gastar (para recusar antes de outros limites que gastam). Não guarda nada. */
export function rateRoom(key: string, max: number, windowMs: number) {
  return live(key, windowMs, Date.now()).length < max;
}
/** Tira da memória as chaves cuja janela já acabou (corre sozinha a cada minuto; `now` explícito nos testes). */
export function sweepRateLimits(now = Date.now()) {
  let n = 0;
  for (const [key, b] of buckets) if (b.until <= now) { buckets.delete(key); n++; }
  return n;
}
setInterval(() => sweepRateLimits(), 60_000).unref();
/** Se uma chave ainda está em memória (para os testes). */
export const rateHeld = (key: string) => buckets.has(key);

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
