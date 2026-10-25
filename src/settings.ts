import { AsyncLocalStorage } from 'node:async_hooks';
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes } from 'node:crypto';
import { config } from './config.ts';
import type { Db } from './db.ts';
import { isEmail, isRealEmail } from './lib.ts';
import { EU_COUNTRIES, countryName, normNif } from './vat.ts';

/**
 * Definições introduzidas pelo administrador (chaves de serviços). Cifradas em repouso (AES-256-GCM, chave derivada de APP_SECRET).
 * default: valor usado enquanto nada for guardado (só nas definições globais).
 */
export interface SettingDef { key: string; label: string; group: string; secret: boolean; hint?: string; env?: string; options?: [string, string][]; default?: string }
/** Empresa que vende ao cliente final (a dona da conta Stripe e do Moloni): identificação, IVA e reclamações. Nunca se inventa. */
export const SELLER_GROUP = 'Empresa vendedora';

export const SETTING_DEFS: SettingDef[] = [
  { key: 'OPENAI_API_KEY', label: 'API key', group: 'OpenAI', secret: true, hint: 'sk-…' },
  { key: 'STRIPE_SECRET_KEY', label: 'Secret key', group: 'Stripe', secret: true, hint: 'sk_live_… ou sk_test_…' },
  { key: 'STRIPE_WEBHOOK_SECRET', label: 'Webhook signing secret', group: 'Stripe', secret: true, hint: 'whsec_…' },
  { key: 'MAILERSEND_API_KEY', label: 'API token', group: 'MailerSend', secret: true },
  { key: 'MAIL_FROM', label: 'Email remetente (domínio verificado)', group: 'MailerSend', secret: false },
  { key: 'MAIL_FROM_NAME', label: 'Nome do remetente', group: 'MailerSend', secret: false },
  { key: 'REPLICATE_API_TOKEN', label: 'API token', group: 'Replicate', secret: true, hint: 'r8_…' },
  { key: 'REPLICATE_LIPSYNC_MODEL', label: 'Modelo de sincronização labial', group: 'Replicate', secret: false, hint: 'cjwbw/sadtalker' },
  { key: 'FAL_KEY', label: 'API key', group: 'fal.ai', secret: true, hint: 'chave da fal.ai' },
  { key: 'WAVESPEED_API_KEY', label: 'API key (HeyGen Avatar IV)', group: 'WaveSpeed', secret: true },
  { key: 'HEYGEN_API_KEY', label: 'API key (platform.heygen.com → Chaves de API; saldo pré-pago em Cobrança)', group: 'HeyGen', secret: true },
  { key: 'VERTEX_SA_JSON', label: 'Conta de serviço do Vertex AI (JSON)', group: 'Google', secret: true, hint: 'cole aqui o ficheiro .json da chave da conta de serviço' },
  { key: 'VERTEX_LOCATION', label: 'Região do Vertex AI', group: 'Google', secret: false, hint: 'us-central1' },
  { key: 'VEO_TIER', label: 'Modelo do Google Veo', group: 'Google', secret: false, options: [['fast', 'Veo 3.1 Fast (~$0,10/s)'], ['lite', 'Veo 3.1 Lite (~$0,05/s, metade do preço)']] },
  { key: 'GEMINI_API_KEY', label: 'Gemini API key (reserva enquanto a Google a mantiver)', group: 'Google', secret: true, hint: 'AIza…' },
  { key: 'MOLONI_CLIENT_ID', label: 'Client ID (developer id)', group: 'Moloni ON', secret: false },
  { key: 'MOLONI_CLIENT_SECRET', label: 'Client secret', group: 'Moloni ON', secret: true },
  { key: 'MOLONI_USERNAME', label: 'Utilizador', group: 'Moloni ON', secret: false },
  { key: 'MOLONI_PASSWORD', label: 'Palavra-passe', group: 'Moloni ON', secret: true },
  { key: 'MOLONI_COMPANY_ID', label: 'ID da empresa', group: 'Moloni ON', secret: false },
  // Por omissão os dados da Telecert Consultoria Lda dados pelo dono (config.seller: denominação, NIF, morada e Livro de
  // Reclamações), em Portugal e registada para IVA; o email de contacto é o da entidade gestora (config.owner) até se
  // indicar o da vendedora (as Definições avisam). Apagar um campo volta ao valor por omissão.
  { key: 'SELLER_TRADE_NAME', label: 'Nome comercial', group: SELLER_GROUP, secret: false, default: 'Telecert' },
  { key: 'SELLER_NAME', label: 'Denominação social completa', group: SELLER_GROUP, secret: false, hint: 'como no registo comercial', default: config.seller.name },
  { key: 'SELLER_NIF', label: 'NIF', group: SELLER_GROUP, secret: false, hint: '9 algarismos', default: config.seller.vat.replace(/^PT/i, '') },
  { key: 'SELLER_ADDRESS', label: 'Morada da sede', group: SELLER_GROUP, secret: false, hint: 'rua, n.º, código postal e localidade', default: config.seller.address },
  { key: 'SELLER_COUNTRY', label: 'País da sede', group: SELLER_GROUP, secret: false, default: 'PT', options: EU_COUNTRIES.map(c => [c, `${countryName(c)} (${c})`] as [string, string]) },
  { key: 'SELLER_VAT_REGIME', label: 'Regime de IVA', group: SELLER_GROUP, secret: false, default: 'registered', options: [['registered', 'Registada para IVA (liquida IVA nas vendas)'], ['not_registered', 'Não registada para IVA']] },
  // (o endereço de exemplo de uma instalação de desenvolvimento nunca serve de contacto legal; o SUPPORT_EMAIL também não)
  { key: 'SELLER_EMAIL', label: 'Email de contacto (e reclamações)', group: SELLER_GROUP, secret: false, default: isRealEmail(config.owner.email) ? config.owner.email : undefined },
  { key: 'SELLER_COMPLAINTS_URL', label: 'Ligação do Livro de Reclamações Eletrónico', group: SELLER_GROUP, secret: false, hint: 'https://www.livroreclamacoes.pt/…', default: config.seller.complaintsUrl },
  { key: 'SELLER_ADR', label: 'Entidade de resolução alternativa de litígios (opcional)', group: SELLER_GROUP, secret: false, hint: 'nome e sítio da entidade RAL' },
  { key: 'OSS_ACTIVE', label: 'Balcão único (OSS)', group: SELLER_GROUP, secret: false, options: [['', 'Desligado: consumidores de outros países da UE pagam o IVA português (abaixo de 10 000 €/ano)'], ['1', 'Ligado: consumidores de outros países da UE pagam o IVA do seu país']] },
];
/** Dados sem os quais não se vende a ninguém; os de SELLER_CONSUMER_KEYS fazem falta só para vender a consumidores. */
export const SELLER_CORE_KEYS = ['SELLER_NAME', 'SELLER_NIF', 'SELLER_ADDRESS'] as const;
export const SELLER_CONSUMER_KEYS = ['SELLER_EMAIL', 'SELLER_COMPLAINTS_URL'] as const;
/** Definições internas (fora do formulário): interruptores, as taxas de IVA criadas na Stripe e o nome da conta Stripe. */
const INTERNAL_KEYS = ['SIGNUPS_OPEN', 'STRIPE_TAX_RATES', 'STRIPE_ACCOUNT'];

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

