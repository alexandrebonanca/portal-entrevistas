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
  { key: 'MOLONI_CLIENT_ID', label: 'Client ID (developer id)', group: 'Moloni ON', secret: false },
  { key: 'MOLONI_CLIENT_SECRET', label: 'Client secret', group: 'Moloni ON', secret: true },
  { key: 'MOLONI_USERNAME', label: 'Utilizador', group: 'Moloni ON', secret: false },
  { key: 'MOLONI_PASSWORD', label: 'Palavra-passe', group: 'Moloni ON', secret: true },
  { key: 'MOLONI_COMPANY_ID', label: 'ID da empresa', group: 'Moloni ON', secret: false },
];

const cache = new Map<string, string>();
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
  cache.clear();
  for (const r of await db.query('SELECT key, value_enc FROM settings')) {
    const v = decrypt(r.value_enc);
    if (v !== null) cache.set(r.key, v);
  }
}

/** Valor da definição (base de dados) ou, se não existir, da variável de ambiente com o mesmo nome. */
export const S = (key: string): string => cache.get(key) ?? process.env[key] ?? '';
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
