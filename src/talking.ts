import { createHash, createHmac, sign, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { S, parseServiceAccount, isVertexLocation, scopedS, scopeS, ownsAny, currentEntity, inEntity, VEO_CRED_KEYS, type ServiceAccount } from './settings.ts';
import { PermanentError } from './jobs.ts';

/**
 * Fornecedores de "retrato falante" para o Laboratório comparativo.
 * Todos recebem URLs (temporários e assinados) da fotografia e do áudio; o Veo recebe a imagem em base64 e o texto.
 */
export interface TalkingProvider {
  id: string; label: string; partner: string; keyName: string;
  pricePerSec: number | null; note: string;
  ownAudio: boolean; // usa o NOSSO áudio (sincronização labial) ou gera a voz dele
  preselected: boolean; // marcado por omissão no Laboratório (os outros ficam no código, desmarcados)
}

export const PROVIDERS: TalkingProvider[] = [
  { id: 'omnihuman', label: 'OmniHuman 1.5 (ByteDance)', partner: 'fal.ai', keyName: 'FAL_KEY', pricePerSec: 0.16, ownAudio: true, preselected: false, note: 'Corpo, mãos e gestos; 720p' },
  { id: 'fabric', label: 'VEED Fabric 1.0', partner: 'fal.ai', keyName: 'FAL_KEY', pricePerSec: 0.14, ownAudio: true, preselected: false, note: '720p' },
  { id: 'infinitalk', label: 'InfiniteTalk', partner: 'fal.ai', keyName: 'FAL_KEY', pricePerSec: null, ownAudio: true, preselected: false, note: 'Código aberto; 480p; preço por confirmar no painel' },
  { id: 'heygen', label: 'HeyGen Avatar IV', partner: 'WaveSpeed', keyName: 'WAVESPEED_API_KEY', pricePerSec: 0.10, ownAudio: true, preselected: false, note: '720p, expressividade média' },
  { id: 'veo', label: 'Google Veo 3.1 Fast', partner: 'Google', keyName: 'VERTEX_SA_JSON', pricePerSec: 0.10, ownAudio: false, preselected: true, note: 'Gera a voz dele (não usa o nosso áudio); clipe de 8 s; 720p com áudio' },
  { id: 'veo-lite', label: 'Google Veo 3.1 Lite', partner: 'Google', keyName: 'VERTEX_SA_JSON', pricePerSec: 0.05, ownAudio: false, preselected: true, note: 'Metade do preço do Fast; gera a voz dele; clipe de 8 s; 720p com áudio' },
];

export const isVeoProvider = (p: TalkingProvider) => p.id === 'veo' || p.id === 'veo-lite';
/** Com credenciais: o Veo usa a conta de serviço do Vertex AI ou, na falta dela, a chave da Gemini API. */
export const providerReady = (p: TalkingProvider) => config.openai.mock || (isVeoProvider(p) ? veoConfigured() : !!S(p.keyName));

/** Direção de cena com regras de boa apresentação (usada pelos modelos que aceitam instruções de movimento). */
export function presenterDirection(role: 'host' | 'guest' | 'presenter' = 'presenter') {
  const common = [
    'Natural on-camera speaker following presentation best practices.',
    'Eye contact with the camera most of the time; natural blinking; small, natural nods.',
    'Open, relaxed posture: shoulders slightly angled to the camera at rest, turning square to the camera when making a key point.',
    'Both hands visible and active inside the gesture zone between waist and chest: open-palm gestures to explain, a single small emphasis gesture on key words, counting on fingers only when listing, hands returning to a relaxed resting position between ideas.',
    'Gestures are synchronised with the rhythm and stress of the speech, never repetitive.',
    'Calm, confident, friendly facial expression that matches the tone of what is being said.',
    'Avoid: crossed arms, hands in pockets, touching the face or hair, fidgeting, pointing at the camera, exaggerated or theatrical movement, standing up, leaving the frame.',
    'Static camera, medium shot, same framing and lighting throughout.',
  ];
  const byRole = {
    host: 'The speaker is the interviewer asking a question: slightly leaning in, inviting open-palm gesture towards the camera, eyebrows rising gently at the end of the question.',
    guest: 'The speaker is the guest answering thoughtfully: brief pauses to think, explanatory open-palm gestures, a small nod when concluding.',
    presenter: 'The speaker is a podcast host welcoming the audience.',
  } as const;
  return [byRole[role], ...common].join(' ');
}

// ---------- URLs temporários assinados (para os fornecedores descarregarem os ficheiros) ----------
export function signedAssetUrl(assetId: string, ttlSec = 3600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const sig = createHmac('sha256', config.secret).update(`m|${assetId}|${exp}`).digest('base64url');
  return `${config.baseUrl}/m/${assetId}/${exp}/${sig}`;
}
export function verifySignedAsset(assetId: string, exp: string, sig: string) {
  if (!/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  const want = createHmac('sha256', config.secret).update(`m|${assetId}|${exp}`).digest('base64url');
  return want.length === sig.length && timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

async function jsonFetch(url: string, init: RequestInit, label: string) {
  const res = await fetch(url, init);
  const text = await res.text();
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* corpo não-JSON */ }
  if (!res.ok) {
    const msg = `${label} ${res.status}: ${String(j?.detail ?? j?.message ?? j?.error?.message ?? j?.error ?? text).slice(0, 300)}`;
    throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new PermanentError(msg) : new Error(msg);
  }
  return j;
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function download(url: string, headers: Record<string, string> = {}) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error(`Falha a descarregar o vídeo (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
}

// ---------- fal.ai (fila) ----------
async function falRun(model: string, input: object, onStatus?: (s: string) => Promise<void>): Promise<{ video: Buffer; billedSec: number | null }> {
  const headers = { Authorization: `Key ${S('FAL_KEY')}`, 'Content-Type': 'application/json' };
  const sub = await jsonFetch(`https://queue.fal.run/${model}`, { method: 'POST', headers, body: JSON.stringify(input) }, 'fal.ai');
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 20 * 60_000) throw new Error('fal.ai: tempo excedido');
    const st = await jsonFetch(sub.status_url, { headers }, 'fal.ai');
    if (st.status === 'COMPLETED') { if (st.error) throw new Error(`fal.ai: ${String(st.error).slice(0, 300)}`); break; }
    await onStatus?.(st.status === 'IN_QUEUE' ? `Em fila na fal.ai (posição ${st.queue_position ?? '?'})` : 'A gerar na fal.ai');
    await sleep(4000);
  }
  const out = await jsonFetch(sub.response_url, { headers }, 'fal.ai');
  const url = out?.video?.url;
  if (!url) throw new Error('fal.ai não devolveu vídeo');
  return { video: await download(url), billedSec: typeof out.duration === 'number' ? out.duration : null };
}

// ---------- WaveSpeed (HeyGen Avatar IV) ----------
async function wavespeedHeygen(imageUrl: string, audioUrl: string, onStatus?: (s: string) => Promise<void>) {
  const headers = { Authorization: `Bearer ${S('WAVESPEED_API_KEY')}`, 'Content-Type': 'application/json' };
  // Sem novas tentativas automáticas do pedido de criação: cada envio é cobrado.
  const sub = await jsonFetch('https://api.wavespeed.ai/api/v3/heygen/avatar-iv', { method: 'POST', headers, body: JSON.stringify({ image: imageUrl, audio: audioUrl, resolution: '720p', expressiveness: 'medium' }) }, 'WaveSpeed');
  const id = sub?.data?.id ?? sub?.id;
  if (!id) throw new Error('WaveSpeed não devolveu o identificador do pedido');
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 20 * 60_000) throw new Error('WaveSpeed: tempo excedido');
    const r = await jsonFetch(`https://api.wavespeed.ai/api/v3/predictions/${id}/result`, { headers }, 'WaveSpeed');
    const d = r?.data ?? r;
    if (d.status === 'completed') { const url = d.outputs?.[0]; if (!url) throw new Error('WaveSpeed sem vídeo'); return { video: await download(url), billedSec: null }; }
    if (['failed', 'cancelled', 'timeout', 'deleted'].includes(d.status)) throw new Error(`WaveSpeed: ${d.status} ${String(d.error ?? '').slice(0, 200)}`);
    await onStatus?.('A gerar no WaveSpeed (HeyGen Avatar IV)');
    await sleep(4000);
  }
}

