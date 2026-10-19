import { config } from './config.ts';
import { S } from './settings.ts';
import { makeToneWav } from './media.ts';
import { PermanentError } from './jobs.ts';

/**
 * Sincronização labial experimental através da Replicate (modelo configurável; por omissão cjwbw/sadtalker).
 * Usada apenas no Laboratório, com um retrato FICTÍCIO. Pessoas reais exigiriam autorização específica para animar o retrato.
 */
const API = 'https://api.replicate.com/v1';
export const lipsyncModel = () => S('REPLICATE_LIPSYNC_MODEL') || 'cjwbw/sadtalker';
// Preço por segundo de GPU (estimativa; a Replicate cobra pelo tempo de execução no hardware do modelo).
export const replicatePricePerSec = () => Number(S('REPLICATE_PRICE_PER_SEC') || 0.0014);

async function rq(path: string, init: RequestInit = {}) {
  const token = S('REPLICATE_API_TOKEN');
  if (!token) throw new Error('REPLICATE_API_TOKEN não configurado');
  const res = await fetch(`${API}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  const j: any = await res.json().catch(() => ({}));
  const msg = `Replicate ${res.status}: ${j?.detail ?? j?.title ?? 'erro'}`;
  // Sem crédito, token inválido, pedido inválido: repetir não resolve (e gastaria noutros serviços).
  if (!res.ok) throw res.status >= 400 && res.status < 500 && res.status !== 429 ? new PermanentError(msg) : new Error(msg);
  return j;
}

export async function replicateAccount() { return rq('/account'); }

const pick = (props: Record<string, any>, names: string[]) => names.find(n => n in props);

export interface LipsyncResult { video: Buffer; predictSec: number | null; estCostUsd: number | null; model: string; version: string; predictionId: string }

export async function lipsync(image: { data: Buffer; mime: string }, audio: { data: Buffer; mime: string }, onStatus?: (s: string) => Promise<void>): Promise<LipsyncResult> {
  const modelName = lipsyncModel();
  const model = await rq(`/models/${modelName}`);
  const version = model.latest_version?.id;
  if (!version) throw new Error(`Modelo ${modelName} sem versão publicada`);
  const props = model.latest_version?.openapi_schema?.components?.schemas?.Input?.properties ?? {};
  const imgKey = pick(props, ['source_image', 'image', 'face', 'input_image', 'portrait']);
  const audKey = pick(props, ['driven_audio', 'audio', 'input_audio', 'audio_file']);
  if (!imgKey || !audKey) throw new Error(`Não reconheço as entradas do modelo ${modelName} (${Object.keys(props).join(', ')})`);
  const input: Record<string, any> = {
    [imgKey]: `data:${image.mime};base64,${image.data.toString('base64')}`,
    [audKey]: `data:${audio.mime};base64,${audio.data.toString('base64')}`,
  };
  // Opções do SadTalker, se existirem: corpo inteiro (não recortar), com melhoria de rosto e movimento natural da cabeça.
  if ('preprocess' in props) input.preprocess = 'full';
  if ('enhancer' in props) input.enhancer = 'gfpgan';
  if ('use_enhancer' in props) input.use_enhancer = true;
  if ('still_mode' in props) input.still_mode = false;
  let p = await rq('/predictions', { method: 'POST', headers: { Prefer: 'wait=55' }, body: JSON.stringify({ version, input }) });
  const t0 = Date.now();
  while (['starting', 'processing'].includes(p.status)) {
    if (Date.now() - t0 > 15 * 60_000) throw new Error('Tempo excedido à espera da Replicate');
    await onStatus?.(p.status === 'starting' ? 'A arrancar o modelo (pode demorar no arranque a frio)' : 'A animar o retrato');
    await new Promise(r => setTimeout(r, 4000));
    p = await rq(`/predictions/${p.id}`);
  }
  if (p.status !== 'succeeded') throw new Error(`Replicate: ${p.status} — ${String(p.error ?? '').slice(0, 300)}`);
  const url = Array.isArray(p.output) ? p.output[p.output.length - 1] : typeof p.output === 'object' && p.output ? Object.values(p.output).find(v => typeof v === 'string') : p.output;
  if (typeof url !== 'string') throw new Error('A Replicate não devolveu um vídeo');
  const vr = await fetch(url);
  if (!vr.ok) throw new Error(`Falha a descarregar o resultado (${vr.status})`);
  const predictSec = p.metrics?.predict_time ?? null;
  return { video: Buffer.from(await vr.arrayBuffer()), predictSec, estCostUsd: predictSec != null ? predictSec * replicatePricePerSec() : null, model: modelName, version, predictionId: p.id };
}

/** Modo simulado (AI_MOCK): não contacta a Replicate. */
export const lipsyncMock = () => config.openai.mock;
export const mockAudio = () => ({ data: makeToneWav(2), mime: 'audio/wav' });
