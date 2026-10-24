import { config } from '../config.ts';
import { S } from '../settings.ts';
import { makeToneWav, toMp3ForTranscription } from '../media.ts';
import { SCRIPT_SYSTEM, SUBTITLE_SYSTEM, COVER_SYSTEM, REVIEW_SYSTEM, PROMPT_VERSIONS } from './prompts.ts';
import { SCRIPT_SEGMENT_MAX, milhares } from '../limits.ts';

/** Todo o acesso à OpenAI está aqui, só no servidor. Com AI_MOCK=1 nada sai da máquina. */
let client: any, clientKey = '';
/** Nada foi pedido à OpenAI (modo simulado ou sem chave). */
class AiNotCalled extends Error {}
async function openai() {
  if (config.openai.mock) throw new AiNotCalled('mock');
  const key = S('OPENAI_API_KEY');
  if (!key) throw new AiNotCalled('OPENAI_API_KEY não configurada');
  if (!client || clientKey !== key) { const { default: OpenAI } = await import('openai'); client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 180_000 }); clientKey = key; }
  return client;
}
export const aiAvailable = () => config.openai.mock || !!S('OPENAI_API_KEY');

/**
 * A chamada falhou sem resposta do fornecedor, e por isso sem custo: sem ligação (ou sem resposta no tempo do pedido),
 * limite de pedidos (429) ou erro 5xx da OpenAI, ou nada chegou a ser pedido (modo simulado, sem chave). Só nestes casos
 * uma vez gasta de uma ação com total (a verificação do guião da entrevista grátis) volta: uma resposta que chegou e falhou
 * depois (JSON cortado ou inválido, conteúdo inesperado) já foi paga, e o texto do pedido, escrito por quem pede, serve
 * para a provocar.
 */
export async function aiNotAnswered(e: unknown): Promise<boolean> {
  if (e instanceof AiNotCalled) return true;
  const { APIConnectionError, RateLimitError, InternalServerError } = await import('openai');
  return e instanceof APIConnectionError || e instanceof RateLimitError || e instanceof InternalServerError;
}

async function toFile(data: Buffer, name: string, type: string) {
  const { toFile } = await import('openai');
  return toFile(data, name, { type });
}

export async function transcribeAudio(data: Buffer, ext: string, language?: string) {
  if (config.openai.mock) return { text: `[mock transcript, ${data.length} bytes]`, language: language ?? 'pt' };
  const c = await openai();
  const mp3 = await toMp3ForTranscription(data, ext);
  const r = await c.audio.transcriptions.create({
    file: await toFile(mp3, 'audio.mp3', 'audio/mpeg'),
    model: config.openai.models.transcribe,
    ...(language && language !== 'auto' ? { language: language.slice(0, 2) } : {}),
  });
  return { text: String(r.text ?? '').trim(), language: language ?? 'auto' };
}

export interface Word { word: string; start: number; end: number }
/** Transcrição com carimbos de tempo por palavra, usada sobre o áudio SINTÉTICO final de cada segmento. */
export async function transcribeWords(data: Buffer, ext: string): Promise<Word[]> {
  if (config.openai.mock) return [];
  const c = await openai();
  const mp3 = await toMp3ForTranscription(data, ext);
  const r = await c.audio.transcriptions.create({
    file: await toFile(mp3, 'seg.mp3', 'audio/mpeg'),
    model: config.openai.models.transcribeTimestamps, response_format: 'verbose_json', timestamp_granularities: ['word'],
  });
  return (r.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end }));
}

/** Transcrição de um clipe: palavras com tempos (para cortes e legendas) e texto completo, com símbolos (para comparar). */
export async function transcribeClip(data: Buffer, ext: string): Promise<{ words: Word[]; text: string }> {
  if (config.openai.mock) return { words: [], text: '' };
  const c = await openai();
  const mp3 = await toMp3ForTranscription(data, ext);
  const r = await c.audio.transcriptions.create({
    file: await toFile(mp3, 'clip.mp3', 'audio/mpeg'),
    model: config.openai.models.transcribeTimestamps, response_format: 'verbose_json', timestamp_granularities: ['word'], language: 'en',
  });
  return { words: (r.words ?? []).map((w: any) => ({ word: w.word, start: w.start, end: w.end })), text: String(r.text ?? '') };
}