// ---------- Google Veo 3.1: Vertex AI (conta de serviço) ou Gemini API (chave, enquanto a Google a mantiver) ----------
export type VeoTier = 'fast' | 'lite';
export type VeoBackend = 'vertex' | 'gemini';
const VEO_MODELS: Record<VeoBackend, Record<VeoTier, string>> = {
  vertex: { fast: 'veo-3.1-fast-generate-001', lite: 'veo-3.1-lite-generate-001' }, // Fast GA; Lite em pré-visualização
  gemini: { fast: 'veo-3.1-fast-generate-preview', lite: 'veo-3.1-lite-generate-preview' }, // desligados a partir de 22/10/2026
};
const VEO_PRICES: Record<VeoTier, number> = { fast: 0.10, lite: 0.05 }; // USD por segundo, 720p com áudio
export const VEO_MODEL = VEO_MODELS.gemini.fast;
export const VEO_LITE_MODEL = VEO_MODELS.gemini.lite;
export const VEO_PRICE_PER_SEC = VEO_PRICES.fast;
/** O que não queremos na imagem nem no som (o Lite chegou a escrever «2%7» no ecrã). */
export const VEO_NEGATIVE_PROMPT = 'on-screen text, captions, subtitles, written words, written letters or digits, logos, watermarks, signs, labels, title cards, background music';

/**
 * Nível e região do Veo: os da entidade só quando o Veo dela usa credenciais próprias (é ela que paga); senão os globais,
 * escolhidos pelo administrador (um gestor de entidade não escolhe o que o portal paga).
 */
const veoOpt = (key: 'VEO_TIER' | 'VERTEX_LOCATION') => (veoCredsScope() === 'entity' ? S(key) : inEntity(null, () => S(key)));
/** Nível escolhido em Definições → Google; por omissão o Fast. */
export const veoTier = (): VeoTier => (veoOpt('VEO_TIER') === 'lite' ? 'lite' : 'fast');
/**
 * Credenciais do Veo lidas em conjunto: as da entidade em contexto se ela tiver alguma (conta de serviço ou chave Gemini),
 * nunca misturadas com as globais; senão as globais. O Veo de uma entidade paga sempre no projeto Google dela.
 */
