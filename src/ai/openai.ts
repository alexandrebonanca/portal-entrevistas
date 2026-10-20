import { config } from '../config.ts';
import { S } from '../settings.ts';
import { makeToneWav, toMp3ForTranscription } from '../media.ts';
import { SCRIPT_SYSTEM, SUBTITLE_SYSTEM, COVER_SYSTEM, REVIEW_SYSTEM, PROMPT_VERSIONS } from './prompts.ts';

/** Todo o acesso à OpenAI está aqui, só no servidor. Com AI_MOCK=1 nada sai da máquina. */
let client: any, clientKey = '';
async function openai() {
  if (config.openai.mock) throw new Error('mock');
  const key = S('OPENAI_API_KEY');
  if (!key) throw new Error('OPENAI_API_KEY não configurada');
  if (!client || clientKey !== key) { const { default: OpenAI } = await import('openai'); client = new OpenAI({ apiKey: key, maxRetries: 0, timeout: 180_000 }); clientKey = key; }
  return client;
}
export const aiAvailable = () => config.openai.mock || !!S('OPENAI_API_KEY');

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

async function chatJson(system: string, user: string): Promise<any> {
  const c = await openai();
  const r = await c.chat.completions.create({
    model: config.openai.models.text, temperature: 0.2, response_format: { type: 'json_object' },
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  });
  return JSON.parse(r.choices[0].message.content ?? '{}');
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

export async function prepareEnglishScript(input: ScriptInput) {
  let raw: any;
  if (config.openai.mock) {
    const segs: any[] = [{ id: 's0', speakerRole: 'host', textEnglish: `Welcome. Today: ${input.title}.`, sourceQuestionId: null, transformationType: 'editorial_intro' }];
    input.items.forEach((it, i) => {
      segs.push({ id: `q${i}`, speakerRole: 'host', textEnglish: `(EN) ${it.question}`, sourceQuestionId: it.questionId, transformationType: 'translated_question' });
      if (it.status === 'answered') segs.push({ id: `a${i}`, speakerRole: 'guest', textEnglish: `(EN) ${it.answer}`, sourceQuestionId: it.questionId, transformationType: 'translated_answer' });
    });
    segs.push({ id: 'sx', speakerRole: 'host', textEnglish: 'Thank you for listening.', sourceQuestionId: null, transformationType: 'editorial_outro' });
    raw = { titleEnglish: input.title, segments: segs, reviewFlags: [], blockingIssues: [] };
  } else {
    raw = await chatJson(SCRIPT_SYSTEM, `<interview_data>\n${JSON.stringify(input)}\n</interview_data>`);
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

export async function reviewScript(transcriptSummary: unknown, script: unknown) {
  if (config.openai.mock) return { issues: [] as any[] };
  const r = await chatJson(REVIEW_SYSTEM, `<interview_data>\n${JSON.stringify({ transcript: transcriptSummary, script })}\n</interview_data>`);
  return { issues: Array.isArray(r.issues) ? r.issues : [] };
}

export async function translateSubtitleCues(cues: { id: string; text: string }[], target: string) {
  if (config.openai.mock) return cues.map(c => ({ sourceCueId: c.id, translatedText: `[${target}] ${c.text}`, reviewFlags: [] as string[] }));
  const out: { sourceCueId: string; translatedText: string; reviewFlags: string[] }[] = [];
  for (let i = 0; i < cues.length; i += 60) {
    const r = await chatJson(SUBTITLE_SYSTEM.replace(/TARGET_LANGUAGE/g, target), `<interview_data>\n${JSON.stringify(cues.slice(i, i + 60))}\n</interview_data>`);
    for (const c of Array.isArray(r.cues) ? r.cues : []) out.push({ sourceCueId: String(c.sourceCueId), translatedText: String(c.translatedText ?? ''), reviewFlags: c.reviewFlags ?? [] });
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

/** Retrato fotográfico de uma pessoa FICTÍCIA (não baseada em ninguém real), para testes. */
export async function generateFictionalPortrait(): Promise<Buffer> {
  const { default: sharp } = await import('sharp');
  if (config.openai.mock) return sharp({ create: { width: 512, height: 512, channels: 3, background: '#6b4a32' } }).jpeg().toBuffer();
  const c = await openai();
  const r = await c.images.generate({ model: config.openai.models.image, size: '1536x1024',
    prompt: 'Photorealistic medium shot, from the waist up, of a fictional middle-aged podcast host who does not exist and does not resemble any real or famous person, seated at a wooden desk in a warm, softly lit studio. Body angled about 15 degrees towards the camera, face towards the camera, relaxed confident posture, BOTH HANDS fully visible and relaxed on the desk in front of the torso, mouth closed, neutral friendly expression. Small podcast microphone on a low stand to the side, not covering the face or hands. Landscape 16:9 framing with space around the hands. No text, no logos.' });
  const b64 = r.data?.[0]?.b64_json;
  const buf = b64 ? Buffer.from(b64, 'base64') : Buffer.from(await (await fetch(r.data?.[0]?.url)).arrayBuffer());
  return sharp(buf).resize(1280, 720, { fit: 'cover', position: 'attention' }).jpeg({ quality: 88 }).toBuffer();
}

export async function coverBriefing(title: string, objective: string) {
  if (config.openai.mock) return { backgroundPromptEnglish: 'abstract warm gradient with soft shapes', palette: ['#1c1a17', '#c8803c'], layoutHints: 'title lower third', negativeConstraints: ['no text'] };
  return chatJson(COVER_SYSTEM, `<interview_data>\n${JSON.stringify({ title, objective })}\n</interview_data>`);
}

export async function generateCoverBackground(briefing: { backgroundPromptEnglish: string; negativeConstraints?: string[] }): Promise<Buffer | null> {
  if (config.openai.mock) return null; // o compositor usa um fundo determinístico
  const c = await openai();
  const prompt = `${briefing.backgroundPromptEnglish}. Editorial illustration for a podcast cover. No text, no letters, no logos, no people's faces. Avoid: ${(briefing.negativeConstraints ?? []).join(', ')}`;
  const r = await c.images.generate({ model: config.openai.models.image, prompt, size: '1024x1024' });
  const b64 = r.data?.[0]?.b64_json;
  if (b64) return Buffer.from(b64, 'base64');
  const url = r.data?.[0]?.url;
  if (url) { const res = await fetch(url); return Buffer.from(await res.arrayBuffer()); }
  return null;
}