/**
 * Resposta cortada pelo teto de tokens (ou pelo máximo do modelo): chegou, foi paga e, com a mesma entrada, voltaria a
 * cortar-se. Quem a recebe não repete o trabalho às cegas (legendas: fica o inglês do bloco; guião: erro permanente).
 */
export class AiCutError extends Error {}

/**
 * Tokens de texto gastos (entrada e saída), para o usage_ledger: os da resposta (`usage`) ou, sem eles (modo simulado),
 * estimados pelos caracteres (~3 por token). Conta-se também a resposta cortada ou inválida, que foi paga.
 */
export interface TokenMeter { input: number; output: number }
export const newMeter = (): TokenMeter => ({ input: 0, output: 0 });
const estTokens = (s: string) => Math.ceil(s.length / 3);
const meterEst = (m: TokenMeter | undefined, input: string, output: string) => { if (m) { m.input += estTokens(input); m.output += estTokens(output); } };
/** Custo estimado dos tokens medidos (preços da configuração, entrada e saída em separado). */
export const meterUsd = (m: TokenMeter) => (m.input * config.prices.textInPer1kTokens + m.output * config.prices.textOutPer1kTokens) / 1000;

/** Máximo de saída do modelo de texto (gpt-4.1). */
export const TEXT_MODEL_MAX_OUT = 32_768;
/**
 * Teto de tokens da resposta proporcional à entrada: `base` (estrutura do JSON) mais 2 tokens por cada 3 caracteres do texto
 * a reescrever (o inglês dá ~4 caracteres por token e as traduções ~3, com o texto ~20% mais longo: folga de ~1,7×), no
 * máximo o do modelo. Antes, as traduções, o guião e o resumo da capa iam sem teto: uma resposta enorme, provocável pelo texto
 * do guião editado à mão, pagava-se por inteiro e, cortada, repetia o trabalho do episódio até 3 vezes.
 */
export const outputCap = (base: number, chars: number) => Math.min(TEXT_MODEL_MAX_OUT, Math.ceil(base + (chars * 2) / 3));
/** Bloco de legendas: ~30 tokens de estrutura por legenda (id, texto, alertas) e o texto a traduzir. */
export const subtitleMaxTokens = (cues: { text: string }[]) => outputCap(300 + 30 * cues.length, cues.reduce((a, c) => a + c.text.length, 0));
/** Guião: ~150 tokens de estrutura por pergunta (pergunta, resposta e transição, com os ids) e o texto da entrevista. */
export const scriptMaxTokens = (input: ScriptInput) => outputCap(1500 + 150 * input.items.length, JSON.stringify(input).length);
/** Resumo da capa: JSON curto (descrição do fundo, paleta, notas), que não cresce com o objetivo para lá do texto dele. */
export const coverMaxTokens = (title: string, objective: string) => outputCap(800, String(title ?? '').length + String(objective ?? '').length);

