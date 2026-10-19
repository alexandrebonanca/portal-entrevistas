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
async function veo(image: Buffer, text: string, onStatus?: (s: string) => Promise<void>) {
  const key = S('GEMINI_API_KEY');
  const headers = { 'x-goog-api-key': key, 'Content-Type': 'application/json' };
  const prompt = `The person in the image is a podcast host in a calm studio. They look at the camera and say, in a natural, warm voice: "${text.replace(/"/g, "'")}". Natural head and shoulder movement, subtle hand gestures, static medium close-up camera. No captions, no text on screen, no music.`;
  const op = await jsonFetch('https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning', {
    method: 'POST', headers,
    body: JSON.stringify({ instances: [{ prompt, image: { inlineData: { mimeType: 'image/jpeg', data: image.toString('base64') } } }], parameters: { aspectRatio: '16:9', durationSeconds: 8, personGeneration: 'allow_adult' } }),
  }, 'Veo');
  const t0 = Date.now();
  for (;;) {
    if (Date.now() - t0 > 15 * 60_000) throw new Error('Veo: tempo excedido');
    await sleep(10_000);
    const st = await jsonFetch(`https://generativelanguage.googleapis.com/v1beta/${op.name}`, { headers }, 'Veo');
    if (st.error) throw new PermanentError(`Veo: ${String(st.error.message ?? JSON.stringify(st.error)).slice(0, 300)}`);
    if (st.done) {
      const uri = st.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
      if (!uri) throw new PermanentError(`Veo não devolveu vídeo (pode ter sido bloqueado pelos filtros): ${JSON.stringify(st.response ?? {}).slice(0, 200)}`);
      return { video: await download(uri, { 'x-goog-api-key': key }), billedSec: 8 };
    }
    await onStatus?.('A gerar no Google Veo');
  }
}

/** Corre um fornecedor. `audioSec` serve para o InfiniteTalk calcular o número de fotogramas. */
export async function runProvider(p: TalkingProvider, a: { imageUrl: string; audioUrl: string; image: Buffer; text: string; audioSec: number }, onStatus?: (s: string) => Promise<void>) {
  switch (p.id) {
    case 'omnihuman': return falRun('fal-ai/bytedance/omnihuman/v1.5', { image_url: a.imageUrl, audio_url: a.audioUrl, resolution: '720p' }, onStatus);
    case 'fabric': return falRun('veed/fabric-1.0', { image_url: a.imageUrl, audio_url: a.audioUrl, resolution: '720p' }, onStatus);
    case 'infinitalk': return falRun('fal-ai/infinitalk', { image_url: a.imageUrl, audio_url: a.audioUrl, prompt: 'A podcast host speaking naturally to the camera, subtle head and hand movement.', resolution: '480p', num_frames: Math.min(721, Math.max(41, Math.round(a.audioSec * 25) + 5)) }, onStatus);
    case 'heygen': return wavespeedHeygen(a.imageUrl, a.audioUrl, onStatus);
    case 'veo': return veo(a.image, a.text, onStatus);
    default: throw new PermanentError(`Fornecedor desconhecido: ${p.id}`);
  }
}