const veoS = (key: typeof VEO_CRED_KEYS[number]) => scopedS(VEO_CRED_KEYS, key);
/** De onde vêm as credenciais do Veo em vigor: da entidade em contexto ou globais. */
export const veoCredsScope = (): 'entity' | 'global' => (ownsAny(currentEntity(), VEO_CRED_KEYS) ? 'entity' : 'global');
/** O mesmo âmbito como se guarda em cada operação (veo_ops.cred_scope): 'global' ou o id da entidade. */
export const veoScopeId = (): string => (veoCredsScope() === 'entity' ? currentEntity()! : 'global');
/** Credencial do Veo num âmbito fixo (o da operação que se consulta) ou, sem âmbito, a das credenciais em vigor. */
const credOf = (key: typeof VEO_CRED_KEYS[number], scope?: string | null) => (scope ? scopeS(scope, key) : veoS(key));
/** Vertex AI se houver conta de serviço (no âmbito das credenciais em vigor); senão a Gemini API. */
export const veoBackend = (): VeoBackend => (veoS('VERTEX_SA_JSON') ? 'vertex' : 'gemini');
export const veoConfigured = () => !!veoS('VERTEX_SA_JSON') || !!veoS('GEMINI_API_KEY');
export const veoModel = (tier: VeoTier = veoTier(), backend: VeoBackend = veoBackend()) => VEO_MODELS[backend][tier];
export const veoPricePerSec = (tier: VeoTier = veoTier()) => VEO_PRICES[tier];
export const veoLabel = (tier: VeoTier = veoTier()) => `Google Veo 3.1 ${tier === 'lite' ? 'Lite' : 'Fast'}`;
export const tierOfModel = (model?: string | null): VeoTier => (/-lite-/.test(model ?? '') ? 'lite' : 'fast');
/** Preço de um modelo registado (clipes e operações antigos não têm preço: eram todos do Fast). */
export const veoPriceOfModel = (model?: string | null) => VEO_PRICES[tierOfModel(model)];
/**
 * Identificador do nível na chave dos clipes: o mesmo nos dois serviços, para um clipe já pago e verificado (ou uma
 * operação pendente) se reaproveitar ao passar da Gemini API para o Vertex AI. O do Fast é o de sempre.
 */
export const veoKeyModel = (tier: VeoTier) => VEO_MODELS.gemini[tier];

// ---------- Vertex AI: token OAuth da conta de serviço (JWT RS256), guardado até 60 s antes de expirar ----------
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const VERTEX_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const tokens = new Map<string, { token: string; exp: number }>();
export const clearVertexTokens = () => tokens.clear();

export const vertexLocation = () => { const l = veoOpt('VERTEX_LOCATION').trim().toLowerCase(); return isVertexLocation(l) ? l : 'us-central1'; };

/** Asserção assinada com a chave da conta de serviço (RFC 7523), válida 1 h. */
export function serviceAccountJwt(sa: ServiceAccount, nowSec = Math.floor(Date.now() / 1000)) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) });
  const claims = b64({ iss: sa.client_email, scope: VERTEX_SCOPE, aud: GOOGLE_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 });
  return `${head}.${claims}.${sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), sa.private_key).toString('base64url')}`;
}

/**
 * Token de acesso da conta de serviço em vigor (Definições → Google, da entidade ou global), ou da de um âmbito fixo (o de
 * uma operação já criada). Uma recusa da Google (chave apagada, conta desativada) dá «Veo 401: …» (isKeyRejected); a
 * indisponibilidade dá «Veo 5xx: …» (passageira). As mensagens nunca incluem a chave nem a asserção.
 */
export async function vertexToken(scope?: string | null): Promise<{ token: string; sa: ServiceAccount }> {
  let sa: ServiceAccount;
  try { sa = parseServiceAccount(credOf('VERTEX_SA_JSON', scope)); }
  catch (e: any) { throw new PermanentError(`Veo 401: conta de serviço do Vertex AI inválida em Definições (${String(e?.message ?? e).slice(0, 160)})`); }
  const id = createHash('sha256').update(`${sa.client_email}|${sa.private_key_id ?? ''}|${sa.private_key}`).digest('hex');
  const hit = tokens.get(id);
  if (hit && hit.exp > Date.now()) return { token: hit.token, sa };
  const res = await fetch(GOOGLE_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountJwt(sa) }).toString() });
  const text = await res.text();
  let j: any = {};
  try { j = text ? JSON.parse(text) : {}; } catch { /* corpo não-JSON */ }
  if (!res.ok || typeof j.access_token !== 'string' || !j.access_token) {
    const why = `${String(j.error ?? res.status).slice(0, 40)}${j.error_description ? `: ${String(j.error_description).slice(0, 140)}` : ''}`;
    if (res.status >= 500 || res.status === 429) throw new Error(`Veo ${res.status}: autenticação da Google indisponível (${why})`);
    throw new PermanentError(`Veo 401: a Google recusou a conta de serviço ${sa.client_email} (${why})`);
  }
  const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) : 3600;
  tokens.set(id, { token: j.access_token, exp: Date.now() + (ttl - 60) * 1000 });
  return { token: j.access_token, sa };
}

