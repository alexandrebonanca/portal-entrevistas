import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import type { Db } from './db.ts';

/** Definições introduzidas pelo administrador (chaves de serviços). Cifradas em repouso (AES-256-GCM, chave derivada de APP_SECRET). */
export interface SettingDef { key: string; label: string; group: string; secret: boolean; hint?: string; env?: string }

export const SETTING_DEFS: SettingDef[] = [
  { key: 'OPENAI_API_KEY', label: 'API key', group: 'OpenAI', secret: true, hint: 'sk-…' },
  { key: 'STRIPE_SECRET_KEY', label: 'Secret key', group: 'Stripe', secret: true, hint: 'sk_live_… ou sk_test_…' },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Webhook signing secret', group: 'Stripe', secret: true, hint: 'whsec_…' },
  { key: 'MAILERSEND_API_KEY', label: 'API token', group: 'MailerSend', secret: true },
  { key: 'MAIL_FROM', label: 'Email remetente (domínio verificado)', group: 'MailerSend', secret: false },
  { key: 'MAIL_FROM_NAME', label: 'Nome do remetente', group: 'MailerSend', secret: false },
  { key: 'REPLICATE_API_TOKEN', label: 'API token', group: 'Replicate', secret: true, hint: 'r8_…' },
  { key: 'REPLICATE_LIPSYNC_MODEL', label: 'Modelo de sincronização labial', group: 'Replicate', secret: false, hint: 'cjwbw/sadtalker' },
  { key: 'MOLONI_CLIENT_ID', label: 'Client ID (developer id)', group: 'Moloni ON', secret: false },
  { key: 'MOLONI_CLIENT_SECRET', label: 'Client secret', group: 'Moloni ON', secret: true },
  { key: 'MOLONI_USERNAME', label: 'Utilizador', group: 'Moloni ON', secret: false },
  { key: 'MOLONI_PASSWORD', label: 'Palavra-passe', group: 'Moloni ON', secret: true },
  { key: 'MOLONI_COMPANY_ID', label: 'ID da empresa', group: 'Moloni ON', secret: false },
];

const cache = new Map<string, string>();
const entityCache = new Map<string, Map<string, string>>();
/** Entidade em contexto: dentro de inEntity(), as chaves da entidade têm prioridade sobre as globais. */
const als = new AsyncLocalStorage<string | null>();
export const inEntity = <T>(entityId: string | null | undefined, fn: () => T): T => als.run(entityId ?? null, fn);

const aesKey = () => createHash('sha256').update('settings:' + config.secret).digest();

export function encrypt(plain: string) {
  const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map(b => b.toString('base64')).join('.');
}
export function decrypt(blob: string): string | null {
  try {
    const [iv, tag, enc] = blob.split('.').map(p => Buffer.from(p, 'base64'));
    const d = createDecipheriv('aes-256-gcm', aesKey(), iv); d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch { return null; } // APP_SECRET alterado: trata como não definido
}

export async function loadSettings(db: Db) {
  cache.clear(); entityCache.clear();
  for (const r of await db.query('SELECT key, value_enc FROM settings')) {
    const v = decrypt(r.value_enc);
    if (v !== null) cache.set(r.key, v);
  }
  for (const r of await db.query('SELECT entity_id, key, value_enc FROM entity_settings')) {
    const v = decrypt(r.value_enc);
    if (v === null) continue;
    if (!entityCache.has(r.entity_id)) entityCache.set(r.entity_id, new Map());
    entityCache.get(r.entity_id)!.set(r.key, v);
  }
}

/** Entidade a que pertence o utilizador / a entrevista (para escolher as chaves certas). */
export const entityOfUser = async (db: Db, userId: string) => (await db.one('SELECT entity_id FROM users WHERE id=$1', [userId]))?.entity_id as string | null | undefined;
export const entityOfInterview = async (db: Db, interviewId: string) =>
  (await db.one('SELECT u.entity_id FROM interviews i JOIN users u ON u.id=i.owner_id WHERE i.id=$1', [interviewId]))?.entity_id as string | null | undefined;

export async function saveEntitySetting(db: Db, entityId: string, key: string, value: string) {
  if (!SETTING_DEFS.some(d => d.key === key)) throw new Error('Definição desconhecida');
  if (!value) { await db.query('DELETE FROM entity_settings WHERE entity_id=$1 AND key=$2', [entityId, key]); entityCache.get(entityId)?.delete(key); return; }
  await db.query(`INSERT INTO entity_settings(entity_id, key, value_enc) VALUES ($1,$2,$3) ON CONFLICT (entity_id, key) DO UPDATE SET value_enc=$3, updated_at=now()`, [entityId, key, encrypt(value)]);
  if (!entityCache.has(entityId)) entityCache.set(entityId, new Map());
  entityCache.get(entityId)!.set(key, value);
}
export const entityHas = (entityId: string, key: string) => entityCache.get(entityId)?.has(key) ?? false;
export const entityValue = (entityId: string, key: string) => entityCache.get(entityId)?.get(key) ?? '';

/** Valor da definição (base de dados) ou, se não existir, da variável de ambiente com o mesmo nome. */
export const S = (key: string): string => {
  const e = als.getStore();
  return (e ? entityCache.get(e)?.get(key) : undefined) ?? cache.get(key) ?? process.env[key] ?? '';
};
export const isSet = (key: string) => !!S(key);
export const fromDb = (key: string) => cache.has(key);

export async function saveSetting(db: Db, key: string, value: string) {
  if (!SETTING_DEFS.some(d => d.key === key) && key !== 'SIGNUPS_OPEN') throw new Error('Definição desconhecida');
  if (!value) {
    await db.query('DELETE FROM settings WHERE key=$1', [key]); cache.delete(key); return;
  }
  await db.query(`INSERT INTO settings(key, value_enc) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value_enc=$2, updated_at=now()`, [key, encrypt(value)]);
  cache.set(key, value);
}

/** Mostra só o fim de um segredo; o valor completo nunca volta ao browser. */
export const mask = (v: string) => (v ? '••••••••' + v.slice(-4) : '');