/**
 * Limpa o que vem colado à volta de uma chave: espaços e quebras de linha, aspas, prefixos de código
 * («FAL_KEY=», «export …=», «Authorization:», «Key », «Bearer »). Não altera o conteúdo da chave em si.
 */
export function cleanSecret(raw: string): string {
  let v = String(raw ?? '').replace(/[\r\n\t]/g, ' ').trim();
  v = v.replace(/^export\s+/i, '');
  v = v.replace(/^[A-Z][A-Z0-9]*_[A-Z0-9_]*\s*[=:]\s*/, ''); // FAL_KEY=…, OPENAI_API_KEY: … (nome de variável com «_»)
  v = v.replace(/^authorization\s*:\s*/i, '');
  v = v.replace(/^(key|bearer)\s+/i, '');
  v = v.replace(/^["'`]+|["'`;,]+$/g, '').trim();
  // fal.ai: «ID SEGREDO» (copiados em separado) → «ID:SEGREDO», o formato que a fal.ai aceita.
  const m = /^(fal_sk_[A-Za-z0-9_-]+)\s+(?:secret\s*[:=]?\s*)?([A-Za-z0-9_-]{8,})$/i.exec(v);
  if (m) v = `${m[1]}:${m[2]}`;
  return v;
}

/** Só chaves/tokens de API são limpos; palavras-passe (ex.: Moloni) e o JSON da conta de serviço ficam como foram escritos. */
export const isApiKey = (key: string) => !!SETTING_DEFS.find(d => d.key === key)?.secret && !/PASSWORD/i.test(key) && key !== 'VERTEX_SA_JSON';

/** Valor recusado ao guardar (mensagem para o ecrã; nunca inclui o valor). */
export class SettingError extends Error {}

/** Conta de serviço da Google (só os campos usados para obter o token). */
export interface ServiceAccount { type: 'service_account'; project_id: string; private_key_id?: string; private_key: string; client_email: string }

/**
 * Forma do texto recebido, para explicar porque não é o ficheiro da chave sem nunca mostrar o conteúdo
 * (só o tamanho, se começa e acaba em chaveta, se os nomes dos campos aparecem e o tipo de chave reconhecido).
 */
function saShape(s: string) {
  const yn = (b: boolean) => (b ? 'sim' : 'não');
  const facts = `recebidos ${s.length} caracteres; começa por «{»: ${yn(s.startsWith('{'))}; termina em «}»: ${yn(s.endsWith('}'))}; tem "private_key": ${yn(s.includes('"private_key"'))}; tem "client_email": ${yn(s.includes('"client_email"'))}`;
  const howTo = 'Para o Vertex é preciso o ficheiro JSON da conta de serviço: na Google Cloud, IAM → Contas de serviço → a conta → Chaves → Adicionar chave → Criar nova chave → JSON.';
  const hint = (s.match(/"type"\s*:/g) ?? []).length > 1 ? 'Parece ter sido colado mais do que uma vez: apague o campo e cole uma só vez.'
    : /^AIza[0-9A-Za-z_-]{20,}$/.test(s) ? `Isto é uma chave de API da Google (começa por «AIza»), não o ficheiro da conta de serviço; se for da Gemini API, vai no campo «Gemini API key». ${howTo}`
    : /^AQ\.[0-9A-Za-z_.-]{10,}$/.test(s) ? `Isto é uma chave de API do Vertex AI em modo express (começa por «AQ.»), que não serve aqui. ${howTo}`
    : /^-----BEGIN/.test(s) ? 'Foi colada só a chave privada: é preciso o ficheiro .json inteiro.'
    : s.length < 1000 ? `O texto é curto demais para ser o ficheiro da chave (tem cerca de 2300 caracteres): pode ser uma chave de API, uma palavra-passe preenchida pelo browser ou só uma parte do ficheiro. ${howTo}`
    : !s.startsWith('{') || !s.endsWith('}') ? 'Falta o início ou o fim do ficheiro: copie-o todo (Ctrl+A e Ctrl+C no editor).'
    : 'O texto foi alterado (por exemplo, aberto e guardado num processador de texto).';
  return `${facts}. ${hint} Use «Escolher o ficheiro .json» para o ler diretamente do computador.`;
}

/**
 * Valida o JSON da chave de uma conta de serviço. As mensagens nunca citam o texto colado: a do JSON.parse pode incluir
 * parte dele (a chave privada), por isso é descartada.
 */
export function parseServiceAccount(raw: string): ServiceAccount {
  // Marca BOM, caracteres invisíveis, espaços não separáveis e aspas tipográficas (de editores de texto) não fazem parte de um ficheiro da Google.
  const text = String(raw ?? '').replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/\u00A0/g, ' ').replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"').trim();
  let j: any;
  try { j = JSON.parse(text); } catch { throw new SettingError(`A conta de serviço não é um JSON válido (${saShape(text)})`); }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new SettingError('A conta de serviço não é um JSON válido: cole o ficheiro .json completo.');
  if (j.type !== undefined && j.type !== 'service_account') throw new SettingError(`O JSON colado não é a chave de uma conta de serviço${/^[a-z_]{1,30}$/.test(String(j.type)) ? ` (type «${j.type}»)` : ''}: crie uma chave JSON na conta de serviço.`);
  const missing = ['client_email', 'private_key', 'project_id'].filter(k => typeof j[k] !== 'string' || !j[k].trim());
  if (missing.length) throw new SettingError(`Faltam campos na conta de serviço: ${missing.join(', ')}.`);
  if (!/^[^@\s"]+@[^@\s"]+\.[a-z]{2,}$/i.test(j.client_email)) throw new SettingError('O client_email da conta de serviço não é válido.');
  // O projeto entra no caminho dos pedidos: só letras minúsculas, algarismos e hífenes (com o prefixo de domínio antigo).
  if (!/^(?:[a-z0-9.-]+:)?[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(j.project_id)) throw new SettingError('O project_id da conta de serviço não é válido.');
  try { if (createPrivateKey(j.private_key).asymmetricKeyType !== 'rsa') throw new Error(); }
  catch { throw new SettingError('A private_key da conta de serviço não é uma chave RSA válida: crie uma chave JSON nova e cole o ficheiro completo.'); }
  const kid = typeof j.private_key_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(j.private_key_id) ? j.private_key_id : undefined;
  return { type: 'service_account', project_id: j.project_id, ...(kid ? { private_key_id: kid } : {}), private_key: j.private_key, client_email: j.client_email };
}

/** Região do Vertex AI (entra no nome do servidor: só o formato «us-central1»). */
export const isVertexLocation = (v: string) => /^[a-z]+-[a-z]+\d{1,2}$/.test(v);

/** Valor a guardar: limpo e validado (lança SettingError com uma mensagem clara). */
export function prepareSetting(key: string, value: string): string {
  if (!value) return value;
  if (key === 'VERTEX_SA_JSON') return JSON.stringify(parseServiceAccount(value)); // só os campos necessários
  if (key === 'VERTEX_LOCATION') {
    const v = value.trim().toLowerCase();
    if (!isVertexLocation(v)) throw new SettingError('Região do Vertex AI inválida (ex.: us-central1).');
    return v;
  }
  if (key === 'SELLER_NIF') {
    const v = value.toUpperCase().replace(/[\s.\-/]/g, '');
    const digits = v.replace(/^PT/, '');
    // NIF português (com dígito de controlo); um vendedor de outro país usa o número de IVA sem o prefixo.
    if (/^\d{9}$/.test(digits)) { if (!normNif(digits)) throw new SettingError('NIF da empresa vendedora inválido (o dígito de controlo não confere).'); return digits; }
    if (!/^[A-Z0-9]{2,14}$/.test(v)) throw new SettingError('NIF da empresa vendedora inválido.');
    return v;
  }
  if (key === 'SELLER_EMAIL' && !isEmail(value.trim())) throw new SettingError('Email da empresa vendedora inválido.');
  if (key === 'SELLER_EMAIL' && isSupportEmail(value)) throw new SettingError('O email de apoio interno (SUPPORT_EMAIL) não se mostra ao público: indique o email da empresa vendedora.');
  if (key === 'SELLER_COMPLAINTS_URL' && !/^https:\/\/[^\s<>"]+$/i.test(value.trim())) throw new SettingError('A ligação do Livro de Reclamações Eletrónico tem de começar por https://.');
  const def = SETTING_DEFS.find(d => d.key === key);
  if (def?.options && !def.options.some(o => o[0] === value)) throw new SettingError(`Valor inválido em «${def.label}».`);
  if (key.startsWith('SELLER_')) return value.replace(/\s+/g, ' ').trim().slice(0, 300);
  return isApiKey(key) ? cleanSecret(value) : value;
}

/** Primeiro valor inválido de um formulário de definições (null = tudo válido); nada é guardado se houver um. */
export function settingsFormError(body: any, defs: SettingDef[] = SETTING_DEFS): string | null {
  for (const d of defs) {
    const v = typeof body?.[d.key] === 'string' ? body[d.key].trim() : '';
    if (!v || v === '-') continue;
    try { prepareSetting(d.key, v); } catch (e: any) { if (e instanceof SettingError) return e.message; throw e; }
  }
  return null;
}

/** Retrato não secreto de uma chave guardada (para comparar com o painel do fornecedor). */
export function secretFingerprint(v: string) {
  if (!v) return 'nenhuma chave guardada';
  const prefix = (/^[a-z]+_[a-z]+_/i.exec(v)?.[0] ?? v.slice(0, 3)).slice(0, 8);
  const odd = /\s/.test(v) ? ' · contém espaços (provável colagem dupla)' : '';
  const cut = /[^!-~]/.test(v.replace(/\s/g, '')) ? ' · contém caracteres especiais (ex.: «…») — foi copiada de uma vista abreviada, não da chave completa' : '';
  return `${v.length} caracteres, começa por «${prefix}», termina em «…${v.slice(-4)}»${odd}${cut}`;
}

export async function saveEntitySetting(db: Db, entityId: string, key: string, value: string) {
  if (!SETTING_DEFS.some(d => d.key === key) && !INTERNAL_KEYS.includes(key)) throw new Error('Definição desconhecida');
  value = prepareSetting(key, value);
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

/** Credenciais do Google Veo: valem em conjunto (ver scopedS). */
export const VEO_CRED_KEYS = ['VERTEX_SA_JSON', 'GEMINI_API_KEY'] as const;
export const currentEntity = () => als.getStore() ?? null;
/** A entidade tem alguma destas definições própria? */
export const ownsAny = (entityId: string | null | undefined, keys: readonly string[]) => !!entityId && keys.some(k => !!entityCache.get(entityId)?.get(k));
/**
 * Definições que só valem em conjunto (as credenciais de um mesmo serviço): se a entidade em contexto tiver alguma delas,
 * usam-se só as dela; senão as globais. Uma credencial global nunca passa à frente de outra da entidade (ex.: a conta de
 * serviço global não substitui a chave Gemini da entidade, o que poria o Veo dela a pagar no projeto do dono).
 */
export const scopedS = (keys: readonly string[], key: string): string => {
  const e = als.getStore();
  return ownsAny(e, keys) ? (entityCache.get(e!)!.get(key) ?? '') : (cache.get(key) ?? process.env[key] ?? '');
};
/** Definição de um âmbito fixo ('global' ou o id de uma entidade), sem recorrer ao outro: o de uma operação já criada. */
export const scopeS = (scope: string, key: string): string => (scope === 'global' ? (cache.get(key) ?? process.env[key] ?? '') : entityValue(scope, key));

export async function saveSetting(db: Db, key: string, value: string) {
  if (!SETTING_DEFS.some(d => d.key === key) && !INTERNAL_KEYS.includes(key)) throw new Error('Definição desconhecida');
  value = prepareSetting(key, value);
  if (!value) {
    await db.query('DELETE FROM settings WHERE key=$1', [key]); cache.delete(key); return;
  }
  await db.query(`INSERT INTO settings(key, value_enc) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value_enc=$2, updated_at=now()`, [key, encrypt(value)]);
  cache.set(key, value);
}

/**
 * Conta Stripe em contexto: a da entidade, se tiver chave própria; senão a global (null).
 * O que pertence à conta Stripe (empresa que vende, taxas de IVA criadas, nome da conta) segue esta escolha e nunca se mistura.
 */
export const stripeScope = (): string | null => { const e = als.getStore() ?? null; return ownsAny(e, ['STRIPE_SECRET_KEY']) ? e : null; };
/**
 * É o SUPPORT_EMAIL (configuração interna, o email pessoal do dono)? Nunca se mostra a utilizadores, convidados ou
 * visitantes, nem como email da vendedora.
 */
export const isSupportEmail = (v: string) => !!v.trim() && v.trim().toLowerCase() === config.supportEmail.trim().toLowerCase();
/** Email da vendedora guardado (ou numa variável de ambiente) igual ao SUPPORT_EMAIL: era a omissão antiga, gravada pelo formulário. */
export const sellerEmailIsSupport = () => { const e = stripeScope(); return isSupportEmail(e ? entityValue(e, 'SELLER_EMAIL') : (cache.get('SELLER_EMAIL') ?? process.env.SELLER_EMAIL ?? '')); };

/**
 * Dados da empresa vendedora: com Stripe própria só os da entidade; sem ela os globais, com os valores por omissão.
 * Um email igual ao SUPPORT_EMAIL (o valor por omissão antigo, que o formulário das Definições gravava) é ignorado: fica o
 * valor por omissão (o email da entidade gestora) ou, numa entidade com Stripe própria, nenhum.
 */
export const sellerS = (key: string): string => {
  const e = stripeScope();
  const def = SETTING_DEFS.find(d => d.key === key)?.default ?? '';
  const v = e ? entityValue(e, key) : (cache.get(key) ?? process.env[key] ?? def);
  if (key === 'SELLER_EMAIL' && isSupportEmail(v)) return e ? '' : def;
  return v;
};
/** Valor e gravação de uma definição interna na conta Stripe em contexto. */
export const stripeScopedValue = (key: string) => { const e = stripeScope(); return e ? entityValue(e, key) : (cache.get(key) ?? ''); };
export const saveStripeScoped = async (db: Db, key: string, value: string) => { const e = stripeScope(); return e ? saveEntitySetting(db, e, key, value) : saveSetting(db, key, value); };


/** Mostra só o fim de um segredo; o valor completo nunca volta ao browser. */
export const mask = (v: string) => (v ? '••••••••' + v.slice(-4) : '');
/** Como mask, mas a conta de serviço aparece pela identidade (email e projeto), nunca pela chave. */
export function maskSetting(key: string, v: string) {
  if (key !== 'VERTEX_SA_JSON' || !v) return mask(v);
  try { const sa = parseServiceAccount(v); return `guardada: ${sa.client_email} · projeto ${sa.project_id}`; } catch { return '••••••••'; }
}