const vertexModelUrl = (project: string, loc: string, model: string) => `https://${loc}-aiplatform.googleapis.com/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}`;
/** Operação do Vertex: projects/{p}/locations/{l}/publishers/google/models/{m}/operations/{id} (o modelo e a região vêm no nome). */
const VERTEX_OP = /^projects\/((?:[a-z0-9.-]+:)?[a-z0-9-]+)\/locations\/([a-z]+-[a-z]+\d{1,2})\/publishers\/google\/models\/([a-z0-9.-]+)\/operations\/[A-Za-z0-9_-]+$/;
export const isVertexOp = (opName: string) => opName.startsWith('projects/');

/** Limite de pedidos da Google que não passa em minutos (quota esgotada): o trabalho pára em vez de esperar horas. */
export class VeoQuotaError extends PermanentError {}
/** Envio não feito porque a autorização foi retirada ou o trabalho parou (nada saiu para a Google). */
export class VeoCancelled extends PermanentError {}
/** Falha passageira da Google numa operação (procura elevada, serviço indisponível): repete-se mais tarde e não conta para o limite. */
export class VeoBusy extends Error {}
/** A própria operação falhou na Google e não produziu vídeo (normalmente não é cobrada). */
export class VeoOpError extends PermanentError {}
/** Clipe bloqueado pelos filtros de segurança da Google (não há vídeo; normalmente não é cobrado). */
export class VeoFiltered extends VeoOpError {}
/** A CONSULTA de uma operação foi recusada (4xx): nada se sabe da operação, que pode ter sido feita e cobrada. */
export class VeoPollError extends PermanentError {}
/** A credencial com que a operação foi criada já não está em Definições: a operação (paga) fica pendente e o trabalho pára. */
export class VeoCredsMissing extends VeoPollError {}
/** O modelo escolhido recusou o próprio pedido (ex.: o Lite sem imagem inicial no Vertex): nada foi cobrado e o trabalho pára. */
export class VeoUnsupported extends PermanentError {}
// Passageiro só o que a Google diz que é passageiro (procura elevada, serviço indisponível).
const BUSY_TEXT = /high demand|try again later|temporarily unavailable|service unavailable|overloaded/i;
const BUSY_CODES = new Set([8, 14]); // RESOURCE_EXHAUSTED, UNAVAILABLE
/**
 * Credenciais recusadas: 401/403 (Gemini API ou Vertex AI, incluindo a recusa do token da conta de serviço, que dá
 * «Veo 401: …»), ou 400 com «API key» (é assim que a Gemini API responde a uma chave inválida).
 */
export const isKeyRejected = (m: string) => /^Veo 40[13]/.test(m) || (/^Veo 400/.test(m) && /API[ _-]?key/i.test(m));

const quiet = async (f?: (s: string) => Promise<void>, s = '') => { try { await f?.(s); } catch { /* o progresso nunca interrompe uma operação já paga */ } };

let geminiNegativeOk = true; // a Gemini API pode não aceitar negativePrompt: depois de uma recusa deixa de o enviar

/**
 * Submete um clipe do Veo a partir de uma imagem inicial (bytesBase64Encoded + mimeType) no serviço em vigor: Vertex AI
 * com conta de serviço (720p, com áudio, sem storageUri: o vídeo volta em base64) ou Gemini API. A partir do momento em
 * que a Google aceita, o clipe é cobrado pela duração pedida (4, 6 ou 8 s) ao preço do nível escolhido.
 * Pedidos recusados (400/429) não são cobrados: o 429 espera e repete (até ~5 min), depois desiste com VeoQuotaError;
 * uma duração não aceite neste modo passa a 8 s. `model` só vale se for um modelo do serviço em vigor.
 */