async function chatJson(system: string, user: string, maxTokens: number, meter?: TokenMeter): Promise<any> {
  const c = await openai();
  const r = await c.chat.completions.create({
    model: config.openai.models.text, temperature: 0.2, response_format: { type: 'json_object' }, max_completion_tokens: maxTokens,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  const ch = r?.choices?.[0];
  const content = String(ch?.message?.content ?? '');
  if (meter) {
    meter.input += Number(r?.usage?.prompt_tokens) || estTokens(system + user);
    meter.output += Number(r?.usage?.completion_tokens) || estTokens(content);
  }
  // Resposta cortada pelo teto de tokens (ou pelo máximo do modelo): o JSON vem incompleto; falha com a causa.
  if (ch?.finish_reason === 'length') throw new AiCutError('resposta da IA cortada pelo teto de tokens');
  return JSON.parse(content || '{}');
}

export interface ScriptInput {
  title: string; objective: string;
  items: { questionId: string; question: string; status: 'answered' | 'refused'; answer: string }[];
}
export interface ScriptSegment {
  id: string; speakerRole: 'host' | 'guest'; textEnglish: string; sourceQuestionId: string | null;
  transformationType: string; editorialFlags?: string[];
}
const TYPES = new Set(['translated_question', 'translated_answer', 'editorial_intro', 'editorial_transition', 'editorial_outro']);

export async function prepareEnglishScript(input: ScriptInput, meter?: TokenMeter) {
  let raw: any;
  if (config.openai.mock) {
    const segs: any[] = [{ id: 's0', speakerRole: 'host', textEnglish: `Welcome. Today: ${input.title}.`, sourceQuestionId: null, transformationType: 'editorial_intro' }];
    input.items.forEach((it, i) => {
      segs.push({ id: `q${i}`, speakerRole: 'host', textEnglish: `(EN) ${it.question}`, sourceQuestionId: it.questionId, transformationType: 'translated_question' });
      if (it.status === 'answered') segs.push({ id: `a${i}`, speakerRole: 'guest', textEnglish: `(EN) ${it.answer}`, sourceQuestionId: it.questionId, transformationType: 'translated_answer' });
    });
    segs.push({ id: 'sx', speakerRole: 'host', textEnglish: 'Thank you for listening.', sourceQuestionId: null, transformationType: 'editorial_outro' });
    raw = { titleEnglish: input.title, segments: segs, reviewFlags: [], blockingIssues: [] };
    meterEst(meter, SCRIPT_SYSTEM + JSON.stringify(input), JSON.stringify(raw));
  } else {
    raw = await chatJson(SCRIPT_SYSTEM, `<interview_data>\n${JSON.stringify(input)}\n</interview_data>`, scriptMaxTokens(input), meter);
  }
  return { ...validateScript(raw, input), model: config.openai.mock ? 'mock' : config.openai.models.text, promptVersion: PROMPT_VERSIONS.script };
}

/** Validação em código: o prompt não é garantia suficiente. */
export function validateScript(raw: any, input?: ScriptInput) {
  const blocking: string[] = Array.isArray(raw?.blockingIssues) ? raw.blockingIssues.map(String) : [];
  const flags: { segmentId: string; reason: string }[] = Array.isArray(raw?.reviewFlags) ? raw.reviewFlags.map((f: any) => ({ segmentId: String(f.segmentId), reason: String(f.reason) })) : [];
  const known = new Set(input?.items.map(i => i.questionId) ?? []);
  const segments: ScriptSegment[] = [];
  const seen = new Set<string>();
  for (const s of Array.isArray(raw?.segments) ? raw.segments : []) {
    const seg: ScriptSegment = {
      id: String(s.id ?? `x${segments.length}`), speakerRole: s.speakerRole === 'guest' ? 'guest' : 'host',
      textEnglish: String(s.textEnglish ?? '').trim(), sourceQuestionId: s.sourceQuestionId ? String(s.sourceQuestionId) : null,
      transformationType: String(s.transformationType),
    };
    if (seen.has(seg.id)) { seg.id += `_${segments.length}`; }
    seen.add(seg.id);
    if (!TYPES.has(seg.transformationType)) { blocking.push(`Segmento ${seg.id}: tipo inválido`); continue; }
    if (!seg.textEnglish) { blocking.push(`Segmento ${seg.id}: texto vazio`); continue; }
    // Acima do limite de entrada da síntese de voz, o segmento falharia só no trabalho do episódio (depois de pagos os anteriores).
    if (seg.textEnglish.length > SCRIPT_SEGMENT_MAX) blocking.push(`Segmento ${seg.id}: ${milhares(seg.textEnglish.length)} caracteres, acima do máximo de ${milhares(SCRIPT_SEGMENT_MAX)} da síntese de voz: encurte-o`);
    const editorial = seg.transformationType.startsWith('editorial_');
    if (editorial && seg.speakerRole === 'guest') { blocking.push(`Segmento ${seg.id}: texto editorial atribuído ao convidado`); seg.speakerRole = 'host'; }
    if (!editorial && (!seg.sourceQuestionId || (known.size && !known.has(seg.sourceQuestionId)))) {
      flags.push({ segmentId: seg.id, reason: 'Segmento sem fonte válida: confirmar ou remover' });
    }
    if (seg.transformationType === 'translated_answer' && seg.speakerRole !== 'guest') seg.speakerRole = 'guest';
    segments.push(seg);
  }
  if (!segments.length) blocking.push('Guião vazio');
  return { titleEnglish: String(raw?.titleEnglish ?? input?.title ?? 'Untitled'), segments, reviewFlags: flags, blockingIssues: blocking };
}

/**
 * Assistente da página de ajuda: resposta curta redigida só a partir das entradas da base de conhecimento (o prompt
 * e as entradas vêm de src/assistant.ts). Pedido curto (20 s e HELP_MAX_TOKENS no máximo), para a página não ficar à espera.
 */
export async function answerHelp(system: string, user: string): Promise<{ answer: string; answered: boolean }> {
  const c = await openai();
  return parseHelp(await c.chat.completions.create(helpRequest(system, user), { timeout: 20_000 }));
}
/** Teto de tokens da resposta do assistente (cerca de 120 palavras em JSON cabem com folga): nunca se paga uma resposta longa. */
export const HELP_MAX_TOKENS = 400;
/** Pedido do assistente à OpenAI (separado para os testes verificarem o teto sem chamar a API). */
export const helpRequest = (system: string, user: string) => ({
  model: config.openai.assistantModel, temperature: 0.2, response_format: { type: 'json_object' as const }, max_completion_tokens: HELP_MAX_TOKENS,
  messages: [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }],
});
/**
 * Assistente de composição da página de edição (o prompt vem de src/compose.ts): JSON com sugestões curtas,
 * pedido de 30 s e COMPOSE_MAX_TOKENS no máximo. Uma resposta cortada pelo teto conta como falha.
 */
export async function composeHelp(system: string, user: string): Promise<any> {
  const c = await openai();
  const r = await c.chat.completions.create(composeRequest(system, user), { timeout: 30_000 });
  const ch = r?.choices?.[0];
  if (ch?.finish_reason === 'length') throw new Error('resposta do assistente de composição cortada pelo teto de tokens');
  return JSON.parse(ch?.message?.content ?? '{}');
}
/** Cinco perguntas com a razão de cada uma, ou a revisão de quinze, cabem com folga. */
export const COMPOSE_MAX_TOKENS = 1500;
export const composeRequest = (system: string, user: string) => ({
  model: config.openai.assistantModel, temperature: 0.5, response_format: { type: 'json_object' as const }, max_completion_tokens: COMPOSE_MAX_TOKENS,
  messages: [{ role: 'system' as const, content: system }, { role: 'user' as const, content: user }],
});
/** Resposta do modelo; uma resposta cortada pelo teto de tokens conta como falha (ficam as entradas da pesquisa local). */
export function parseHelp(r: any): { answer: string; answered: boolean } {
  const ch = r?.choices?.[0];
  if (ch?.finish_reason === 'length') throw new Error('resposta do assistente cortada pelo teto de tokens');
  const j = JSON.parse(ch?.message?.content ?? '{}');
  return { answer: String(j.answer ?? '').trim(), answered: j.answered !== false };
}

/** Teto de tokens da verificação do guião (dezenas de problemas assinalados, em JSON, cabem com folga): nunca se paga uma resposta longa. */
export const REVIEW_MAX_TOKENS = 4000;
/**
 * Verificação de fidelidade do guião. Só ficam os problemas que são objetos: antes, com issues=[null] (ou um número), o
 * mapeamento da rota lançava um TypeError depois de a resposta ser paga, e a vez da entrevista grátis voltava.
 */
export async function reviewScript(transcriptSummary: unknown, script: unknown, meter?: TokenMeter) {
  const user = `<interview_data>\n${JSON.stringify({ transcript: transcriptSummary, script })}\n</interview_data>`;
  if (config.openai.mock) { meterEst(meter, REVIEW_SYSTEM + user, '{"issues":[]}'); return { issues: [] as any[] }; }
  const r = await chatJson(REVIEW_SYSTEM, user, REVIEW_MAX_TOKENS, meter);
  return { issues: Array.isArray(r?.issues) ? r.issues.filter((i: unknown) => !!i && typeof i === 'object' && !Array.isArray(i)) : [] };
}

/** Alerta das legendas que ficaram em inglês: a resposta da IA ao bloco delas veio cortada pelo teto ou sem JSON válido. */
export const UNTRANSLATED = 'untranslated';
/**
 * Tradução das legendas, em blocos de 60, cada um com o teto de tokens proporcional ao texto (subtitleMaxTokens). Uma
 * resposta que chegou e não serve (cortada pelo teto, JSON inválido) já foi paga e repetir-se-ia com o mesmo texto: as
 * legendas desse bloco ficam em inglês, com o alerta UNTRANSLATED, e o trabalho segue. Antes, sem teto, a resposta cortada
 * lançava um erro comum e o trabalho do episódio repetia-se até 3 vezes, pagando outra vez os tempos das legendas e as
 * traduções. Sem resposta do fornecedor (ligação, 429, 5xx), o erro sobe como antes.
 */
export async function translateSubtitleCues(cues: { id: string; text: string }[], target: string, meter?: TokenMeter) {
  const out: { sourceCueId: string; translatedText: string; reviewFlags: string[] }[] = [];
  const system = SUBTITLE_SYSTEM.replace(/TARGET_LANGUAGE/g, target);
  for (let i = 0; i < cues.length; i += 60) {
    const block = cues.slice(i, i + 60);
    const user = `<interview_data>\n${JSON.stringify(block)}\n</interview_data>`;
    if (config.openai.mock) {
      const tr = block.map(c => ({ sourceCueId: c.id, translatedText: `[${target}] ${c.text}`, reviewFlags: [] as string[] }));
      meterEst(meter, system + user, JSON.stringify({ cues: tr }));
      out.push(...tr);
      continue;
    }
    let r: any;
    try { r = await chatJson(system, user, subtitleMaxTokens(block), meter); }
    catch (e) {
      if (!(e instanceof AiCutError) && !(e instanceof SyntaxError)) throw e;
      out.push(...block.map(c => ({ sourceCueId: c.id, translatedText: c.text, reviewFlags: [UNTRANSLATED] })));
      continue;
    }
    for (const c of Array.isArray(r?.cues) ? r.cues : []) if (c && typeof c === 'object') out.push({ sourceCueId: String(c.sourceCueId), translatedText: String(c.translatedText ?? ''), reviewFlags: Array.isArray(c.reviewFlags) ? c.reviewFlags.map(String) : [] });
  }
  return out;
}

/** Vozes do episódio por papel e género escolhido pelo entrevistador (sempre distintas entre os dois papéis). */
export const EPISODE_VOICES = {
  host: { male: process.env.OPENAI_VOICE_HOST_MALE ?? 'ash', female: process.env.OPENAI_VOICE_HOST_FEMALE ?? 'coral' },
  guest: { male: process.env.OPENAI_VOICE_GUEST_MALE ?? 'onyx', female: process.env.OPENAI_VOICE_GUEST_FEMALE ?? 'shimmer' },
} as const;
export const episodeVoice = (role: 'host' | 'guest', gender: string) => EPISODE_VOICES[role][gender === 'male' ? 'male' : 'female'];

export async function synthesizeSpeech(text: string, role: 'host' | 'guest', voice?: string): Promise<{ data: Buffer; ext: string; mime: string }> {
  if (config.openai.mock) return { data: makeToneWav(Math.max(1, Math.min(8, text.length / 18)), role === 'host' ? 330 : 220), ext: 'wav', mime: 'audio/wav' };
  const c = await openai();
  const r = await c.audio.speech.create({
    model: config.openai.models.speech, voice: voice ?? config.openai.voices[role], input: text, response_format: 'mp3',
    instructions: role === 'host' ? 'Warm, clear podcast host. Neutral and professional.' : 'Natural, conversational. Do not exaggerate emotion.',
  });
  return { data: Buffer.from(await r.arrayBuffer()), ext: 'mp3', mime: 'audio/mpeg' };
}

export const READING_VOICES = { female: process.env.OPENAI_VOICE_READING_FEMALE ?? 'nova', male: process.env.OPENAI_VOICE_READING_MALE ?? 'ash' } as const;

/** Leitura da pergunta escrita com voz natural (ainda assim gerada por IA e identificada como tal na página). */
export async function readQuestion(text: string, gender: 'female' | 'male', lang: string): Promise<{ data: Buffer; ext: string; mime: string; voice: string }> {
  const voice = READING_VOICES[gender] ?? READING_VOICES.female;
  if (config.openai.mock) return { data: makeToneWav(Math.max(1, Math.min(6, text.length / 18)), gender === 'male' ? 180 : 300), ext: 'wav', mime: 'audio/wav', voice };
  const c = await openai();
  const accent = lang === 'en' ? 'Speak natural, neutral English.' : 'Fale em português europeu (de Portugal), com pronúncia de Lisboa, nunca com sotaque brasileiro.';
  const r = await c.audio.speech.create({
    model: config.openai.models.speech, voice, input: text, response_format: 'mp3',
    instructions: `${accent} Read this interview question the way a friendly, attentive interviewer would ask it in person: natural pace, warm tone, natural pauses at commas, a slight rising intonation at the end of a question. Do not sound like an announcer or a robot; no exaggerated emotion.`,
  });
  return { data: Buffer.from(await r.arrayBuffer()), ext: 'mp3', mime: 'audio/mpeg', voice };
}

/**
 * Qualidade das imagens do gpt-image-1 (OPENAI_IMAGE_QUALITY, 'medium' por omissão, o preço de PRICE_IMAGE_EACH, ~0,04 USD
 * a 1024×1024). Antes ia sem qualidade ('auto', que pode ser a alta, ~0,17 USD). Só nos modelos gpt-image (os outros
 * modelos de imagem não aceitam estes valores).
 */
export const imageQuality = () => (/^gpt-image/.test(config.openai.models.image) ? { quality: config.openai.imageQuality } : {});

/** Retrato fotográfico de uma pessoa FICTÍCIA (não baseada em ninguém real), para testes. */
export async function generateFictionalPortrait(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  if (config.openai.mock) return sharp({ create: { width: 512, height: 512, channels: 3, background: '#6b4a32' } }).jpeg().toBuffer();
  const c = await openai();
  const r = await c.images.generate({ model: config.openai.models.image, size: '1536x1024', ...imageQuality(),
    prompt: 'Photorealistic medium shot, from the waist up, of a fictional middle-aged podcast host who does not exist and does not resemble any real or famous person, seated at a wooden desk in a warm, softly lit studio. Body angled about 15 degrees towards the camera, face towards the camera, relaxed confident posture, BOTH HANDS fully visible and relaxed on the desk in front of the torso, mouth closed, neutral friendly expression. Small podcast microphone on a low stand to the side, not covering the face or hands. Landscape 16:9 framing with space around the hands. No text, no logos.' });
  const b64 = r.data?.[0]?.b64_json;
  const buf = b64 ? Buffer.from(b64, 'base64') : Buffer.from(await (await fetch(r.data?.[0]?.url)).arrayBuffer());
  return sharp(buf).resize(1280, 720, { fit: 'cover', position: 'attention' }).jpeg({ quality: 88 }).toBuffer();
}

export async function coverBriefing(title: string, objective: string, meter?: TokenMeter) {
  const user = `<interview_data>\n${JSON.stringify({ title, objective })}\n</interview_data>`;
  if (config.openai.mock) {
    const brief = { backgroundPromptEnglish: 'abstract warm gradient with soft shapes', palette: ['#1c1a17', '#c8803c'], layoutHints: 'title lower third', negativeConstraints: ['no text'] };
    meterEst(meter, COVER_SYSTEM + user, JSON.stringify(brief));
    return brief;
  }
  return chatJson(COVER_SYSTEM, user, coverMaxTokens(title, objective), meter);
}

export async function generateCoverBackground(briefing: { backgroundPromptEnglish: string; negativeConstraints?: string[] }): Promise<Buffer | null> {
  if (config.openai.mock) return null; // o compositor usa um fundo determinístico
  const c = await openai();
  const prompt = `${briefing.backgroundPromptEnglish}. Editorial illustration for a podcast cover. No text, no letters, no logos, no people's faces. Avoid: ${(briefing.negativeConstraints ?? []).join(', ')}`;
  const r = await c.images.generate({ model: config.openai.models.image, prompt, size: '1024x1024', ...imageQuality() });
  const b64 = r.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, 'base64');
  const url = r.data?.[0]?.url;
  if (url) { const res = await fetch(url); return Buffer.from(await res.arrayBuffer()); }
  return null;
}
