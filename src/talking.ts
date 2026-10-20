import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.ts';
import { S } from './settings.ts';
import { PermanentError } from './jobs.ts';

/**
 * Fornecedores de "retrato falante" para o Laboratório comparativo.
 * Todos recebem URLs (temporários e assinados) da fotografia e do áudio; o Veo recebe a imagem em base64 e o texto.
 */
export interface TalkingProvider {
  id: string; label: string; partner: string; keyName: string;
  pricePerSec: number | null; note: string;
  ownAudio: boolean; // usa o NOSSO áudio (sincronização labial) ou gera a voz dele
}

export const PROVIDERS: TalkingProvider[] = [
  { id: 'omnihuman', label: 'OmniHuman 1.5 (ByteDance)', partner: 'fal.ai', keyName: 'FAL_KEY', pricePerSec: 0.16, ownAudio: true, note: 'Corpo, mãos e gestos; 720p' },
  { id: 'fabric', label: 'VEED Fabric 1.0', partner: 'fal.ai', keyName: 'FAL_KEY', pricePerSec: 0.14, ownAudio: true, note: '720p' },
  { id: 'infinitalk', label: 'InfiniteTalk', partner: 'fal.ai', keyName: 'FAL_KEY', pricePerSec: null, ownAudio: true, note: 'Código aberto; 480p; preço por confirmar no painel' },
  { id: 'heygen', label: 'HeyGen Avatar IV', partner: 'WaveSpeed', keyName: 'WAVESPEED_API_KEY', pricePerSec: 0.10, ownAudio: true, note: '720p, expressividade média' },
  { id: 'veo', label: 'Google Veo 3.1 Fast (Flow)', partner: 'Google', keyName: 'GEMINI_API_KEY', pricePerSec: 0.10, ownAudio: false, note: 'Gera a voz dele (não usa o nosso áudio); clipe de 8 s' },
];

export const providerReady = (p: TalkingProvider) => config.openai.mock || !!S(p.keyName);

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

// ---------- Google Veo 3.1 (Gemini API) ----------
export const VEO_MODEL = 'veo-3.1-fast-generate-preview';
export const VEO_PRICE_PER_SEC = 0.10; // Veo 3.1 Fast, 720p, com áudio

/**
 * Um clipe do Veo a partir de uma imagem inicial (formato do SDK oficial @google/genai: bytesBase64Encoded + mimeType).
 * Cobrado pela duração pedida (4, 6 ou 8 s). Pedidos recusados (400/429) não são cobrados: o 429 espera e repete;
 * uma duração não aceite neste modo passa a 8 s.
 */
export async function veoGenerate(o: { image: Buffer; prompt: string; aspectRatio?: '16:9' | '9:16'; durationSeconds?: 4 | 6 | 8; onStatus?: (s: string) => Promise<void> }) {
  const key = S('GEMINI_API_KEY');
  const headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
  let dur = o.durationSeconds ?? 8;
  let op: any;
  for (let attempt = 0; ; attempt++) {
    try {
      op = await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/models/${VEO_MODEL}:predictLongRunning`, {
        method: 'POST', headers,
        body: JSON.stringify({ instances: [{ prompt: o.prompt, image: { bytesBase64Encoded: o.image.toString('base64'), mimeType: 'image/jpeg' } }], parameters: { aspectRatio: o.aspectRatio ?? '16:9', durationSeconds: dur, personGeneration: 'allow_adult' } }),
      }, 'Veo');
      break;
    } catch (e: any) {
      const m = String(e?.message ?? e);
      if (dur !== 8 && /^Veo 400/.test(m) && /duration/i.test(m)) { dur = 8; continue; }
      if (/^Veo 429/.test(m) && attempt < 5) { await o.onStatus?.('Limite de pedidos do Google: a aguardar'); await sleep(30_000 * (attempt + 1)); continue; }
      throw e;
    }
  }
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 15 * 60_000) throw new Error('Veo: tempo excedido');
    await sleep(10_000);
    const st = await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/${op.name}`, { headers }, 'Veo');
    if (st.error) throw new PermanentError(`Veo: ${String(st.error.message ?? JSON.stringify(st.error)).slice(0, 300)}`);
    if (st.done) {
      const uri = st.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new PermanentError(`Veo não devolveu vídeo (pode ter sido bloqueado pelos filtros): ${JSON.stringify(st.response ?? {}).slice(0, 200)}`);
      return { video: await download(uri, { 'x-goog-api-key': key }), billedSec: dur };
    }
    await o.onStatus?.('A gerar no Google Veo');
  }
}

async function veo(image: Buffer, text: string, onStatus?: (s: string) => Promise<void>) {
  // (a direção de cena entra no texto do pedido)
  const prompt = `The person in the image is a podcast host in a calm studio. They look at the camera and say, in a natural, warm voice: "${text.replace(/"/g, "'")}". ${presenterDirection()} No captions, no text on screen, no music.`;
  return veoGenerate({ image, prompt, onStatus });
}

/**
 * Pedido de um clipe de episódio: a pessoa diz exatamente o texto aprovado, com a voz (masculina/feminina) escolhida pelo
 * entrevistador e uma descrição fixa por papel, para a voz variar o menos possível entre clipes.
 */
export function veoEpisodePrompt(o: { role: 'host' | 'guest'; text: string; voice: 'male' | 'female' }) {
  const who = o.role === 'host' ? 'the interviewer of a podcast' : 'the guest of a podcast interview';
  const voice = `a natural adult ${o.voice === 'male' ? 'male' : 'female'} voice, ${o.role === 'host' ? 'warm and mid-pitched' : 'calm and mid-pitched'}, clear neutral international English accent, steady unhurried pace`;
  return `The person in the image is ${who}, in a calm studio. They look at the camera and say, in English, exactly these words and nothing else, with ${voice}: "${o.text.replace(/"/g, "'")}" They finish speaking before the end of the clip and then stay silent with a natural, friendly expression. ${presenterDirection(o.role)} Keep the framing, background, clothing and appearance of the image; if the hands are not visible in the image, do not add them and express through the face, head and shoulders. Do not add other people or objects. Only this person speaks. No captions, no text on screen, no music, no sound effects.`;
}

/** Corre um fornecedor. `audioSec` serve para o InfiniteTalk calcular o número de fotogramas. */
export async function runProvider(p: TalkingProvider, a: { imageUrl: string; audioUrl: string; image: Buffer; text: string; audioSec: number; direction?: string }, onStatus?: (s: string) => Promise<void>) {
  const direction = a.direction ?? presenterDirection();
  switch (p.id) {
    case 'omnihuman': return falRun('fal-ai/bytedance/omnihuman/v1.5', { image_url: a.imageUrl, audio_url: a.audioUrl, resolution: '720p', prompt: direction }, onStatus);
    case 'fabric': return falRun('veed/fabric-1.0', { image_url: a.imageUrl, audio_url: a.audioUrl, resolution: '720p' }, onStatus);
    case 'infinitalk': return falRun('fal-ai/infinitalk', { image_url: a.imageUrl, audio_url: a.audioUrl, prompt: direction, resolution: '480p', num_frames: Math.min(721, Math.max(41, Math.round(a.audioSec * 25) + 5)) }, onStatus);
    case 'heygen': return wavespeedHeygen(a.imageUrl, a.audioUrl, onStatus);
    case 'veo': return veo(a.image, a.text, onStatus);
    default: throw new PermanentError(`Fornecedor desconhecido: ${p.id}`);
  }
}