export async function veoSubmit(o: { image: Buffer; prompt: string; aspectRatio?: '16:9' | '9:16'; durationSeconds?: 4 | 6 | 8; onStatus?: (s: string) => Promise<void>; canSend?: () => Promise<boolean>; waitMs?: (attempt: number) => number; model?: string; tier?: VeoTier }): Promise<{ opName: string; dur: 4 | 6 | 8; model: string; tier: VeoTier; usdPerSec: number; backend: VeoBackend; scope: string; project: string | null }> {
  const backend = veoBackend(), scope = veoScopeId();
  const tier = o.tier ?? (o.model ? tierOfModel(o.model) : veoTier());
  const model = o.model && Object.values(VEO_MODELS[backend]).includes(o.model) ? o.model : veoModel(tier, backend);
  let dur: 4 | 6 | 8 = o.durationSeconds ?? 8;
  for (let attempt = 0; ; attempt++) {
    // Antes de CADA envio (também nas repetições após 429): autorização em vigor e trabalho não parado.
    if (o.canSend && !(await o.canSend())) throw new VeoCancelled('Envio à Google cancelado: autorização retirada ou trabalho parado');
    const negative = backend === 'vertex' || geminiNegativeOk;
    const instances = [{ prompt: o.prompt, image: { bytesBase64Encoded: o.image.toString('base64'), mimeType: 'image/jpeg' } }];
    const parameters = { aspectRatio: o.aspectRatio ?? '16:9', durationSeconds: dur, personGeneration: 'allow_adult', ...(negative ? { negativePrompt: VEO_NEGATIVE_PROMPT } : {}) };
    try {
      let op: any, project: string | null = null;
      if (backend === 'vertex') {
        const { token, sa } = await vertexToken();
        project = sa.project_id;
        op = await jsonFetch(`${vertexModelUrl(sa.project_id, vertexLocation(), model)}:predictLongRunning`, {
          method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ instances, parameters: { ...parameters, generateAudio: true, sampleCount: 1, resolution: '720p' } }),
        }, 'Veo');
      } else {
        op = await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:predictLongRunning`, {
          method: 'POST', headers: { 'x-goog-api-key': veoS('GEMINI_API_KEY'), 'Content-Type': 'application/json' },
          body: JSON.stringify({ instances, parameters }),
        }, 'Veo');
      }
      if (!op?.name) throw new PermanentError('Veo não devolveu o identificador da operação');
      // O âmbito e o projeto das credenciais ficam com a operação: consulta-se sempre com elas, mesmo que mudem entretanto.
      return { opName: String(op.name), dur, model, tier, usdPerSec: VEO_PRICES[tier], backend, scope, project };
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (dur !== 8 && /^Veo 400/.test(m) && /duration/i.test(m)) { dur = 8; continue; }
      if (backend === 'gemini' && negative && /^Veo 400/.test(m) && /negative/i.test(m)) { geminiNegativeOk = false; continue; }
      // O Lite no Vertex: a ficha da Google contradiz-se sobre a imagem inicial; se a recusar, pára com uma indicação clara.
      if (backend === 'vertex' && tier === 'lite' && /^Veo 400/.test(m) && /image|not supported|unsupported/i.test(m))
        throw new VeoUnsupported(`O Veo 3.1 Lite (${model}) recusou o pedido com imagem inicial no Vertex AI (nada foi cobrado): escolha o Veo 3.1 Fast em Definições → Google. Resposta da Google: ${m.replace(/^Veo 400:\s*/, '').slice(0, 160)}`);
      // Modelo inexistente ou desligado (os da Gemini API a partir de 22/10/2026): nada foi cobrado e não adianta insistir.
      if (/^Veo 404/.test(m)) {
        const google = m.replace(/^Veo 404:\s*/, '').slice(0, 160);
        throw new VeoUnsupported(backend === 'gemini'
          ? `O modelo ${model} já não está disponível na Gemini API (nada foi cobrado): configure a conta de serviço do Vertex AI em Definições → Google${scope === 'global' ? '' : ' da entidade (o Veo dela usa só as credenciais Google próprias)'}. Resposta da Google: ${google}`
          : `O modelo ${model} não está disponível no Vertex AI em ${vertexLocation()} (nada foi cobrado): confirme a região e o modelo em Definições → Google. Resposta da Google: ${google}`);
      }
      if (/^Veo 429/.test(m)) {
        if (attempt >= 4) throw new VeoQuotaError('Limite de pedidos (quota) da Google esgotado: tente mais tarde.');
        await quiet(o.onStatus, 'Limite de pedidos do Google: a aguardar');
        await sleep(o.waitMs ? o.waitMs(attempt) : 30_000 * (attempt + 1));
        continue;
      }
      // Pedido não aceite por indisponibilidade da Google (5xx, «high demand»): passageiro, não conta para o limite.
      if (/^Veo 5\d\d/.test(m) || BUSY_TEXT.test(m)) throw new VeoBusy(m);
      throw e;
    }
  }
}

/**
 * Uma consulta da operação no serviço que a criou (o nome diz qual: 'projects/…' = Vertex AI, 'models/…' = Gemini API),
 * com as credenciais do âmbito em que foi criada (sem âmbito, as em vigor: operações anteriores à migração 018).
 */
async function veoPoll(opName: string, scope?: string | null) {
  const whose = scope === 'global' ? ' (credenciais globais do portal)' : scope ? ' (credenciais da entidade)' : '';
  const gone = (what: string) => `Veo: há uma operação ${isVertexOp(opName) ? 'do Vertex AI' : 'da Gemini API'} já paga por concluir, mas ${what} com que foi criada${whose} foi retirada de Definições: não é possível consultá-la. A operação fica pendente e nada é pago de novo: reponha essa credencial para a concluir (ou ela expira 36 h depois de criada).`;
  if (isVertexOp(opName)) {
    const m = VERTEX_OP.exec(opName);
    if (!m) throw new VeoPollError('Veo: nome de operação do Vertex AI inesperado');
    if (!credOf('VERTEX_SA_JSON', scope)) throw new VeoCredsMissing(gone('a conta de serviço'));
    const { token } = await vertexToken(scope);
    return jsonFetch(`${vertexModelUrl(m[1], m[2], m[3])}:fetchPredictOperation`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationName: opName }) }, 'Veo');
  }
  if (opName.startsWith('models/') && !credOf('GEMINI_API_KEY', scope)) throw new VeoCredsMissing(gone('a chave Gemini'));
  return jsonFetch(`https://generativelanguage.googleapis.com/v1beta/${opName}`, { headers: { 'x-goog-api-key': credOf('GEMINI_API_KEY', scope) } }, 'Veo');
}

/**
 * A operação é das credenciais em vigor? Mesmo âmbito (global ou a entidade), mesmo serviço e, no Vertex AI, o mesmo
 * projeto da conta de serviço (o nome da operação pode trazer o número do projeto, por isso guarda-se o projeto à parte).
 * Uma recusa (401/403) só acusa as credenciais em vigor quando a operação é delas. Sem âmbito nem projeto guardados
 * (operações antigas), conta-se como das credenciais em vigor, como até aqui.
 */
export function opOfCurrentCreds(opName: string, scope?: string | null, project?: string | null): boolean {
  if (scope && scope !== veoScopeId()) return false;
  if (!isVertexOp(opName)) return veoBackend() === 'gemini';
  if (veoBackend() !== 'vertex') return false;
  if (!project) return true;
  try { return parseServiceAccount(veoS('VERTEX_SA_JSON')).project_id === project; } catch { return false; }
}

/** Vídeo de uma operação concluída do Vertex: em base64 (sem storageUri) ou, se a Google o guardar, no Cloud Storage. */
async function vertexVideo(resp: any, scope?: string | null): Promise<Buffer> {
  const v = resp?.videos?.[0];
  if (!v?.bytesBase64Encoded && !v?.gcsUri) {
    if (resp?.raiMediaFilteredCount || resp?.raiMediaFilteredReasons?.length) throw new VeoFiltered(`Veo: clipe bloqueado pelos filtros da Google: ${String(resp.raiMediaFilteredReasons?.[0] ?? '').slice(0, 200)}`);
    throw new VeoOpError(`Veo não devolveu vídeo: ${JSON.stringify(resp ?? {}).slice(0, 200)}`);
  }
  if (v.bytesBase64Encoded) return Buffer.from(String(v.bytesBase64Encoded), 'base64');
  const g = /^gs:\/\/([a-z0-9._-]+)\/(.+)$/.exec(String(v.gcsUri));
  if (!g) throw new VeoOpError('Veo devolveu um endereço de vídeo inesperado');
  const { token } = await vertexToken(scope);
  return download(`https://storage.googleapis.com/storage/v1/b/${g[1]}/o/${encodeURIComponent(g[2])}?alt=media`, { Authorization: `Bearer ${token}` });
}

/** Vídeo de uma operação concluída da Gemini API (descarregado com a chave). */
async function geminiVideo(resp: any, scope?: string | null): Promise<Buffer> {
  const gen = resp?.generateVideoResponse;
  const uri = gen?.generatedSamples?.[0]?.video?.uri;
  if (!uri && (gen?.raiMediaFilteredCount || gen?.raiMediaFilteredReasons?.length)) throw new VeoFiltered(`Veo: clipe bloqueado pelos filtros da Google: ${String(gen.raiMediaFilteredReasons?.[0] ?? '').slice(0, 200)}`);
  if (!uri) throw new VeoOpError(`Veo não devolveu vídeo: ${JSON.stringify(resp ?? {}).slice(0, 200)}`);
  return download(uri, { 'x-goog-api-key': credOf('GEMINI_API_KEY', scope) });
}

/**
 * Espera pela operação (no serviço e com as credenciais do âmbito que a criaram) e obtém o vídeo. Erros passageiros (rede,
 * 5xx, 429) repetem a consulta, nunca a submissão.
 */
export async function veoAwait(opName: string, dur: number, onStatus?: (s: string) => Promise<void>, deadlineMs = 20 * 60_000, pollMs = 10_000, scope?: string | null) {
  const t0 = Date.now();
  let fails = 0;
  for (;;) {
    if (Date.now() - t0 > deadlineMs) throw new Error('Veo: tempo excedido (a operação fica pendente e é retomada na próxima tentativa)');
    await sleep(pollMs);
    let st: any;
    try { st = await veoPoll(opName, scope); fails = 0; }
    catch (e: any) { if (e instanceof VeoPollError) throw e; if (e instanceof PermanentError) throw new VeoPollError(String(e.message)); if (++fails > 8) throw e; continue; }
    if (st.error) {
      const msg = String(st.error.message ?? JSON.stringify(st.error)).slice(0, 300);
      if (BUSY_TEXT.test(msg) || BUSY_CODES.has(Number(st.error.code))) throw new VeoBusy(`Veo: ${msg}`);
      throw new VeoOpError(`Veo: ${msg}`);
    }
    if (st.done) {
      for (let k = 0; ; k++) {
        try { return { video: isVertexOp(opName) ? await vertexVideo(st.response, scope) : await geminiVideo(st.response, scope), billedSec: dur }; }
        catch (e) { if (e instanceof VeoOpError || k >= 3) throw e; await sleep(5000 * (k + 1)); }
      }
    }
    await quiet(onStatus, 'A gerar no Google Veo');
  }
}

export async function veoGenerate(o: { image: Buffer; prompt: string; aspectRatio?: '16:9' | '9:16'; durationSeconds?: 4 | 6 | 8; onStatus?: (s: string) => Promise<void>; model?: string; tier?: VeoTier }) {
  const s = await veoSubmit(o);
  return { ...(await veoAwait(s.opName, s.dur, o.onStatus)), model: s.model };
}

/** Falha passageira da Google no teste (429, 5xx): diz-se para tentar de novo. */
class CheckTransient extends Error {}

/**
 * «Guardar e testar» do grupo Google, sem gerar vídeo (sem custo). Numa entidade com credenciais próprias diz que são dela.
 * Numa entidade sem elas, o teste usa as credenciais globais do portal e diz só se funcionam: o gestor da entidade não vê a
 * conta de serviço, o projeto, a região nem as mensagens da Google (que os repetem), nem no erro do token.
 */
export async function veoCheck(): Promise<string> {
  const tier = veoTier(), label = veoLabel(tier);
  if (currentEntity() && veoCredsScope() === 'global') {
    if (!veoConfigured()) throw new Error('a entidade não tem credenciais Google próprias e o portal ainda não tem as globais: cole aqui a conta de serviço da entidade ou avise o administrador do portal.');
    try { await checkCreds(tier, label); }
    catch (e) { throw new Error(e instanceof CheckTransient ? 'credenciais globais do portal: a Google não respondeu agora; tente de novo daqui a pouco.' : 'credenciais globais do portal: não estão a funcionar. Avise o administrador do portal.'); }
    return 'Google: a entidade não tem credenciais Google próprias e usa as globais do portal. Credenciais globais do portal: OK.';
  }
  return (await checkCreds(tier, label)) + (currentEntity() ? ' Usa as credenciais Google desta entidade (as globais não se aplicam a ela).' : '');
}

/**
 * Teste das credenciais em vigor. Com conta de serviço: obtém o token e consulta uma operação que não existe no modelo
 * escolhido (com acesso, a Google responde 404 NOT_FOUND ou 400 INVALID_ARGUMENT; sem acesso, 401/403); qualquer outra
 * resposta mostra-se tal como veio, a dizer que o token foi aceite. Sem conta de serviço: confirma a chave da Gemini API e
 * o modelo, como antes.
 */
async function checkCreds(tier: VeoTier, label: string): Promise<string> {
  if (veoS('VERTEX_SA_JSON')) {
    let tk: { token: string; sa: ServiceAccount };
    try { tk = await vertexToken(); }
    catch (e: any) { const m = String(e?.message ?? e), clean = m.replace(/^Veo \d+:\s*/, ''); throw /^Veo (429|5\d\d)/.test(m) ? new CheckTransient(clean) : new Error(clean); }
    const { token, sa } = tk, loc = vertexLocation(), model = veoModel(tier, 'vertex');
    const opName = `projects/${sa.project_id}/locations/${loc}/publishers/google/models/${model}/operations/00000000-0000-0000-0000-000000000000`;
    const r = await fetch(`${vertexModelUrl(sa.project_id, loc, model)}:fetchPredictOperation`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ operationName: opName }) });
    const text = await r.text();
    let j: any = {};
    try { j = text ? JSON.parse(text) : {}; } catch { /* corpo não-JSON */ }
    const gm = String(j?.error?.message ?? text).replace(/\s+/g, ' ').slice(0, 140);
    const st = typeof j?.error?.status === 'string' ? ` ${j.error.status.slice(0, 40)}` : '';
    if (r.status === 401) throw new Error(`a Google recusou o token da conta de serviço ${sa.client_email}: ${gm}`);
    if (r.status === 403) throw new Error(/SERVICE_DISABLED|has not been used|is disabled/i.test(text)
      ? `a Vertex AI API não está ativa no projeto ${sa.project_id}: ative-a na consola da Google Cloud e teste de novo.`
      : `a conta de serviço ${sa.client_email} não tem acesso ao ${label} no projeto ${sa.project_id} (precisa da função «Vertex AI User»): ${gm}`);
    if (r.status === 404 && /publisher model/i.test(gm) && !/operations\//.test(gm)) throw new Error(`o modelo ${model} não está disponível em ${loc} para o projeto ${sa.project_id}: ${gm}`);
    if (!r.ok && r.status !== 404 && r.status !== 400) {
      const busy = r.status === 429 || r.status >= 500;
      const msg = `a conta de serviço ${sa.client_email} foi aceite (token obtido), mas o teste do acesso ao ${label} (${model}, ${loc}) teve uma resposta inesperada da Google: HTTP ${r.status}${st}${gm ? ` — ${gm}` : ''}. Nada foi gerado nem cobrado; ${busy ? 'pode ser passageira: tente de novo daqui a pouco' : 'confirme o acesso ao modelo na consola da Google Cloud'}.`;
      throw busy ? new CheckTransient(msg) : new Error(msg);
    }
    return `Google (Vertex AI): conta de serviço aceite (${sa.client_email}, projeto ${sa.project_id}, ${loc}) e acesso ao ${label} (${model}) confirmado, sem gerar vídeo.`
      + (tier === 'lite' ? ' O Lite está em pré-visualização e a ficha da Google contradiz-se sobre a imagem inicial: se o Vertex a recusar, a geração pára com uma mensagem clara e pode escolher o Fast.' : '')
      + (veoS('GEMINI_API_KEY') ? ' A chave Gemini fica guardada, mas o Veo usa o Vertex AI.' : '');
  }
  if (!veoS('GEMINI_API_KEY')) throw new Error('falta a conta de serviço do Vertex AI (ou a chave da Gemini API).');
  const model = veoModel(tier, 'gemini');
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}`, { headers: { 'x-goog-api-key': veoS('GEMINI_API_KEY') } });
  if (!r.ok) { const msg = `Google respondeu ${r.status} (chave inválida ou sem acesso ao ${label})`; throw r.status === 429 || r.status >= 500 ? new CheckTransient(msg) : new Error(msg); }
  return `Google (Gemini API): chave válida e modelo ${label} (${model}) disponível. A Google desliga estes modelos na Gemini API a partir de 22/10/2026: configure a conta de serviço do Vertex AI.`;
}

async function veo(image: Buffer, text: string, onStatus: ((s: string) => Promise<void>) | undefined, tier: VeoTier) {
  // (a direção de cena entra no texto do pedido; o mesmo pedido no Fast e no Lite, para comparar só o modelo)
  const prompt = `The person in the image is a podcast host in a calm studio. They look at the camera and say, in a natural, warm voice: "${text.replace(/"/g, "'")}". ${presenterDirection()} No captions, no text on screen, no music.`;
  return veoGenerate({ image, prompt, onStatus, tier });
}

/**
 * Pedido de um clipe de episódio: a pessoa diz exatamente o texto aprovado, com a voz (masculina/feminina) escolhida pelo
 * entrevistador e uma descrição fixa por papel, para a voz variar o menos possível entre clipes.
 */
export function veoEpisodePrompt(o: { role: 'host' | 'guest'; text: string; voice: 'male' | 'female' }) {
  const who = o.role === 'host' ? 'the interviewer of a podcast' : 'the guest of a podcast interview';
  return `The person in the image is ${who}, in a calm studio. They look at the camera and say, in English, exactly these words and nothing else, with ${veoVoice(o.role, o.voice)}: "${o.text.replace(/"/g, "'")}" They finish speaking before the end of the clip and then stay silent with a natural, friendly expression. ${presenterDirection(o.role)} ${VEO_KEEP_IMAGE}`;
}
/** Voz pedida ao Veo: a mesma descrição por papel em todos os clipes (falas e introdução), para variar o menos possível. */
const veoVoice = (role: 'host' | 'guest', voice: 'male' | 'female') =>
  `a natural adult ${voice === 'male' ? 'male' : 'female'} voice, ${role === 'host' ? 'warm and mid-pitched' : 'calm and mid-pitched'}, clear neutral international English accent, steady unhurried pace`;
const VEO_KEEP_IMAGE = 'Keep the framing, background, clothing and appearance of the image; if the hands are not visible in the image, do not add them and express through the face, head and shoulders. Do not add other people or objects. Only this person speaks. No captions, no text on screen, no music, no sound effects.';

/**
 * Pedido da introdução animada do entrevistador: abre o episódio com uma frase genérica (sem nomes), com a mesma voz das
 * falas dele e a direção de quem dá as boas-vindas ao público.
 */
export function veoIntroPrompt(o: { text: string; voice: 'male' | 'female' }) {
  return `The person in the image is the host of a podcast, in a calm studio, opening a new episode. They look at the camera and say, in English, exactly these words and nothing else, with ${veoVoice('host', o.voice)}: "${o.text.replace(/"/g, "'")}" They finish speaking before the end of the clip and then stay silent with a natural, friendly expression. ${presenterDirection('presenter')} ${VEO_KEEP_IMAGE}`;
}

/** Corre um fornecedor. `audioSec` serve para o InfiniteTalk calcular o número de fotogramas. */
export async function runProvider(p: TalkingProvider, a: { imageUrl: string; audioUrl: string; image: Buffer; text: string; audioSec: number; direction?: string }, onStatus?: (s: string) => Promise<void>) {
  const direction = a.direction ?? presenterDirection();
  switch (p.id) {
    case 'omnihuman': return falRun('fal-ai/bytedance/omnihuman/v1.5', { image_url: a.imageUrl, audio_url: a.audioUrl, resolution: '720p', prompt: direction }, onStatus);
    case 'fabric': return falRun('veed/fabric-1.0', { image_url: a.imageUrl, audio_url: a.audioUrl, resolution: '720p' }, onStatus);
    case 'infinitalk': return falRun('fal-ai/infinitalk', { image_url: a.imageUrl, audio_url: a.audioUrl, prompt: direction, resolution: '480p', num_frames: Math.min(721, Math.max(41, Math.round(a.audioSec * 25) + 5)) }, onStatus);
    case 'heygen': return wavespeedHeygen(a.imageUrl, a.audioUrl, onStatus);
    case 'veo': return veo(a.image, a.text, onStatus, 'fast');
    case 'veo-lite': return veo(a.image, a.text, onStatus, 'lite');
    default: throw new PermanentError(`Fornecedor desconhecido: ${p.id}`);
  }
}
