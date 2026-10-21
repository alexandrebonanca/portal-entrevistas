import { config } from './config.ts';
import { storage } from './storage.ts';
import { sha256, esc } from './lib.ts';
import { saveAsset, hasAudioStream } from './media.ts';
import { transcribeClip, translateSubtitleCues, aiAvailable, type Word } from './ai/openai.ts';
import { renderBases, subtitleFrame, encodeComposite, buildAudioTrack, mockTalkingClip, type Part, type Shot, type Scene, type AudioPiece } from './video.ts';
import { cuesFromWords } from './subtitles.ts';
import { peopleOf, cardBackground, titleCard, endCard, chapterTitles, planGraphics, graphicsOverlays, graphicsMeta, TITLE_CARD_MS, END_CARD_MS, type GfxSpan } from './graphics.ts';
import { veoSubmit, veoAwait, veoEpisodePrompt, VeoQuotaError, VeoCancelled, VeoBusy, VeoFiltered, VeoOpError, VeoUnsupported, VeoCredsMissing, isKeyRejected, opOfCurrentCreds, veoTier, veoModel, veoBackend, veoConfigured, veoCredsScope, veoScopeId, veoPricePerSec, veoPriceOfModel, veoKeyModel, veoLabel, tierOfModel, type VeoTier } from './talking.ts';
import { ownsAny, entityOfInterview, VEO_CRED_KEYS } from './settings.ts';
import { PermanentError, JobPaused, type Handler } from './jobs.ts';
import type { Db } from './db.ts';
import { flushOutbox, queueEmail, emailShell } from './mail.ts';
import { release, settle, cr } from './wallet.ts';

/**
 * Vídeo do episódio inteiramente com o Google Veo: cada fala autorizada é dividida em pedaços que cabem num clipe
 * (até 8 s), o Veo gera imagem E voz a partir da fotografia autorizada e do texto aprovado, e os clipes são colados.
 * O som do vídeo é o dos clipes (não o áudio sintético do episódio). Cada clipe é transcrito e comparado palavra a
 * palavra com o guião: só entra no vídeo um clipe que diga o texto aprovado (toleram-se apenas grafias de nomes e
 * variantes ortográficas, nunca negações nem números). Se não disser, é gerado de novo (no máximo `veoRetries`
 * vezes); sem clipe aprovado, essa fala fica com a fotografia fixa e a voz do episódio. As legendas seguem o que foi dito.
 */

export const VEO_MAX_WORDS = 15; // palavras FALADAS (~6 s a 2,5/s): cabe num clipe de 8 s com folga
/** Máximo de um pedaço com uma cauda de 1–3 palavras colada (decisão do juiz: nunca um clipe só para a cauda). */
export const VEO_HARD_MAX_WORDS = 18;
const VEO_TAIL_WORDS = 3;
export const VEO_NOTICE = 'AI-generated video · AI voice';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Palavras efetivamente ditas: anos, decimais, números e siglas valem mais do que um token escrito. */
function spokenToken(tok: string): number {
  const t = tok.replace(/^[("'“‘]+|[)"'”’.,;:!?]+$/g, '');
  if (!t) return 0;
  let n: number;
  if (/[a-z]\.[a-z]/i.test(t) || /^https?:|\//i.test(t)) n = t.split(/[./:\-_@]+/).filter(Boolean).length * 2; // www.x.com/y → «www dot x dot com slash y»
  else if (/^\d{4}s?$/.test(t)) n = 3;                                // 2023 → twenty twenty-three
  else if (/\d[.,]\d/.test(t)) n = 3 + Math.max(0, t.replace(/\D/g, '').length - 2); // 3.5 → three point five
  else if (/\d/.test(t)) { const d = t.replace(/\D/g, '').length; n = d <= 2 ? 1 : d <= 3 ? 2 : 3; }
  else if (/^[A-Z]{2,6}s?$/.test(t)) n = t.replace(/s$/, '').length; // EU → E U
  else n = 1;
  if (t.includes('%')) n += 1;
  if (t.includes('&')) n += 1;
  if (/[€$£¥]/.test(t)) n += 1;
  return n;
}
export const spokenCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).reduce((a, w) => a + spokenToken(w), 0);
const snap = (ms: number) => Math.round(ms / 40) * 40; // 25 fps: cortes em fotogramas inteiros, sem desvio entre som e imagem

/** Divide o texto por frases, depois por vírgulas e, em último caso, por palavras, sem alterar o texto. */
export function chunkText(text: string, maxWords = VEO_MAX_WORDS): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  const units: string[] = [];
  const byWords = (s: string) => {
    let buf: string[] = [];
    for (const w of s.split(' ')) {
      if (buf.length && spokenCount([...buf, w].join(' ')) > maxWords) { units.push(buf.join(' ')); buf = []; }
      buf.push(w);
    }
    if (buf.length) units.push(buf.join(' '));
  };
  for (const s of clean.split(/(?<=[.!?]["'”’)\]]*)\s+/)) {
    if (spokenCount(s) <= maxWords) { units.push(s); continue; }
    let buf = '';
    for (const p of s.split(/(?<=[,;:])\s+/)) {
      if (spokenCount(p) > maxWords) { if (buf) { units.push(buf); buf = ''; } byWords(p); continue; }
      if (buf && spokenCount(buf) + spokenCount(p) > maxWords) { units.push(buf); buf = p; } else buf = buf ? `${buf} ${p}` : p;
    }
    if (buf) units.push(buf);
  }
  const out: string[] = [];
  let cur = '';
  for (const u of units) { if (cur && spokenCount(cur) + spokenCount(u) > maxWords) { out.push(cur); cur = u; } else cur = cur ? `${cur} ${u}` : u; }
  if (cur) out.push(cur);
  // Caudas: um pedaço de 1–3 palavras ditas cola-se ao anterior (ou ao seguinte) se o conjunto couber em 18 palavras,
  // em vez de pagar um clipe de 4 s por uma ou duas palavras.
  const short = (s: string) => spokenCount(s) <= VEO_TAIL_WORDS;
  const fits = (a: string, b: string) => spokenCount(a) + spokenCount(b) <= VEO_HARD_MAX_WORDS;
  const back: string[] = [];
  for (const c of out) { const p = back[back.length - 1]; if (p !== undefined && short(c) && fits(p, c)) back[back.length - 1] = `${p} ${c}`; else back.push(c); }
  const glued: string[] = [];
  for (let i = 0; i < back.length; i++) { if (short(back[i]) && i + 1 < back.length && fits(back[i], back[i + 1])) { back[i + 1] = `${back[i]} ${back[i + 1]}`; continue; } glued.push(back[i]); }
  return glued;
}

/** Duração a pedir (o Veo cobra a duração pedida): fala estimada a 2,5 palavras/s mais ~1,5 s de entrada e saída. */
export function veoDuration(text: string): 4 | 6 | 8 {
  const sec = spokenCount(text) / 2.5 + 1.5;
  return sec <= 4 ? 4 : sec <= 6 ? 6 : 8;
}
const nextDuration = (d: number): 4 | 6 | 8 => (d <= 4 ? 6 : 8);

// ---------- comparação palavra a palavra ----------
const FILLERS = new Set(['uh', 'um', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm']);
const NEGATIONS = new Set(['not', 'no', 'never', 'nor', 'none', 'nothing', 'nobody', 'neither', 'without', 'nowhere']);
const NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'hundreds', 'thousand', 'thousands', 'million', 'millions', 'billion', 'billions', 'trillion', 'trillions', 'dozen', 'dozens', 'percent', 'half', 'first', 'second', 'third', 'once', 'twice', 'double', 'triple', 'point']);
// Palavras que nunca passam por «outra grafia de um nome» (pronomes e palavras gramaticais curtas).
const STOP = new Set(['i', 'a', 'an', 'and', 'as', 'at', 'he', 'she', 'it', 'is', 'in', 'on', 'or', 'of', 'to', 'we', 'you', 'they', 'his', 'her', 'him', 'me', 'my', 'us', 'our', 'the', 'this', 'that', 'was', 'are', 'be', 'by', 'for', 'with', 'who']);
// Variantes ortográficas britânico/americano numa lista fechada de padrões (nada de «1 letra qualquer»).
const LL_STEMS = new Set(['travel', 'model', 'cancel', 'label', 'level', 'signal', 'fuel', 'total', 'channel', 'counsel', 'dial', 'equal', 'marvel', 'jewel', 'quarrel', 'tunnel', 'panel', 'pencil', 'shovel', 'model']);
const SPELL_FIXED: Record<string, string> = { fulfil: 'fulfill', fulfils: 'fulfills', enrolment: 'enrollment', enrolments: 'enrollments', skilful: 'skillful', instalment: 'installment', instalments: 'installments', judgement: 'judgment', judgements: 'judgments', ageing: 'aging', grey: 'gray', practise: 'practice', practised: 'practiced', practising: 'practicing', programme: 'program', programmes: 'programs', aluminium: 'aluminum', cosy: 'cozy', plough: 'plow', sceptical: 'skeptical' };
// -re → -er só nestas palavras (timbre/timber são palavras diferentes).
const RE_STEMS = new Set(['fib', 'calib', 'cent', 'met', 'lit', 'theat', 'spect', 'sab', 'somb', 'lust', 'meag', 'kilomet', 'centimet', 'millimet', 'manoeuv']);
function spellCanon(w: string): string {
  let x = SPELL_FIXED[w] ?? w;
  if (x.length >= 6) x = x.replace(/isation(s?)$/, 'ization$1').replace(/is(e|es|ed|ing|er|ers)$/, 'iz$1').replace(/ys(e|es|ed|ing)$/, 'yz$1').replace(/our(s|ed|ing|ite|ites|able|ful|hood|hoods|al|less)?$/, 'or$1');
  if (x.length >= 7) x = x.replace(/ence(s)?$/, 'ense$1');
  const re = /^(.+?[bt])r(e|es|ed|ing)$/.exec(x);
  if (re && RE_STEMS.has(re[1])) x = `${re[1]}er${({ e: '', es: 's', ed: 'ed', ing: 'ing' } as Record<string, string>)[re[2]]}`; // fibre → fiber, centred → centered
  if (x.length >= 5) x = x.replace(/ogue(s)?$/, 'og$1');
  const m = /^(.+l)l(ed|ing|er|ers|or|ors)$/.exec(x); // travelled → travel + ed; counsellor → counselor
  if (m && LL_STEMS.has(m[1])) x = `${m[1]}${m[2]}`;
  return x;
}
const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/g, 'can not'], [/\bcannot\b/g, 'can not'], [/\bwon't\b/g, 'will not'], [/\bshan't\b/g, 'shall not'], [/n't\b/g, ' not'],
  [/\bi'm\b/g, 'i am'], [/'re\b/g, ' are'], [/'ve\b/g, ' have'], [/'ll\b/g, ' will'], [/'d\b/g, ' would'],
  [/\b(it|that|what|there|here|he|she|who|where|how|this)'s\b/g, '$1 is'], [/\blet's\b/g, 'let us'],
];
const SMALL_NUMBERS: Record<string, string> = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', thirteen: '13', fourteen: '14', fifteen: '15', sixteen: '16', seventeen: '17', eighteen: '18', nineteen: '19', twenty: '20', thirty: '30', forty: '40', fifty: '50', sixty: '60', seventy: '70', eighty: '80', ninety: '90' };
const SEP_CODE: Record<string, string> = { '.': 'p', ',': 'c', ':': 'k', '/': 's', '-': 'd' };
// Símbolos que se dizem: passam às palavras ditas (assim «<2 bar» e «less than 2 bar» coincidem e «2 bar» não).
const SYMBOL_WORDS: [RegExp, string][] = [
  [/\+\/-|±/g, ' plus or minus '], [/≤|<=/g, ' at most '], [/≥|>=/g, ' at least '], [/</g, ' less than '], [/>/g, ' more than '],
  [/[~≈]/g, ' about '], [/×/g, ' times '], [/¢/g, ' cent '], [/°/g, ' degrees '], [/‰/g, ' per mille '], [/&/g, ' and '],
  [/%/g, ' percent '], [/€/g, ' euro '], [/\$/g, ' dollar '], [/£/g, ' pound '], [/¥/g, ' yen '],
];
export function normWords(s: string): string[] {
  let x = s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, '-');
  for (const [re, r] of CONTRACTIONS) x = x.replace(re, r);
  x = x.replace(/'s\b/g, " 's"); // possessivo à parte: «Ana's» → «ana» + «s» (o nome compara-se sozinho)
  x = x.replace(/(\d),(?=\d{3}\b)/g, '$1'); // 1,000 → 1000
  // Sinal de um número ou de um valor monetário, seja qual for o que vem antes (aspas, parênteses, dois pontos…).
  x = x.replace(/(^|[^\p{L}\p{N}])-(?=[\d€$£¥.])/gu, '$1 minus ').replace(/(^|[^\p{L}\p{N}])\+(?=[\d€$£¥.])/gu, '$1 plus ').replace(/(\d)\+/g, '$1 plus ');
  for (const [re, r] of SYMBOL_WORDS) x = x.replace(re, r);
  // Grupos de algarismos com separadores internos ficam num só token com o separador codificado (2-5 ≠ 2.5 ≠ 2:5).
  x = x.replace(/\d+(?:[.,:/-]\d+)+/g, m => m.replace(/[.,:/-]/g, c => SEP_CODE[c]));
  // Qualquer outro símbolo vira um token próprio: nunca desaparece em silêncio (se faltar no ouvido, o clipe é recusado).
  x = x.replace(/\p{S}/gu, c => ` sym${c.codePointAt(0)} `);
  return x.replace(/[^\p{L}\p{N}']+/gu, ' ').split(' ').map(w => w.replace(/^'+|'+$/g, '')).filter(w => w && !FILLERS.has(w)).map(w => SMALL_NUMBERS[w] ?? w);
}
const charDist = (a: string, b: string) => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
};
const CURRENCY_SIGN = new Set(['euro', 'euros', 'dollar', 'dollars', 'pound', 'pounds', 'yen', 'minus', 'plus', 'percent', 'cent', 'cents', 'less', 'more', 'than', 'most', 'least', 'about', 'times', 'degrees', 'mille']);
const critical = (w: string) => NEGATIONS.has(w) || NUMBER_WORDS.has(w) || CURRENCY_SIGN.has(w) || /\d/.test(w) || /^sym\d+$/.test(w);

/** Nomes das PESSOAS da entrevista (entrevistador e convidado): só estes admitem outra grafia (Ana/Anna, Jose/José). */
export function personNames(names: string[]): Set<string> {
  return new Set(names.flatMap(n => normWords(n)).filter(w => w.length >= 3 && !STOP.has(w)));
}
/** Dos nomes das pessoas, só os que este texto usa como nome (escritos com maiúscula): «will» minúsculo não é o Will. */
export function namesUsedIn(text: string, people: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const tok of text.split(/\s+/)) if (/^[("'“]?\p{Lu}/u.test(tok)) for (const w of normWords(tok)) if (people.has(w)) out.add(w);
  return out;
}

/**
 * Diferenças entre o texto pedido e o ouvido. `hard` conta as que não se toleram: tudo exceto (a) outra grafia do nome de
 * uma das pessoas e (b) uma variante ortográfica britânico/americano de lista fechada (colour/color, realise/realize…).
 * Negações e números nunca se toleram.
 */
export function wordDiff(expected: string, heard: string, names: Set<string> = new Set()) {
  const a = normWords(expected), b = normWords(heard);
  const D: number[][] = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  const diffs: { expected: string; heard: string; tolerated: boolean }[] = [];
  let i = a.length, j = b.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      if (a[i - 1] !== b[j - 1]) {
        const e = a[i - 1], h = b[j - 1];
        const nameVariant = names.has(e) && h.length >= 3 && !STOP.has(h) && h[0] === e[0] && charDist(e, h) <= Math.max(1, Math.floor(e.length / 3));
        const tolerated = !critical(e) && !critical(h) && (nameVariant || spellCanon(e) === spellCanon(h));
        diffs.push({ expected: e, heard: h, tolerated });
      }
      i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) { diffs.push({ expected: a[i - 1], heard: '', tolerated: false }); i--; }
    else { diffs.push({ expected: '', heard: b[j - 1], tolerated: false }); j--; }
  }
  const edits = D[a.length][b.length];
  return { edits, hard: diffs.filter(d => !d.tolerated).length, n: a.length, wer: a.length ? edits / a.length : (b.length ? 1 : 0), diffs: diffs.reverse() };
}
export const fidelityOk = (d: { hard: number; n: number }) => d.n > 0 && d.hard === 0;

/** Janela útil do clipe a partir dos tempos das palavras; tempos incoerentes → clipe inteiro. */
export function trimWindow(words: Word[], clipMs: number, expected: string): { a: number; b: number } {
  const full = { a: 0, b: clipMs };
  if (!words.length) return full;
  const ok = words.every((w, k) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end >= w.start && w.end * 1000 <= clipMs + 150 && (k === 0 || w.start >= words[k - 1].start));
  const span = words[words.length - 1].end - words[0].start;
  if (!ok || span < words.length * 0.12) return full;
  const ew = normWords(expected), hw = normWords(words.map(w => w.word).join(' '));
  const headOk = !!ew.length && ew[0] === hw[0], tailOk = !!ew.length && ew[ew.length - 1] === hw[hw.length - 1];
  const a = Math.max(0, Math.floor((words[0].start * 1000 - (headOk ? 200 : 700)) / 40) * 40);
  const lw = words[words.length - 1], lastEnd = Math.max(lw.end, lw.start + 0.3); // palavra final com duração nula ou curta demais
  const b = Math.min(clipMs, Math.ceil((lastEnd * 1000 + (tailOk ? 350 : 800)) / 40) * 40);
  return b - a >= 400 ? { a, b } : full;
}

/** Clipes e custo previstos (sem e com uma nova tentativa por clipe) ao preço do nível escolhido (Fast ou Lite). */
export function veoEstimate(timing: any[], segments: any[], hostOk: boolean, guestOk: boolean, tier: VeoTier = veoTier()) {
  const usdPerSec = veoPricePerSec(tier);
  const textOf = new Map<string, string>(segments.map((s: any) => [s.id, s.textEnglish]));
  let clips = 0, sec = 0;
  for (const t of timing) {
    if (t.kind === 'disclosure' || !(t.role === 'host' ? hostOk : guestOk)) continue;
    for (const c of chunkText(textOf.get(t.id) ?? '')) { clips++; sec += veoDuration(c); }
  }
  return { clips, sec, usd: sec * usdPerSec, usdMax: clips * 8 * usdPerSec * 2, minutes: Math.ceil(clips / 2) * 1.5 + 2, tier, usdPerSec };
}

type Role = 'host' | 'guest';
type Seg = { id: string; role: Role; kind: string; startMs: number; durationMs: number; endMs: number; text: string };
type Chunk = { seg: Seg; k: number; text: string; dur: 4 | 6 | 8; key: string; prompt: string };
type Attempt = { assetId: string; storageKey: string; words: Word[]; heard: string; checked: boolean; edits: number | null; hard: number | null; dur: number; usdPerSec: number; model: string | null };
/** Fala do plano: texto aprovado, chave de reaproveitamento (sem o modelo), take e pedaços com as chaves. */
export type PlanSeg = Seg & { reuseKey: string | null; take: number; chunks: Chunk[] };
type StartImage = { image: Buffer; vertical: boolean; hash: string };
export interface VeoPlan {
  segs: PlanSeg[]; hostPhoto: Buffer | null; guestPhoto: Buffer | null; hostVeo: boolean; guestVeo: boolean;
  start: Record<Role, StartImage | null>; voice: Record<Role, 'male' | 'female'>; photoSha: Record<Role, string | null>;
}

const passes = (a: Attempt) => a.checked && a.words.length > 0 && a.hard === 0;

/** Imagem inicial: a fotografia rodada (EXIF) e recortada a 16:9, ou a 9:16 se for vertical (mostrada ao centro como os grandes planos). */
async function startImage(photo: Buffer): Promise<StartImage> {
  const { default: sharp } = await import('sharp');
  const upright = await sharp(photo).rotate().toBuffer();
  const m = await sharp(upright).metadata();
  const vertical = (m.height ?? 0) > (m.width ?? 0) * 1.05;
  const image = await sharp(upright).resize(vertical ? 720 : 1280, vertical ? 1280 : 720, { fit: 'cover', position: 'attention' }).jpeg({ quality: 90 }).toBuffer();
  return { image, vertical, hash: sha256(image) };
}

/**
 * Chave de reaproveitamento e de cobrança de uma fala: fotografia original, papel, voz, formato e texto. Não leva o modelo
 * nem o pedido ao Veo: uma fala paga continua paga quando o motor ou o pedido mudam.
 */
export const reuseKeyOf = (o: { photoSha: string; role: string; voice: string; vertical: boolean; text: string }) =>
  sha256(`fala|${o.photoSha}|${o.role}|${o.voice}|${o.vertical ? '9:16' : '16:9'}|${o.text.replace(/\s+/g, ' ').trim()}`);
/** Chave de um pedaço: a de sempre no take 1 (os clipes já pagos continuam a servir); um take novo gera clipes novos. */
export const chunkKeyOf = (imageHash: string, prompt: string, vertical: boolean, keyModel: string, mock: boolean, take = 1) =>
  sha256(`${imageHash}|${prompt}|${vertical ? '9:16' : '16:9'}|${keyModel}|${mock}${take > 1 ? `|take${take}` : ''}`);

/** Take mais alto com clipes rejeitados (defeito objetivo ou gosto do cliente), por fala: o take seguinte gera clipes novos. */
export async function rejectedTakes(db: Db, interviewId: string): Promise<Map<string, number>> {
  const rows = await db.query(`SELECT meta->>'reuseKey' AS k, max(COALESCE((meta->>'take')::int, 1)) AS t FROM assets
    WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'rejected'='true' AND meta->>'reuseKey' IS NOT NULL GROUP BY 1`, [interviewId]);
  return new Map(rows.map((r: any) => [String(r.k), Number(r.t) || 1]));
}

/**
 * Plano do vídeo do Veo, calculado da mesma forma no orçamento e no trabalho: fotografias autorizadas, falas com o texto
 * aprovado, chave de reaproveitamento, take e pedaços com as chaves. `takes` fixa o take de cada fala (o do orçamento).
 */
export async function veoPlan(db: Db, iv: any, ep: any, o: { tier: VeoTier; photoId?: string | null; takes?: Map<string, number> }): Promise<VeoPlan> {
  const mock = config.openai.mock;
  const script = await db.one('SELECT segments FROM scripts WHERE id=$1', [ep.script_id]);
  const textOf = new Map<string, string>((script?.segments ?? []).map((s: any) => [s.id, s.textEnglish]));
  const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
  const photoRow = async (id: string | null | undefined) => (id ? db.one('SELECT id, storage_key, sha256 FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]) : null);
  // Só fotografias autorizadas; o Veo exige ainda a autorização específica de cada pessoa.
  const hostRow = iv.host_photo_rights ? await photoRow(iv.host_photo_asset_id) : null;
  let guestRow: any = null;
  if (await consent('publish_photo')) {
    const pid = o.photoId ?? ep.technical?.coverPhotoIds?.[0] ?? null;
    const ph = pid ? await db.one('SELECT asset_id FROM photos WHERE id=$1 AND interview_id=$2', [pid, iv.id]) : await db.one('SELECT asset_id FROM photos WHERE interview_id=$1 ORDER BY created_at LIMIT 1', [iv.id]);
    guestRow = ph ? await photoRow(ph.asset_id) : null;
  }
  const hostPhoto = hostRow ? await storage.get(hostRow.storage_key) : null;
  const guestPhoto = guestRow ? await storage.get(guestRow.storage_key) : null;
  const hostVeo = !!hostPhoto && !!iv.host_ai_video;
  // O convidado só aparece no Veo se puder ver e aprovar o vídeo antes da publicação (política «o entrevistado aprova»).
  const guestVeo = !!guestPhoto && (await consent('ai_video')) && iv.review_policy === 'guest_preview';
  const start = { host: hostVeo ? await startImage(hostPhoto!) : null, guest: guestVeo ? await startImage(guestPhoto!) : null };
  const voice = { host: iv.question_voice === 'male' ? 'male' : 'female', guest: iv.guest_voice === 'male' ? 'male' : 'female' } as const;
  const photoSha = { host: hostRow?.sha256 ?? null, guest: guestRow?.sha256 ?? null };
  const timing = (ep.technical?.timing ?? []) as any[];
  const rejected = await rejectedTakes(db, iv.id);
  const segs: PlanSeg[] = timing.map((t: any, i: number) => ({ ...t, endMs: i + 1 < timing.length ? timing[i + 1].startMs : ep.duration_ms, text: t.kind === 'disclosure' ? config.aiDisclosure : textOf.get(t.id) ?? '', reuseKey: null, take: 1, chunks: [] }));
  for (const s of segs) {
    const st = start[s.role];
    if (s.kind === 'disclosure' || !st) continue;
    s.reuseKey = reuseKeyOf({ photoSha: photoSha[s.role]!, role: s.role, voice: voice[s.role], vertical: st.vertical, text: s.text });
    s.take = o.takes?.get(s.id) ?? (rejected.get(s.reuseKey) ?? 0) + 1;
    // A chave não inclui a duração: as tentativas com outra duração contam para o mesmo pedaço.
    s.chunks = chunkText(s.text).map((text, k) => {
      const prompt = veoEpisodePrompt({ role: s.role, text, voice: voice[s.role] });
      return { seg: s, k, text, dur: veoDuration(text), prompt, key: chunkKeyOf(st.hash, prompt, st.vertical, veoKeyModel(o.tier), mock, s.take) };
    });
  }
  return { segs, hostPhoto, guestPhoto, hostVeo, guestVeo, start, voice, photoSha };
}

/**
 * Impressão do que um orçamento promete gerar: muda se mudar o episódio, o guião, as fotografias, as vozes, o nível do
 * motor, a língua das legendas ou os pedaços que o código calcula (o orçamento é então anulado antes de qualquer envio).
 */
export function inputsHashOf(ep: any, plan: VeoPlan, tier: VeoTier, lang: string | null, segmentIds: string[]) {
  const pick = new Set(segmentIds);
  const segs = plan.segs.filter(s => pick.has(s.id));
  const roles = new Set(segs.map(s => s.role));
  return sha256(JSON.stringify({ episode: ep.id, script: ep.script_id, tier, lang, photos: [...roles].sort().map(r => [r, plan.photoSha[r]]), voice: [...roles].sort().map(r => [r, plan.voice[r]]),
    segs: segs.map(s => [s.id, s.role, s.text, s.reuseKey, s.take, s.chunks.map(c => c.key)]) }));
}

/** Pedaço ainda sem clipe aprovado depois de todas as tentativas possíveis? (o orçamento passa essa fala a um take novo) */
export async function chunkExhausted(db: Db, interviewId: string, key: string, maxAttempts = VEO_MAX_ATTEMPTS) {
  const clips = await db.query(`SELECT meta FROM assets WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'chunkKey'=$2 AND deleted_at IS NULL AND COALESCE(meta->>'rejected','')<>'true'`, [interviewId, key]);
  if (clips.some((a: any) => a.meta?.checked && (a.meta?.words?.length ?? 0) > 0 && a.meta?.hard === 0)) return false;
  const fails = Number((await db.one(`SELECT count(*)::int AS n FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state IN ('failed','expired','unknown')`, [interviewId, key]))?.n ?? 0);
  return clips.length + fails >= maxAttempts;
}

/** Tentativas por pedaço (1.ª passagem + uma repetição), contadas entre execuções. */
export const VEO_MAX_ATTEMPTS = 2;
/** Canário: dos primeiros 8 pedaços gerados, menos de 4 aprovados param a produção (falha sistémica). */
export const CANARY_CHUNKS = 8;
export const CANARY_MIN_OK = 4;
/** Disjuntor da 2.ª passagem: depois de 10 repetições, menos de 30% aprovadas param as repetições. */
export const BREAKER_RETRIES = 10;
export const BREAKER_MIN_RATE = 0.3;
/** Pausa quando a quota da Google se esgota (o trabalho volta à fila sem falhar). */
export const QUOTA_PAUSE_MS = Number(process.env.VEO_QUOTA_PAUSE_MS ?? 15 * 60_000);

/** Porque é que uma fala ficou em fotografia (relatório da liquidação: nada se cobra por ela). */
export const FALA_REASON: Record<string, string> = {
  mismatch: 'o texto dito não coincidiu com o guião', filtered: 'recusada pelo filtro da Google', google: 'Google indisponível ou erro na geração',
  unchecked: 'não foi possível verificar o clipe', capped_budget: 'teto do orçamento atingido', breaker: 'disjuntor: demasiadas repetições falhadas',
  attempts: 'limite de tentativas esgotado', no_clips: 'os clipes já pagos já não existem',
};
const falaReasonOf = (problem: string | null) =>
  problem === 'busy' || problem === 'busycap' || problem === 'error' ? 'google' : problem === 'capped' ? 'attempts' : problem ?? 'google';
/** Problema de um pedaço no relatório: o teto e o disjuntor prevalecem (foram eles que impediram nova tentativa). */
const unitProblem = (chosen: boolean, hasChecked: boolean, anyUnchecked: boolean, why: string | null) =>
  !chosen && (why === 'capped_budget' || why === 'breaker') ? why : chunkProblem(chosen, hasChecked, anyUnchecked, why ?? undefined);

/** Só para os testes (AI_MOCK): resultado simulado de cada clipe — aprovado, texto diferente, filtrado ou quota esgotada. */
export const veoMock: { outcome: null | ((c: { segmentId: string; role: string; text: string; attempt: number }) => 'ok' | 'mismatch' | 'filtered' | 'quota');
  /** Consulta simulada de uma operação (pode lançar os erros da consulta real, ex.: credenciais recusadas ou retiradas). */
  poll?: null | ((o: { opName: string; scope: string | null; project: string | null }) => Promise<void> | void) } = { outcome: null, poll: null };

/** Perfil e entidade de quem pediu o trabalho (lidos no momento: um perfil retirado entretanto deixa de valer). */
const requesterOf = async (db: Db, userId: unknown): Promise<{ role: string; entity_id: string | null } | null> =>
  (typeof userId === 'string' && /^[0-9a-f-]{36}$/i.test(userId) ? (await db.one('SELECT role, entity_id FROM users WHERE id=$1', [userId])) ?? null : null);

/**
 * Veo sem orçamento nem créditos: o administrador (custo interno) e o gestor de uma entidade com credenciais Google
 * próprias (conta de serviço ou chave Gemini da entidade), nas entrevistas dessa entidade: a Google cobra no projeto dela.
 * Os outros, e o gestor de uma entidade que usa as credenciais do portal, só por orçamento aceite (com créditos).
 */
export const veoWithoutQuote = (user: { role: string; entity_id?: string | null } | null | undefined, interviewEntity: string | null | undefined) =>
  !!user && (user.role === 'admin' || (user.role === 'entity_admin' && !!user.entity_id && user.entity_id === interviewEntity && ownsAny(user.entity_id, VEO_CRED_KEYS)));

/**
 * Liberta um orçamento aceite ou em curso (ou anula um rascunho): os créditos cativos voltam ao disponível, aos mesmos
 * lotes. Idempotente. Bloqueia o orçamento antes da carteira (a ordem de sempre).
 */
export async function releaseQuote(t: Db, quoteId: string, reason: string, status: 'void' | 'cancelled' = 'void') {
  const q = await t.one('SELECT * FROM animation_quotes WHERE id=$1 FOR UPDATE', [quoteId]);
  if (!q || !['draft', 'accepted', 'running'].includes(q.status)) return null;
  const r = q.status !== 'draft' && q.price_cents > 0 ? await release(t, `quote:${q.id}`, `orçamento anulado: ${reason}`.slice(0, 300)) : null;
  const spent = q.status === 'draft' ? null : Number((await t.one(`SELECT COALESCE(sum(cost_usd),0)::float AS s FROM veo_ops WHERE quote_id=$1 AND state<>'void'`, [q.id])).s);
  return t.one(`UPDATE animation_quotes SET status=$2, void_reason=$3, charged_cents=CASE WHEN $2='void' AND status<>'draft' THEN 0 ELSE charged_cents END,
      released_cents=CASE WHEN status<>'draft' THEN $4 ELSE released_cents END, spent_usd=COALESCE($5, spent_usd), status_note=NULL, settled_at=CASE WHEN status<>'draft' THEN now() ELSE settled_at END, updated_at=now()
    WHERE id=$1 RETURNING *`, [q.id, status, reason.slice(0, 500), r?.released ?? (q.status === 'draft' ? null : q.price_cents), spent]);
}

/** Trabalho do vídeo que falhou de vez: o orçamento é libertado com o motivo (chamado pelo __onFail e pela limpeza periódica). */
export async function releaseQuoteOfJob(db: Db, job: any) {
  const id = job?.input?.quoteId;
  if (typeof id !== 'string') return null;
  const err = (await db.one('SELECT error FROM jobs WHERE id=$1', [job.id]))?.error ?? '';
  return db.tx(t => releaseQuote(t, id, `a produção não terminou${err ? `: ${String(err).slice(0, 300)}` : ''}`));
}

/** Passa o orçamento a «em curso» (ou retoma-o depois de uma pausa); recusa um orçamento já fechado ou fora da validade. */
async function startQuote(db: Db, quoteId: string, interviewId: string) {
  return db.tx(async t => {
    const q = await t.one('SELECT * FROM animation_quotes WHERE id=$1 AND interview_id=$2 FOR UPDATE', [quoteId, interviewId]);
    if (!q || !['accepted', 'running'].includes(q.status)) throw new PermanentError(VEO_QUOTE_CLOSED);
    if (new Date(q.valid_until).getTime() < Date.now()) throw new PermanentError(VEO_QUOTE_EXPIRED);
    const rate = await t.one('SELECT active FROM animation_rates WHERE id=$1', [q.rate_id]);
    if (!rate?.active) throw new PermanentError(VEO_QUOTE_RATE_OFF);
    return t.one(`UPDATE animation_quotes SET status='running', started_at=COALESCE(started_at, now()), status_note=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [q.id]);
  });
}

/** A confirmação do orçamento (suporte duradouro) sai antes de o trabalho começar; enquanto não sair, o trabalho espera. */
async function confirmationSent(db: Db, quoteId: string) {
  const key = `quote:${quoteId}`;
  let m = await db.one('SELECT state FROM emails WHERE dedupe_key=$1', [key]);
  if (m && m.state !== 'sent') { await flushOutbox(db); m = await db.one('SELECT state FROM emails WHERE dedupe_key=$1', [key]); }
  if (m && m.state !== 'sent') throw new JobPaused('A enviar ao cliente a confirmação do orçamento por email antes de começar.', 5 * 60_000);
}

type FalaOut = { clips: { c: Chunk; at: Attempt }[] | null; reason: string | null };

/**
 * Liquidação, na transação que liga o vídeo ao episódio: cobra só as falas animadas e verificadas (nunca mais do que o
 * orçamento), uma vez por (entrevista, fala, take), e liberta o resto do cativo. Guarda o relatório por fala com o motivo.
 */
async function settleQuote(t: Db, quoteId: string, out: Map<string, FalaOut>, measured: { speechSec: number }) {
  const q = await t.one('SELECT * FROM animation_quotes WHERE id=$1 FOR UPDATE', [quoteId]);
  if (q?.status !== 'running') throw new PermanentError(VEO_QUOTE_CLOSED);
  let charged = 0, animated = 0;
  const report: any[] = [];
  for (const it of q.selection as any[]) {
    const o = out.get(it.segmentId);
    const row = { segmentId: it.segmentId, role: it.role, sec: it.sec, cents: 0, status: 'photo', reason: null as string | null };
    if (o?.clips) {
      animated++;
      if (it.reused || !(it.cents > 0)) row.status = it.reused ? 'reused' : 'included';
      else {
        const chunks = o.clips.map(x => ({ key: x.c.key, assetId: x.at.assetId, text: x.c.text }));
        const ins = await t.one(`INSERT INTO animation_charges(interview_id, reuse_key, take, quote_id, segment_id, role, cents, chunks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (interview_id, reuse_key, take) DO NOTHING RETURNING id`, [q.interview_id, it.reuseKey, Number(it.take) || 1, q.id, it.segmentId, it.role, it.cents, JSON.stringify(chunks)]);
        if (ins) { charged += it.cents; row.cents = it.cents; row.status = 'charged'; } else row.status = 'reused';
      }
    } else row.reason = o?.reason ?? 'google';
    report.push(row);
  }
  const captured = Math.min(charged, q.price_cents);
  let released = q.price_cents - captured;
  if (q.price_cents > 0) {
    const s = await settle(t, `quote:${q.id}`, captured, `animação: ${animated} de ${q.selection.length} falas animadas`);
    if (!s) throw new Error('Orçamento sem cativação por liquidar');
    released = s.released;
  }
  const ops = await t.one(`SELECT COALESCE(sum(cost_usd),0)::float AS usd, COALESCE(sum(duration_sec) FILTER (WHERE state<>'void'),0)::int AS sec FROM veo_ops WHERE quote_id=$1 AND state<>'void'`, [q.id]);
  await t.query(`UPDATE animation_quotes SET status='settled', charged_cents=$2, released_cents=$3, spent_usd=$4, settlement=$5, settled_at=now(), status_note=NULL, updated_at=now() WHERE id=$1`,
    [q.id, captured, released, ops.usd, JSON.stringify({ segments: report, billedSec: ops.sec, speechSec: measured.speechSec, factor: measured.speechSec ? Math.round((ops.sec / measured.speechSec) * 100) / 100 : null })]);
  return { charged: captured, released, owner: q.owner_id };
}

export async function renderVeoVideo(job: any, { db, progress }: Parameters<Handler>[1]) {
  const quoteId: string | null = typeof job.input.quoteId === 'string' ? job.input.quoteId : null;
  const rebuildOf: string | null = typeof job.input.rebuild === 'string' ? job.input.rebuild : null;
  // Segunda barreira: sem orçamento aceite, o Veo só se gera a pedido do administrador (custo interno) ou do gestor de uma
  // entidade com credenciais Google próprias (paga a entidade, no projeto Google dela).
  const requester = quoteId || rebuildOf ? null : await requesterOf(db, job.input.requestedBy);
  if (!quoteId && !rebuildOf && !veoWithoutQuote(requester, await entityOfInterview(db, job.interview_id))) throw new PermanentError(VEO_NEEDS_QUOTE);
  const entityPays = !quoteId && !rebuildOf && requester?.role === 'entity_admin';
  // Retoma depois de um reinício: se este trabalho já liquidou o orçamento (o processo caiu entre a liquidação e o fim),
  // o resultado é o mesmo, sem gerar nem cobrar outra vez; o email do resultado (deduplicado) sai se ainda não saiu.
  if (quoteId) {
    const done = await db.one(`SELECT * FROM animation_quotes WHERE id=$1 AND interview_id=$2 AND job_id=$3 AND status='settled'`, [quoteId, job.interview_id, job.id]);
    if (done) {
      const iv0 = await db.one('SELECT id, title FROM interviews WHERE id=$1', [job.interview_id]);
      await quoteSettledEmail(db, done, { charged: done.charged_cents ?? 0, released: done.released_cents ?? 0, owner: done.owner_id }, iv0);
      const video = await db.one(`SELECT id FROM assets WHERE interview_id=$1 AND kind='episode_video' AND meta->>'quoteId'=$2 ORDER BY created_at DESC LIMIT 1`, [job.interview_id, quoteId]);
      await progress(100, 100, 'Concluído');
      return { videoAssetId: video?.id ?? null, resumedAfterSettlement: true, chargedCents: done.charged_cents ?? 0, releasedCents: done.released_cents ?? 0 };
    }
  }
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1 AND interview_id=$2', [job.input.episodeId, job.interview_id]);
  if (!ep || ep.stale || ep.status === 'superseded') throw new PermanentError('Episódio inexistente ou desatualizado');
  if (ep.status !== 'preview') throw new PermanentError(VEO_ONLY_PREVIEW);
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ep.interview_id]);
  const timing = ep.technical?.timing as any[] | undefined;
  if (!timing?.length) throw new PermanentError('Este episódio foi gerado antes do vídeo existir: gere o episódio de novo');
  const mock = config.openai.mock;
  // A reconstrução só monta clipes já pagos: nada vai à Google nem é transcrito.
  if (!rebuildOf && !mock && !veoConfigured()) throw new PermanentError(VEO_NO_CREDENTIALS);
  // Sem transcrição não há verificação: não se paga nenhum clipe que depois não se possa verificar.
  if (!rebuildOf && !mock && !aiAvailable()) throw new PermanentError('Falta a chave da OpenAI (transcrição para verificar os clipes) em Definições');
  const script = await db.one('SELECT status FROM scripts WHERE id=$1', [ep.script_id]);
  // Só a partir do guião aprovado em vigor (um guião substituído pode ter o texto que o convidado contestou).
  if (script?.status !== 'approved') throw new PermanentError(VEO_SCRIPT_REPLACED);
  const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
  // Pedido de alterações do convidado neste episódio ou noutro episódio do mesmo guião (um episódio novo não o apaga).
  const guestAskedChanges = async () => !!(await db.one(`SELECT 1 FROM approvals a JOIN episodes e2 ON e2.id=a.episode_id WHERE e2.script_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes' LIMIT 1`, [ep.script_id]));
  if (await guestAskedChanges()) throw new PermanentError(VEO_CHANGES);
  if (rebuildOf && !(await db.one(`SELECT 1 FROM animation_quotes WHERE id=$1 AND interview_id=$2 AND status='settled'`, [rebuildOf, iv.id]))) throw new PermanentError('Só se reconstrói a partir de um orçamento liquidado desta entrevista.');
  // Orçamento: a confirmação por email sai antes de a produção começar; só depois passa a «em curso». O motor e o preço
  // são os do orçamento (uma mudança nas Definições ou nas tarifas só vale para os orçamentos novos).
  if (quoteId) await confirmationSent(db, quoteId);
  const quote = quoteId ? await startQuote(db, quoteId, iv.id) : null;
  const tier: VeoTier = quote ? (quote.tier === 'lite' ? 'lite' : 'fast') : veoTier();
  const tierPrice = quote ? Number(quote.rate.cost_usd_per_sec) || veoPricePerSec(tier) : veoPricePerSec(tier), tierModel = veoModel(tier);
  const maxClip = quote ? Number(quote.rate.max_clip_sec) || 8 : 8;
  // Lida de novo antes de cada envio à Google: uma autorização retirada ou um pedido de alterações a meio param o trabalho.
  const stillAllowed = async (role: Role): Promise<string | null> => {
    if (await guestAskedChanges()) return VEO_CHANGES;
    const cur = await db.one(`SELECT e.status, e.stale, s.status AS script_status FROM episodes e LEFT JOIN scripts s ON s.id=e.script_id WHERE e.id=$1`, [ep.id]);
    if (!cur || cur.stale || cur.status !== 'preview') return 'O episódio mudou durante a geração (publicado, retirado ou desatualizado): nada mais foi enviado à Google.';
    if (cur.script_status !== 'approved') return VEO_SCRIPT_REPLACED;
    if (role === 'host') { const r = await db.one('SELECT host_ai_video, host_photo_rights FROM interviews WHERE id=$1', [iv.id]); return r?.host_ai_video && r?.host_photo_rights ? null : VEO_HOST_WITHDRAWN; }
    const r = await db.one('SELECT review_policy FROM interviews WHERE id=$1', [iv.id]);
    return (await consent('ai_video')) && (await consent('publish_photo')) && r?.review_policy === 'guest_preview' ? null : VEO_GUEST_WITHDRAWN;
  };
  await progress(0, 100, 'A preparar as imagens');
  const asset = async (id: string | null) => { if (!id) return null; const a = await db.one('SELECT storage_key FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]); return a ? storage.get(a.storage_key) : null; };
  const sel = quote ? new Map<string, any>((quote.selection as any[]).map(x => [x.segmentId, x])) : null;
  const plan = await veoPlan(db, iv, ep, { tier, photoId: job.input.photoId, takes: sel ? new Map([...sel.values()].map(x => [x.segmentId, Number(x.take) || 1])) : undefined });
  if (rebuildOf && !plan.hostVeo) throw new PermanentError(VEO_HOST_WITHDRAWN);
  // Orçamento: a autorização de cada papel com falas no orçamento (o motivo vai para a anulação).
  if (quote) for (const x of sel!.values()) if (x.role === 'host' ? !plan.hostVeo : !plan.guestVeo) throw new PermanentError(x.role === 'host' ? VEO_HOST_WITHDRAWN : VEO_GUEST_WITHDRAWN);
  if (!plan.hostVeo && !plan.guestVeo) throw new PermanentError('Ninguém autorizou o vídeo gerado pelo Google Veo (entrevistador: em Editar; convidado: em «Autorizações das fotografias», e só com a política «o entrevistado aprova»)');
  if (quote) {
    // Pedaços como na aceitação; se algo mudou, o orçamento é anulado antes de qualquer envio.
    if (inputsHashOf(ep, plan, tier, quote.lang ?? null, [...sel!.keys()]) !== quote.inputs_hash) throw new PermanentError(VEO_QUOTE_CHANGED);
  }
  const cover = await asset(ep.cover_asset_id);
  const audio = await asset(ep.audio_asset_id);
  if (!cover || !audio) throw new PermanentError('Capa ou áudio do episódio em falta');
  const wantLang = quote ? quote.lang : job.input.lang;
  const lang: string | null = wantLang && ep.subtitles?.[wantLang] ? wantLang : null;
  const people = peopleOf(iv);
  const bases = await renderBases({ cover, title: ep.title, brand: config.brand, host: { name: people.host.name || 'Host', role: people.host.role, photo: plan.hostPhoto }, guest: { name: people.guest.name || 'Guest', role: people.guest.role, photo: plan.guestPhoto } });
  const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
  const ffmpeg = process.env.FFMPEG_PATH || ff.path;
  const personNameSet = personNames([iv.host_name ?? '', iv.guest_name ?? '']);
  // Operações reservadas de uma execução que caiu sem saber se a Google as aceitou: contam como gastas e como tentativa.
  await db.query(`UPDATE veo_ops SET state='unknown' WHERE interview_id=$1 AND state='reserved'`, [iv.id]);

  // Falas já cobradas (reaproveitamento a 0 créditos): os clipes aprovados guardados na cobrança, sem os voltar a julgar.
  const loadCharged = async (s: PlanSeg, take: number | null): Promise<{ c: Chunk; at: Attempt }[] | null> => {
    const ch = await db.one(`SELECT chunks FROM animation_charges WHERE interview_id=$1 AND reuse_key=$2 ${take ? 'AND take=$3' : ''} ORDER BY take DESC LIMIT 1`, take ? [iv.id, s.reuseKey, take] : [iv.id, s.reuseKey]);
    if (!ch || !(ch.chunks as any[]).length) return null;
    const out: { c: Chunk; at: Attempt }[] = [];
    for (const [k, x] of (ch.chunks as any[]).entries()) {
      const a = await db.one(`SELECT id, storage_key, meta FROM assets WHERE id=$1 AND kind='veo_clip' AND deleted_at IS NULL AND COALESCE(meta->>'rejected','')<>'true'`, [x.assetId]);
      if (!a) return null;
      const m = a.meta ?? {};
      out.push({ c: { seg: s, k, text: String(m.text ?? x.text ?? ''), dur: veoDuration(String(m.text ?? x.text ?? '')), key: String(x.key), prompt: '' },
        at: { assetId: a.id, storageKey: a.storage_key, words: m.words ?? [], heard: m.heard ?? '', checked: true, edits: m.edits ?? 0, hard: 0, dur: Number(m.dur ?? m.billedSec ?? 8), usdPerSec: Number(m.usdPerSec ?? veoPriceOfModel(m.model)), model: m.model ?? null } });
    }
    return out;
  };
  // Falas a animar: as do orçamento; na reconstrução, as do anfitrião já cobradas; para o administrador, todas as autorizadas.
  const reused = new Map<string, { c: Chunk; at: Attempt }[] | null>();
  const gen: PlanSeg[] = [];
  for (const s of plan.segs) {
    if (!s.chunks.length) continue;
    if (rebuildOf) { if (s.role === 'host') { const r = await loadCharged(s, null); if (r) reused.set(s.id, r); } continue; }
    const x = sel?.get(s.id);
    if (sel && !x) continue;
    if (x?.reused) reused.set(s.id, await loadCharged(s, Number(x.take) || 1));
    else gen.push(s);
  }
  const want = plan.segs.filter(s => reused.has(s.id) || gen.includes(s));
  if (rebuildOf && !reused.size) throw new PermanentError('Não há falas do entrevistador já pagas com clipes guardados para reconstruir o vídeo.');

  // ---- transcrição de um clipe (repete a transcrição, nunca a geração paga) ----
  const transcribe = async (video: Buffer, text: string, durSec: number): Promise<{ words: Word[]; checked: boolean; text?: string }> => {
    if (mock) { // palavras sintéticas e coerentes com o texto, para exercitar cortes e legendas nos testes
      const w = text.split(/\s+/).filter(Boolean), step = Math.min(0.35, (durSec - 1) / Math.max(1, w.length));
      return { words: w.map((x, k) => ({ word: x, start: 0.4 + k * step, end: 0.4 + (k + 0.9) * step })), checked: true, text };
    }
    const audioState = await hasAudioStream(video, 'mp4');
    if (audioState === 'no') return { words: [], checked: true };     // sem som: falha verificada, gera-se de novo
    if (audioState === 'error') return { words: [], checked: false }; // não se sabe: verifica-se outra vez mais tarde, sem pagar
    for (let k = 0; k < 3; k++) {
      try { const r = await transcribeClip(video, 'mp4'); return { words: r.words, text: r.text, checked: true }; }
      catch (e: any) { console.error(`[veo] transcrição falhou (tentativa ${k + 1}): ${String(e?.message ?? e).slice(0, 200)}`); await sleep(3000 * (k + 1)); }
    }
    return { words: [], checked: false };
  };
  const judge = (c: Chunk, words: Word[], checked: boolean, fullText?: string) => {
    // O texto completo da transcrição guarda os símbolos (%, €, <…) que as palavras com tempos podem perder.
    const heard = (fullText?.trim() || words.map(w => w.word.trim()).join(' ')).replace(/\s+([,.;:!?])/g, '$1');
    const d = checked ? wordDiff(c.text, heard, namesUsedIn(c.text, personNameSet)) : null;
    return { heard, edits: d?.edits ?? null, hard: d?.hard ?? null, diffs: d?.diffs ?? [] };
  };

  // 1. Pedaços únicos a gerar (pedaços iguais, mesmo papel e texto, geram-se uma só vez).
  type Problem = 'busy' | 'busycap' | 'filtered' | 'error' | 'capped' | 'capped_budget' | 'breaker';
  type U = { key: string; c: Chunk; falas: PlanSeg[]; atts: Attempt[]; failures: number; busyRecent: number; chosen: Attempt | null; problem: Problem | null; cause?: string };
  const units = new Map<string, U>();
  for (const s of gen) for (const c of s.chunks) {
    const u = units.get(c.key);
    if (u) { if (!u.falas.includes(s)) u.falas.push(s); } else units.set(c.key, { key: c.key, c, falas: [s], atts: [], failures: 0, busyRecent: 0, chosen: null, problem: null });
  }
  const maxAttempts = 1 + Math.max(0, Math.min(2, Number(job.input.veoRetries ?? 1)));
  let spentUsd = 0, failedUsd = 0, generated = 0, doneN = 0;
  let busyStreak = 0; // falhas passageiras da Google seguidas, sem nenhum clipe pelo meio: com muitas, pára-se e tenta-se mais tarde
  const submittedThisRun = new Set<string>(); // operações pagas nesta geração (as retomadas foram pagas antes)
  let abort: Error | null = null; // chave recusada, quota esgotada, autorização retirada, canário ou erro inesperado: os trabalhadores param
  let timeouts = 0; // Google degradada: duas esperas esgotadas seguidas param o trabalho (as operações ficam pendentes e retomam-se)
  let canaryOpen: () => void = () => {};
  const canaryGate = new Promise<void>(r => { canaryOpen = r; });
  const stop = (e: Error) => { abort ??= e; canaryOpen(); };
  const pct = () => 5 + Math.round((doneN / Math.max(1, units.size)) * 70);
  const budgetOf = (s: PlanSeg) => (sel ? Number(sel.get(s.id)?.budgetUsd ?? 0) : Infinity);

  // Operação que acabou sem vídeo: a estimativa passa de «pago» para «falhado na Google (normalmente não cobrado)».
  // No teto do orçamento continua a contar até à reconciliação com a fatura da Google.
  const moveToFailed = async (opId: string | null, dur: number, state: 'busy' | 'failed', error: string) => {
    if (!opId) return;
    await db.tx(async tx => {
      const r = await tx.one(`UPDATE veo_ops SET state=$2, error=$3 WHERE id=$1 AND state='pending' RETURNING id, op_name, model, usd_per_sec`, [opId, state, error.slice(0, 300)]);
      if (!r) return;
      const usd = dur * (r.usd_per_sec != null ? Number(r.usd_per_sec) : veoPriceOfModel(r.model)); // o preço com que foi submetida
      if (!mock) {
        await tx.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated, quote_id) VALUES ($1,$2,$3,$4,true,$5)', [iv.id, 'veo_usd', -dur, -usd, quote?.id ?? null]);
        await tx.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated, quote_id) VALUES ($1,$2,$3,$4,true,$5)', [iv.id, 'veo_usd_failed', dur, usd, quote?.id ?? null]);
        if (submittedThisRun.has(String(r.op_name))) failedUsd += usd; // só as desta geração entram no «pago nesta geração»
      }
    });
  };

  // ---- teto do orçamento: intenção gravada ANTES de cada envio, com a duração máxima do motor ----
  const earmark = new Map<string, number>(); // 1.ª passagem das falas já começadas, ainda por reservar na base de dados
  const earmarked = () => [...earmark.values()].reduce((a, b) => a + b, 0);
  const heldUsd = async (t: Db, segKey?: string | null) => Number((await t.one(`SELECT COALESCE(sum(cost_usd),0)::float AS s FROM veo_ops WHERE quote_id=$1 AND state<>'void' AND ($2::text IS NULL OR segment_key=$2)`, [quote!.id, segKey ?? null])).s);
  const reserveOp = async (u: U, fala: PlanSeg, retry: boolean): Promise<string | null> => {
    const need = maxClip * tierPrice;
    const r = await db.tx(async (t): Promise<{ id?: string; capped?: boolean; closed?: boolean }> => {
      if (quote) {
        const q = await t.one('SELECT status, cap_usd FROM animation_quotes WHERE id=$1 FOR UPDATE', [quote.id]);
        if (q?.status !== 'running') return { closed: true };
        const held = await heldUsd(t), mine = earmark.get(fala.id) ?? 0;
        if (held + (earmarked() - mine) + Math.max(mine, need) > Number(q.cap_usd) + 1e-9) return { capped: true };
        // 2.ª passagem: só se repete enquanto o gasto da fala mais a repetição couber no orçamento dela (b_i).
        if (retry && (await heldUsd(t, fala.reuseKey)) + need > budgetOf(fala) + 1e-9) return { capped: true };
      }
      const row = await t.one(`INSERT INTO veo_ops(interview_id, chunk_key, op_name, duration_sec, state, model, usd_per_sec, quote_id, segment_key, cost_usd) VALUES ($1,$2,NULL,$3,'reserved',$4,$5,$6,$7,$8) RETURNING id`,
        [iv.id, u.key, maxClip, tierModel, tierPrice, quote?.id ?? null, fala.reuseKey, need]);
      if (!retry && earmark.has(fala.id)) earmark.set(fala.id, Math.max(0, earmark.get(fala.id)! - need));
      return { id: row.id };
    });
    if (r.closed) { stop(new PermanentError(VEO_QUOTE_CLOSED)); return null; }
    if (r.capped) { u.problem = 'capped_budget'; return null; }
    return r.id!;
  };
  /**
   * A Google aceitou (e cobra): a intenção passa a operação pendente, com o custo real e o âmbito e o projeto das credenciais
   * que a criaram (consulta-se sempre com elas), numa só transação (com novas tentativas).
   */
  const registerOp = async (opId: string, opName: string, dur: number, model: string, price: number, scope: string, project: string | null) => {
    const usd = dur * price;
    if (!mock) spentUsd += usd;
    submittedThisRun.add(opName);
    for (let k = 0; ; k++) {
      try {
        await db.tx(async tx => {
          await tx.query(`UPDATE veo_ops SET op_name=$2, duration_sec=$3, model=$4, usd_per_sec=$5, cost_usd=$6, cred_scope=$7, project=$8, state='pending' WHERE id=$1`, [opId, opName, dur, model, price, usd, scope, project]);
          if (!mock) await tx.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated, quote_id) VALUES ($1,$2,$3,$4,true,$5)', [iv.id, 'veo_usd', dur, usd, quote?.id ?? null]);
        });
        return;
      } catch (e: any) {
        // Sem registo, a intenção fica 'reserved' (conta como gasta): o trabalho pára em vez de voltar a submeter.
        if (k >= 2) { console.error(`[veo] operação paga ${opName} sem registo: ${String(e?.message ?? e).slice(0, 200)}`); stop(new PermanentError('Falha a registar uma operação já paga à Google: o trabalho parou para não pagar outra vez.')); throw new VeoCancelled('sem registo'); }
        await sleep(2000 * (k + 1));
      }
    }
  };

  // ---- tentativas anteriores de um pedaço (clipes guardados e operações) ----
  const loadPrior = async (u: U) => {
    const c = u.c;
    const prev = await db.query(`SELECT id, storage_key, meta FROM assets WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'chunkKey'=$2 AND deleted_at IS NULL AND COALESCE(meta->>'rejected','')<>'true' ORDER BY created_at`, [iv.id, u.key]);
    for (const a of prev) {
      let m = a.meta;
      if (!m.checked) { // a transcrição falhou da outra vez: repete-se (cêntimos), sem pagar o Veo de novo
        const video = await storage.get(a.storage_key);
        const tr = await transcribe(video, c.text, Number(m.dur ?? m.billedSec ?? 8));
        const j = judge(c, tr.words, tr.checked, tr.text);
        m = { ...m, words: tr.words, checked: tr.checked, heard: j.heard, edits: j.edits, hard: j.hard, diffs: j.diffs };
        await db.query('UPDATE assets SET meta=$2 WHERE id=$1', [a.id, JSON.stringify(m)]);
      }
      if (m.checked) { const j = judge(c, m.words ?? [], true, m.heard); m = { ...m, edits: j.edits, hard: j.hard, diffs: j.diffs }; } // regra atual
      u.atts.push({ assetId: a.id, storageKey: a.storage_key, words: m.words ?? [], heard: m.heard ?? '', checked: !!m.checked, edits: m.edits ?? null, hard: m.hard ?? null, dur: Number(m.dur ?? m.billedSec ?? 8), usdPerSec: Number(m.usdPerSec ?? veoPriceOfModel(m.model)), model: m.model ?? null });
    }
    // Operações que falharam (ou expiraram) em execuções anteriores contam para o limite (o teto vale entre execuções).
    if (!mock) await db.query(`UPDATE veo_ops SET state='expired' WHERE interview_id=$1 AND chunk_key=$2 AND state='pending' AND created_at < now() - interval '36 hours'`, [iv.id, u.key]);
    // (as falhas passageiras da Google, estado 'busy', não contam: são da Google, não do pedaço)
    u.failures = Number((await db.one(`SELECT count(*)::int AS n FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state IN ('failed','expired','unknown')`, [iv.id, u.key]))?.n ?? 0);
    u.busyRecent = Number((await db.one(`SELECT count(*)::int AS n FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state='busy' AND created_at > now() - interval '36 hours'`, [iv.id, u.key]))?.n ?? 0);
    u.chosen = u.atts.find(passes) ?? null; // nunca um clipe que não disse o texto aprovado
    if (u.chosen) return;
    if (u.atts.length + u.failures >= maxAttempts) { // limite já esgotado noutras gerações: não volta a ser tentado
      u.problem = 'capped';
      const last = await db.one(`SELECT error FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state IN ('failed','expired','unknown') ORDER BY created_at DESC LIMIT 1`, [iv.id, u.key]);
      if (last?.error) u.cause = String(last.error).slice(0, 160);
    } else if (u.busyRecent >= 4) u.problem = 'busycap';
  };

  /** Uma tentativa paga de um pedaço: intenção no teto, envio, espera, transcrição e verificação. 'stop' = nada enviado. */
  const attemptOnce = async (u: U, fala: PlanSeg, retry: boolean): Promise<'ok' | 'failed' | 'stop'> => {
    const c = u.c, st = plan.start[c.seg.role]!;
    let busy = 0;
    for (;;) {
      if (abort) return 'stop';
      const last = u.atts[u.atts.length - 1];
      // Transcrição por fazer (OpenAI ou ffprobe em falha): não se paga outro clipe; volta a verificar-se na próxima execução.
      if (last && !last.checked) return 'stop';
      // Duração: a prevista; se a tentativa anterior saiu cortada (fala até ao fim do clipe ou incompleta), a seguinte.
      let dur: 4 | 6 | 8 = c.dur;
      if (last) {
        const lastEnd = last.words.length ? last.words[last.words.length - 1].end : 0;
        const short = normWords(last.heard).length < normWords(c.text).length * 0.85;
        dur = (lastEnd > last.dur - 0.6 || short) ? nextDuration(last.dur) : (last.dur as 4 | 6 | 8);
      }
      const label = retry ? `Google Veo: nova tentativa de um clipe da fala ${c.seg.id}${busy ? ' depois de uma falha na Google' : ''}` : `Google Veo: clipe ${Math.min(doneN + 1, units.size)} de ${units.size}${busy ? ' (nova tentativa depois de uma falha na Google)' : ''}`;
      await progress(pct(), 100, label);
      const onStatus = async (s: string) => progress(pct(), 100, `${label} — ${s}`);
      let opId: string | null = null, reservedId: string | null = null, opName = '';
      let opModel = tierModel, opPrice = tierPrice; // modelo e preço da operação (os de uma pendente são os dela)
      let opScope: string | null = null, opProject: string | null = null; // credenciais que a criaram (null: operação antiga)
      let foreign = false; // consulta recusada às credenciais de outra operação (não às em vigor)
      let outcome: 'ok' | 'mismatch' | 'filtered' | 'quota' = 'ok';
      // Antes de CADA envio (também nas repetições após 429): trabalho não parado e autorizações em vigor.
      const canSend = async () => {
        if (abort) return false;
        // Gestor sem orçamento: só com as credenciais da entidade em vigor (sem elas, pagaria o portal).
        if (entityPays && veoCredsScope() !== 'entity') { stop(new PermanentError(VEO_ENTITY_CREDS_GONE)); return false; }
        const why = await stillAllowed(c.seg.role);
        if (why) { stop(new PermanentError(why)); return false; }
        return true;
      };
      try {
        let video: Buffer;
        // Uma operação já paga e por concluir (trabalho interrompido, erro de rede) é retomada, não submetida de novo.
        const pending = await db.one(`SELECT id, op_name, duration_sec, model, usd_per_sec, cred_scope, project FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state='pending' ORDER BY created_at LIMIT 1`, [iv.id, c.key]);
        if (pending) {
          opId = pending.id; opName = pending.op_name; dur = Number(pending.duration_sec) as 4 | 6 | 8;
          opModel = pending.model ?? opModel; opPrice = pending.usd_per_sec != null ? Number(pending.usd_per_sec) : veoPriceOfModel(pending.model);
          opScope = pending.cred_scope ?? null; opProject = pending.project ?? null;
        } else {
          if (!(await canSend())) return 'stop';
          reservedId = await reserveOp(u, fala, retry);
          if (!reservedId) return 'stop';
          if (mock) {
            outcome = veoMock.outcome?.({ segmentId: c.seg.id, role: c.seg.role, text: c.text, attempt: u.atts.length + u.failures + 1 }) ?? 'ok';
            if (outcome === 'quota') throw new VeoQuotaError('Limite de pedidos (quota) da Google esgotado (simulado).');
            opName = `mock/${reservedId}`; opScope = veoScopeId();
          } else {
            const s = await veoSubmit({ image: st.image, prompt: c.prompt, aspectRatio: st.vertical ? '9:16' : '16:9', durationSeconds: dur, onStatus, canSend, tier });
            opName = s.opName; dur = s.dur; opModel = s.model; opPrice = s.usdPerSec; opScope = s.scope; opProject = s.project;
          }
          // A Google aceitou: a partir daqui a operação está paga (já não se anula a intenção).
          opId = reservedId; reservedId = null;
          await registerOp(opId, opName, dur, opModel, opPrice, opScope!, opProject);
        }
        if (mock && outcome === 'filtered') { const m = 'Veo: clipe bloqueado pelos filtros da Google (simulado)'; await moveToFailed(opId, dur, 'failed', m); throw new VeoFiltered(m); }
        try {
          if (mock) { await veoMock.poll?.({ opName, scope: opScope, project: opProject }); video = await mockTalkingClip(ffmpeg, st.image, dur * 1000, st.vertical); }
          else video = (await veoAwait(opName, dur, onStatus, undefined, undefined, opScope)).video;
        } catch (e: any) {
          const m = String(e?.message ?? e);
          // Só uma operação que a própria Google deu como falhada (passageira, bloqueada ou sem vídeo) passa a «normalmente não cobrada».
          // Credencial que a criou retirada de Definições: fica pendente (retoma-se quando for reposta) e nada se paga de novo.
          // Credenciais em vigor recusadas na consulta: a operação fica pendente (retoma-se com a chave certa) e o custo continua como pago.
          // Recusa às credenciais de outra operação (de antes de uma mudança de credenciais): não acusa as em vigor; a operação
          // fica 'failed' (inacessível, o custo continua como pago) e o pedaço segue para uma nova tentativa.
          // Outra recusa da CONSULTA (ex.: 404): não se sabe o que aconteceu à operação; fica 'failed' e o custo continua como pago.
          if (e instanceof VeoCredsMissing) { /* fica 'pending' */ }
          else if (isKeyRejected(m) && opOfCurrentCreds(opName, opScope, opProject)) { /* fica 'pending' */ }
          else if (isKeyRejected(m)) { foreign = true; await db.query(`UPDATE veo_ops SET state='failed', error=$2 WHERE id=$1 AND state='pending'`, [opId, `consulta recusada às credenciais que criaram a operação, não às em vigor: ${m}`.slice(0, 300)]); }
          else if (e instanceof VeoBusy) await moveToFailed(opId, dur, 'busy', m);
          else if (e instanceof VeoOpError) await moveToFailed(opId, dur, 'failed', m);
          else if (e instanceof PermanentError) await db.query(`UPDATE veo_ops SET state='failed', error=$2 WHERE id=$1 AND state='pending'`, [opId, m.slice(0, 300)]);
          if (/tempo excedido/.test(m) && ++timeouts >= 2) stop(new PermanentError('O Google Veo não está a concluir os clipes (duas esperas de 20 min esgotadas): tente mais tarde. As operações pagas ficam pendentes e são retomadas.'));
          throw e;
        }
        generated++; busyStreak = 0;
        if (u.problem === 'busy') u.problem = null; // a procura elevada passou: o que contar é o resultado deste clipe
        const tr = await transcribe(video, outcome === 'mismatch' ? `${c.text} (texto diferente)` : c.text, dur);
        if (!tr.checked) stop(new PermanentError('A verificação dos clipes (transcrição) falhou: o trabalho parou para não pagar clipes que não se podem verificar. Os clipes pagos ficam guardados e são verificados na próxima geração.'));
        const j = judge(c, tr.words, tr.checked, tr.text);
        const meta = { chunkKey: c.key, reuseKey: fala.reuseKey, take: fala.take, quoteId: quote?.id ?? null, segmentId: c.seg.id, role: c.seg.role, text: c.text, attempt: u.atts.length + 1, dur, billedSec: mock ? 0 : dur, words: tr.words, checked: tr.checked, ...j, model: opModel, usdPerSec: opPrice, mock };
        const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'veo_clip', mime: 'video/mp4', ext: 'mp4', data: video, durationMs: dur * 1000, meta });
        if (opId) await db.query(`UPDATE veo_ops SET state='done' WHERE id=$1`, [opId]);
        const a = await db.one('SELECT storage_key FROM assets WHERE id=$1', [assetId]);
        const at: Attempt = { assetId, storageKey: a.storage_key, words: tr.words, heard: j.heard, checked: tr.checked, edits: j.edits, hard: j.hard, dur, usdPerSec: opPrice, model: opModel };
        u.atts.push(at);
        if (passes(at)) { u.chosen = at; return 'ok'; }
        return 'failed';
      } catch (e: any) {
        // Recusado antes de a Google aceitar (400, 429, procura elevada, envio cancelado): a intenção não custa nada.
        if (reservedId) await db.query(`UPDATE veo_ops SET state='void', cost_usd=0 WHERE id=$1 AND state='reserved'`, [reservedId]);
        const m = String(e?.message ?? e);
        if (e instanceof VeoCancelled || abort) return 'stop';
        if (e instanceof VeoCredsMissing) { stop(new PermanentError(m)); return 'stop'; }
        if (isKeyRejected(m) && !foreign) { stop(new PermanentError(`A Google recusou as credenciais do Veo (conta de serviço do Vertex AI ou chave da Gemini API, em Definições → Google): ${m.slice(0, 200)}`)); return 'stop'; }
        // Quota esgotada: não é uma falha da produção; o trabalho volta à fila mais tarde e o orçamento continua em curso.
        if (e instanceof VeoQuotaError) { stop(new JobPaused(VEO_QUOTA_PAUSED, QUOTA_PAUSE_MS)); return 'stop'; }
        if (e instanceof VeoUnsupported) { stop(new PermanentError(m)); return 'stop'; } // o modelo escolhido recusa o pedido: não adianta insistir
        console.error(`[veo] pedaço ${c.seg.id}/${c.k} falhou: ${m.slice(0, 300)}`);
        if (e instanceof VeoBusy) {
          // Procura elevada na Google: espera e tenta outra vez, sem gastar o limite do pedaço. Muitas seguidas: pára o trabalho.
          u.problem = 'busy';
          if (++busyStreak >= 5) { stop(new PermanentError(VEO_BUSY)); return 'stop'; }
          if (++busy > 2 || ++u.busyRecent >= 4) return 'stop'; // fica em fotografia fixa nesta geração; numa próxima volta a tentar-se
          const wait = 45_000 * busy;
          await progress(pct(), 100, `${label} — Google Veo com procura elevada: nova tentativa dentro de ${Math.round(wait / 1000)} s`);
          await sleep(wait);
          continue;
        }
        u.problem = e instanceof VeoFiltered ? 'filtered' : 'error';
        u.failures++;
        return 'failed';
      }
    }
  };

  // 2. Geração em duas passagens: A (1.ª tentativa de cada pedaço, pela ordem do episódio) e B (repetições).
  for (const u of units.values()) await loadPrior(u);
  const unitsOf = (s: PlanSeg) => s.chunks.map(c => units.get(c.key)!);
  const DEAD = new Set<Problem>(['capped', 'filtered', 'capped_budget', 'breaker', 'busycap']);
  // Fala que já não fica completa (um pedaço filtrado, sem tentativas ou sem orçamento): não se gasta mais nela.
  const falaDead = (s: PlanSeg) => unitsOf(s).some(u => !u.chosen && !!u.problem && DEAD.has(u.problem));
  const tasksA: { u: U; fala: PlanSeg }[] = [];
  const seenA = new Set<string>();
  for (const s of gen) for (const c of s.chunks) {
    const u = units.get(c.key)!;
    if (seenA.has(u.key)) continue;
    seenA.add(u.key);
    if (!u.chosen && !u.problem && u.atts.length + u.failures === 0) tasksA.push({ u, fala: s });
  }
  const firstPassOf = (s: PlanSeg) => tasksA.filter(x => x.fala === s).length;
  // Passagem A: uma fala só arranca se o teto que resta cobrir a 1.ª passagem dela inteira (à duração máxima do motor).
  // (uma promessa por fala: os dois trabalhadores que peguem em pedaços da mesma fala esperam pela mesma decisão)
  const gated = new Map<string, Promise<boolean>>();
  const gate = (s: PlanSeg): Promise<boolean> => {
    if (!quote) return Promise.resolve(true);
    let p = gated.get(s.id);
    if (!p) { p = gateOnce(s); gated.set(s.id, p); }
    return p;
  };
  const gateOnce = async (s: PlanSeg) => {
    const need = firstPassOf(s) * maxClip * tierPrice;
    const ok = await db.tx(async t => {
      const q = await t.one('SELECT status, cap_usd FROM animation_quotes WHERE id=$1 FOR UPDATE', [quote.id]);
      if (q?.status !== 'running') return false;
      const fits = (await heldUsd(t)) + earmarked() + need <= Number(q.cap_usd) + 1e-9;
      if (fits) earmark.set(s.id, need); // marcado antes de largar o bloqueio: o outro trabalhador já o vê
      return fits;
    });
    if (!ok) for (const u of unitsOf(s)) if (!u.chosen && !u.problem) u.problem = 'capped_budget';
    return ok;
  };
  // Canário (só com orçamento e pelo menos 8 pedaços novos): os 9.º e seguintes esperam pelo resultado dos 8 primeiros.
  const canary = { on: !!quote && tasksA.length >= CANARY_CHUNKS, started: 0, done: 0, ok: 0, bad: 0 };
  const canaryResult = (ok: boolean) => {
    canary.done++; if (ok) canary.ok++; else canary.bad++;
    if (canary.bad > CANARY_CHUNKS - CANARY_MIN_OK || (canary.done >= CANARY_CHUNKS && canary.ok < CANARY_MIN_OK))
      stop(new PermanentError(`${VEO_CANARY} (${canary.ok} de ${canary.done} aprovados)`));
    if (canary.done >= CANARY_CHUNKS) canaryOpen();
  };
  let nextA = 0;
  const workerA = async () => {
    while (!abort && nextA < tasksA.length) {
      const { u, fala } = tasksA[nextA++];
      try {
        if (u.chosen || falaDead(fala) || !(await gate(fala))) {
          if (earmark.has(fala.id)) earmark.set(fala.id, Math.max(0, earmark.get(fala.id)! - maxClip * tierPrice));
          doneN++; continue;
        }
        let counted = false;
        if (canary.on) {
          if (canary.started >= CANARY_CHUNKS && canary.done < CANARY_CHUNKS) await canaryGate;
          if (abort) break;
          if (canary.started < CANARY_CHUNKS) { canary.started++; counted = true; }
        }
        const r = await attemptOnce(u, fala, false);
        if (counted) { if (r === 'stop') canary.started--; else canaryResult(r === 'ok'); }
        doneN++;
        await progress(pct(), 100, `Google Veo: ${doneN} de ${units.size} clipes`);
      } catch (e: any) { stop(e instanceof PermanentError || e instanceof JobPaused ? e : new Error(`Falha a gerar os clipes: ${String(e?.message ?? e).slice(0, 300)}`)); }
    }
  };
  await progress(5, 100, `Google Veo: 0 de ${units.size} clipes`);
  await Promise.allSettled([workerA(), workerA()]); // só termina quando os dois pararam (nenhum fica a gerar sozinho)
  earmark.clear();
  // Passagem B: repetições só em falas que ainda podem ficar completas, primeiro as que têm menos pedaços em falta.
  const retryable = (u: U) => !u.chosen && u.atts.length + u.failures < maxAttempts && (!u.problem || u.problem === 'error' || u.problem === 'busy') && !(u.atts.length && !u.atts[u.atts.length - 1].checked);
  if (!abort) {
    const missing = (s: PlanSeg) => unitsOf(s).filter(u => !u.chosen).length;
    // (uma fala igual a outra do mesmo orçamento vai com ela: não tem orçamento próprio para repetições)
    const cands = gen.filter(s => !sel?.get(s.id)?.dup && missing(s) > 0 && !falaDead(s) && unitsOf(s).every(u => u.chosen || retryable(u))).sort((a, b) => missing(a) - missing(b));
    let nextB = 0, retries = 0, retriesOk = 0, breaker = false;
    const workerB = async () => {
      while (!abort && nextB < cands.length) {
        const fala = cands[nextB++];
        try {
          for (const u of unitsOf(fala)) {
            while (!abort && retryable(u)) {
              // Disjuntor (só com orçamento): repetições que quase nunca passam param a 2.ª passagem.
              if (breaker) { u.problem = 'breaker'; break; }
              const r = await attemptOnce(u, fala, true);
              if (r === 'stop') break;
              retries++; if (r === 'ok') retriesOk++;
              if (quote && retries >= BREAKER_RETRIES && retriesOk / retries < BREAKER_MIN_RATE) breaker = true;
            }
            if (!u.chosen) break; // a fala já não fica completa: não se gasta mais nela
          }
        } catch (e: any) { stop(e instanceof PermanentError || e instanceof JobPaused ? e : new Error(`Falha a gerar os clipes: ${String(e?.message ?? e).slice(0, 300)}`)); }
      }
    };
    await Promise.allSettled([workerB(), workerB()]);
  }
  if (abort) {
    if (abort instanceof JobPaused && quote) await db.query(`UPDATE animation_quotes SET status_note=$2, updated_at=now() WHERE id=$1 AND status='running'`, [quote.id, abort.message]);
    throw abort;
  }

  // 3. Resultado por fala: animada (todos os pedaços com clipe aprovado) ou fotografia fixa com o motivo.
  const falaOut = new Map<string, FalaOut>();
  for (const s of want) {
    if (reused.has(s.id)) { const r = reused.get(s.id); falaOut.set(s.id, r ? { clips: r, reason: null } : { clips: null, reason: 'no_clips' }); continue; }
    const us = unitsOf(s);
    if (us.every(u => u.chosen)) falaOut.set(s.id, { clips: s.chunks.map(c => ({ c, at: units.get(c.key)!.chosen! })), reason: null });
    else {
      const u = us.find(x => !x.chosen)!;
      const best = [...u.atts].filter(a => a.checked)[0];
      falaOut.set(s.id, { clips: null, reason: falaReasonOf(unitProblem(false, !!best, u.atts.some(a => !a.checked), u.problem)) });
    }
  }
  // Nenhum pedaço teve clipe (ex.: a Google recusou ou falhou todos os pedidos, ou o modelo deixou de existir): um vídeo só
  // com fotografias não substitui o que está no episódio nem faz cair as aprovações. Num orçamento, os créditos cativos
  // voltam todos ao saldo. (Com clipes que não passaram na verificação, o vídeo liga-se com o relatório por fala, como antes.)
  if (![...falaOut.values()].some(o => o.clips) && ![...units.values()].some(u => u.atts.length)) {
    const why = [...new Set([...falaOut.values()].map(o => FALA_REASON[o.reason ?? 'google'] ?? o.reason))].join('; ');
    throw new PermanentError(`Nenhuma fala ficou animada e a Google não devolveu nenhum clipe (${why || 'sem falas a animar'}): o vídeo não foi ligado ao episódio e as aprovações mantêm-se.${quote ? ' Os créditos cativos voltam todos ao saldo.' : ''}`);
  }

  // 4. Linha temporal: aviso inicial (capa + voz do episódio), cartão de título, falas do Veo, reserva em imagem fixa e
  // cartão final. Os cartões têm silêncio; o grafismo (rodapés e capítulos) segue as falas no tempo do vídeo.
  const parts: Part[] = [], audioPieces: AudioPiece[] = [];
  const sceneOf = new Map<Part, Scene>();
  type C = { id: string; startMs: number; endMs: number; text: string };
  const veoCues: C[] = [], fixedCues: C[] = [];
  const epCues: any[] = lang ? ep.subtitles[lang] : [];
  const stillScene = (s: Seg): Scene => (s.kind === 'disclosure' || s.kind === 'editorial_outro' ? 'cover' : s.kind === 'editorial_intro' ? 'studio' : s.role);
  const veoSegs = new Set<string>(), fallbackSegs: string[] = [];
  const bgs = await cardBackground(cover);
  const cards = { title: await titleCard(bgs, ep.title, people.guest.name), end: await endCard(bgs) };
  const spans: GfxSpan[] = [];
  let t = 0;
  // O cartão de título entra logo a seguir ao aviso inicial (a introdução animada, quando existir, fica entre os dois).
  const addCard = (card: typeof cards.title, ms: number) => { parts.push({ kind: 'card', startMs: t, endMs: t + ms, card }); audioPieces.push({ durMs: ms }); t += ms; };
  if (!plan.segs.some(s => s.kind === 'disclosure')) addCard(cards.title, TITLE_CARD_MS);
  for (const s of plan.segs) {
    const o = falaOut.get(s.id), t0 = t;
    if (!o?.clips) {
      if (o) fallbackSegs.push(s.id);
      const from = s === plan.segs[0] ? 0 : s.startMs, dur = snap(s.endMs - from);
      if (dur >= 40) {
        for (const c of epCues) if (c.endMs > from && c.startMs < from + dur) fixedCues.push({ id: c.id, startMs: Math.max(t, t + c.startMs - from), endMs: Math.min(t + dur, t + c.endMs - from), text: c.text });
        const still: Part = { kind: 'still', startMs: t, endMs: t + dur, shots: [] };
        parts.push(still); sceneOf.set(still, stillScene(s));
        audioPieces.push({ durMs: dur, src: audio, ext: 'mp3', offsetMs: from });
        t += dur;
      }
    } else {
      veoSegs.add(s.id);
      for (const { c, at } of o.clips) {
        const clipMs = at.dur * 1000, w = at.words;
        const { a, b } = trimWindow(w, clipMs, c.text);
        const dur = b - a;
        const cues = cuesFromWords(w, { id: `${s.id}-${c.k}`, role: s.role, text: at.heard, startMs: t - a, durationMs: clipMs }, 'en');
        for (const q of cues) if (q.endMs > t && q.startMs < t + dur) veoCues.push({ id: q.id, startMs: Math.max(t, q.startMs), endMs: Math.min(t + dur, q.endMs), text: q.text });
        const load = () => storage.get(at.storageKey);
        parts.push({ kind: 'anim', startMs: t, endMs: t + dur, base: s.role === 'host' ? bases.animHost : bases.animGuest, clip: load, clipOffsetMs: a, notice: VEO_NOTICE, cues: [] });
        audioPieces.push({ durMs: dur, src: load, ext: 'mp4', offsetMs: a });
        t += dur;
      }
    }
    if (t > t0) spans.push({ id: s.id, role: s.role, kind: s.kind, startMs: t0, endMs: t, personShot: !!o?.clips || stillScene(s) === s.role });
    if (s.kind === 'disclosure') addCard(cards.title, TITLE_CARD_MS);
  }
  // Cartão final (entra pelo preto, também depois de uma fala animada: substitui o fecho de 1,6 s na capa).
  const speechEnd = t;
  addCard(cards.end, END_CARD_MS);
  const chap = chapterTitles(plan.segs, ep.chapters);
  const gplan = planGraphics(spans, id => chap.get(id), speechEnd);
  const overlays = await graphicsOverlays(gplan, people, !!lang);

  // 5. Legendas na língua escolhida: as do Veo seguem o que foi dito (traduzidas se preciso); as fixas vêm do episódio.
  if (lang && lang !== 'en' && veoCues.length) {
    await progress(77, 100, `A traduzir as legendas (${lang})`);
    const tr = await translateSubtitleCues(veoCues.map(c => ({ id: c.id, text: c.text })), lang);
    const map = new Map(tr.map(x => [x.sourceCueId, x.translatedText]));
    for (const c of veoCues) c.text = map.get(c.id) || c.text;
  }
  const allCues = lang ? [...veoCues, ...fixedCues] : [];
  for (const p of parts) {
    const inside = allCues.filter(c => c.endMs > p.startMs && c.startMs < p.endMs).map(c => ({ startMs: snap(Math.max(c.startMs, p.startMs)) - p.startMs, endMs: snap(Math.min(c.endMs, p.endMs)) - p.startMs, text: c.text })).filter(c => c.endMs > c.startMs);
    if (p.kind === 'anim') p.cues = inside;
    else if (p.kind === 'still') p.shots = stillShots(sceneOf.get(p) ?? 'cover', p.startMs, p.endMs, inside.map(c => ({ ...c, startMs: c.startMs + p.startMs, endMs: c.endMs + p.startMs })));
  }

  // 6. Som (dos clipes, codificado uma só vez em AAC) e montagem.
  await progress(78, 100, 'A juntar o som dos clipes');
  let track: Buffer | null = await buildAudioTrack(ffmpeg, audioPieces);
  await progress(80, 100, 'A montar o vídeo');
  const frameFor = (sh: Shot) => subtitleFrame((bases as any)[sh.scene], sh.text);
  const mp4 = await encodeComposite(ffmpeg, parts, frameFor, track, async (i, n) => progress(80 + Math.round((i / n) * 12), 100, `A montar o vídeo (${i} de ${n} partes)`), 'm4a', overlays);
  track = null;

  const fidelity: any[] = [];
  for (const s of want) {
    if (reused.has(s.id)) {
      const r = reused.get(s.id);
      if (r) for (const { c, at } of r) fidelity.push({ segmentId: s.id, role: s.role, expected: c.text, heard: at.heard, checked: true, edits: at.edits, ok: true, attempts: 0, used: true, problem: null, cause: null, reused: true });
      else fidelity.push({ segmentId: s.id, role: s.role, expected: s.text, heard: '', checked: false, edits: null, ok: false, attempts: 0, used: false, problem: 'no_clips', cause: null });
      continue;
    }
    for (const c of s.chunks) {
      const u = units.get(c.key)!;
      const best = u.chosen ?? [...u.atts].filter(a => a.checked).sort((x, y) => (x.hard ?? 99) - (y.hard ?? 99))[0];
      const problem = unitProblem(!!u.chosen, !!best, u.atts.some(a => !a.checked), u.problem);
      fidelity.push({ segmentId: s.id, role: s.role, expected: c.text, heard: best?.heard ?? '', checked: !!best?.checked, edits: best?.edits ?? null, ok: !!u.chosen, attempts: u.atts.length, used: veoSegs.has(s.id), problem, cause: u.cause ?? null });
    }
  }
  const costUsd = mock ? 0 : [...units.values()].flatMap(u => u.atts).reduce((x, a) => x + a.dur * a.usdPerSec, 0);
  await progress(94, 100, 'A guardar o vídeo');
  const usedRoles = new Set(plan.segs.filter(s => veoSegs.has(s.id)).map(s => s.role));
  // Modelo de cada clipe que entra no vídeo: os reaproveitados (falas já pagas ou tentativas de outras gerações) podem
  // ser de outro nível ou serviço, por exemplo do Lite num vídeo pedido no Fast.
  const clipModels: Record<string, number> = {};
  for (const s of plan.segs) for (const { at } of falaOut.get(s.id)?.clips ?? []) { const k = at.model ?? UNKNOWN_MODEL; clipModels[k] = (clipModels[k] ?? 0) + 1; }
  const meta = { engine: 'veo', model: tierModel, tier, usdPerSec: tierPrice, backend: veoBackend(), lang, guestPhoto: !!plan.guestPhoto, hostPhoto: !!plan.hostPhoto, guestAiVideo: usedRoles.has('guest'), hostAiVideo: usedRoles.has('host'),
    veoClips: want.reduce((n, s) => n + (reused.get(s.id)?.length ?? s.chunks.length), 0), veoSegments: veoSegs.size, fallbackSegments: fallbackSegs, generatedClips: generated, spentUsd: Math.max(0, spentUsd - failedUsd), failedUsd, veoUsd: costUsd, clipModels,
    googleBusy: fidelity.some(f => f.problem === 'busy' || f.problem === 'busycap'), quoteId: quote?.id ?? null, rebuildOf, paidBy: quote ? 'credits' : entityPays ? 'entity' : rebuildOf ? 'rebuild' : 'internal',
    fidelityIssues: fidelity.filter(f => !f.ok).length, fidelity, mock, graphics: graphicsMeta(overlays, gplan) };
  const id = await saveAsset(db, { interviewId: iv.id, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: mp4, durationMs: t, meta });
  // Ligação ao episódio, fim das aprovações anteriores e liquidação do orçamento numa só transação, com as autorizações
  // lidas no próprio momento. As aprovações ficam presas ao vídeo que foi visto (approvals.video_asset_id).
  let settled: { charged: number; released: number; owner: string } | null = null;
  const speechSec = (quote?.selection as any[] ?? []).filter(x => !x.reused && x.cents > 0).reduce((n, x) => n + Number(x.sec || 0), 0);
  const linked = await db.tx(async tx => {
    const row = await tx.one(
      `UPDATE episodes e SET video_asset_id=$2, video_lang=$3 FROM interviews i
       WHERE e.id=$1 AND i.id=e.interview_id AND NOT e.stale AND e.status='preview'
         AND (NOT $4::boolean OR (i.host_ai_video AND i.host_photo_rights)) AND (NOT $5::boolean OR i.host_photo_rights)
         AND (NOT $6::boolean OR (i.review_policy='guest_preview' AND COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=i.id AND c.purpose='ai_video' ORDER BY c.created_at DESC LIMIT 1), false)))
         AND (NOT $7::boolean OR COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=i.id AND c.purpose='publish_photo' ORDER BY c.created_at DESC LIMIT 1), false))
         AND COALESCE((SELECT a.decision FROM approvals a WHERE a.episode_id=e.id AND a.actor='guest' AND a.valid ORDER BY a.created_at DESC LIMIT 1), '') <> 'changes'
         AND EXISTS (SELECT 1 FROM scripts sc WHERE sc.id=e.script_id AND sc.status='approved')
       RETURNING e.id`,
      [ep.id, id, lang, meta.hostAiVideo, meta.hostPhoto, meta.guestAiVideo, meta.guestPhoto]);
    // Só as aprovações caem (um pedido de alterações do convidado mantém-se visível).
    if (row) await tx.query(`UPDATE approvals SET valid=false WHERE episode_id=$1 AND valid AND decision='approved'`, [ep.id]);
    if (row && quote) settled = await settleQuote(tx, quote.id, falaOut, { speechSec });
    return row;
  });
  if (!linked) throw new PermanentError('Uma autorização foi retirada, o convidado pediu alterações ou o episódio mudou durante a geração: o vídeo não foi ligado ao episódio e fica privado. Os clipes pagos ficam guardados.');
  if (quote && settled) await quoteSettledEmail(db, quote, settled, iv);
  await progress(100, 100, 'Concluído');
  return { videoAssetId: id, veoClips: meta.veoClips, generatedClips: generated, spentUsd, veoUsd: costUsd, fallbackSegments: fallbackSegs, fidelityIssues: meta.fidelityIssues, ...(settled ? { chargedCents: (settled as any).charged, releasedCents: (settled as any).released } : {}) };
}

/** Email com o resultado da produção: cobrado, libertado e o relatório por fala na página do orçamento. */
async function quoteSettledEmail(db: Db, quote: any, s: { charged: number; released: number; owner: string }, iv: any) {
  const u = await db.one('SELECT email FROM users WHERE id=$1', [s.owner]);
  if (!u) return;
  const url = `${config.baseUrl}/entrevistas/${iv.id}/orcamentos/${quote.id}`;
  const text = `A produção animada de «${iv.title}» terminou. Cobrados: ${cr(s.charged)} créditos (só as falas animadas e verificadas). Libertados e de volta ao saldo: ${cr(s.released)} créditos. O relatório por fala, com o motivo de cada fala que ficou em fotografia, está em ${url}`;
  await queueEmail(db, { key: `quote-settled:${quote.id}`, interviewId: iv.id, to: u.email, subject: `Produção animada concluída: ${cr(s.charged)} créditos cobrados`, text,
    html: emailShell('Produção animada concluída', `<p>${esc(text.replace(url, ''))}</p>`, { label: 'Ver o relatório', url }) });
}

/**
 * RGPD (art. 7.º, n.º 3, e art. 17.º): o convidado retirou a autorização do vídeo gerado pela IA (Veo) ou do retrato
 * animado. Os clipes com a imagem dele e os vídeos montados com eles são apagados (o que foi entregue continua cobrado).
 * Devolve quantos ficheiros saíram.
 */
export async function eraseGuestAiVideo(db: Db, interviewId: string, opts: { veo?: boolean; animated?: boolean } = { veo: true }) {
  const rows = await db.query(`SELECT id, storage_key FROM assets WHERE interview_id=$1 AND deleted_at IS NULL AND (
      ($2::boolean AND kind='veo_clip' AND meta->>'role'='guest') OR (kind='episode_video' AND (($2::boolean AND meta->>'guestAiVideo'='true') OR ($3::boolean AND meta->>'guestAnimated'='true'))))`, [interviewId, !!opts.veo, !!opts.animated]);
  for (const r of rows) {
    await db.query(`UPDATE assets SET deleted_at=now(), meta=meta || '{"erased":"guest_withdrawal"}'::jsonb WHERE id=$1`, [r.id]);
    await db.query('UPDATE episodes SET video_asset_id=NULL WHERE video_asset_id=$1', [r.id]);
    try { await storage.remove(r.storage_key); } catch (e: any) { console.error(`[rgpd] ficheiro ${r.id} por apagar: ${String(e?.message ?? e).slice(0, 200)}`); }
  }
  return rows.length;
}

/** Planos fixos de um intervalo, cortados nas legendas (pontos já alinhados a fotogramas). */
export function stillShots(scene: Scene, a: number, b: number, cues: { startMs: number; endMs: number; text: string }[]): Shot[] {
  const cuts = new Set<number>([a, b]);
  for (const c of cues) { if (c.startMs > a && c.startMs < b) cuts.add(c.startMs); if (c.endMs > a && c.endMs < b) cuts.add(c.endMs); }
  const pts = [...cuts].sort((x, y) => x - y);
  const shots: Shot[] = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const mid = (pts[i] + pts[i + 1]) / 2;
    shots.push({ startMs: pts[i], endMs: pts[i + 1], scene, text: cues.find(c => mid >= c.startMs && mid < c.endMs)?.text ?? '' });
  }
  return shots;
}

/** Porque é que um pedaço ficou sem clipe (relatório): a Google em procura elevada prevalece sobre uma tentativa anterior com diferenças. */
export const chunkProblem = (chosen: boolean, hasChecked: boolean, anyUnchecked: boolean, why?: string) =>
  chosen ? null : why === 'busy' || why === 'busycap' ? why : hasChecked ? 'mismatch' : anyUnchecked ? 'unchecked' : (why ?? 'error');

const UNKNOWN_MODEL = 'desconhecido';
/**
 * Modelos dos clipes que entram no vídeo, para o resumo da produção: vazio quando são todos do modelo pedido (ou num
 * vídeo antigo, que não os registava); senão a contagem por modelo, com os que vêm de gerações anteriores assinalados.
 */
export function clipModelsNote(meta: any): string {
  const entries = Object.entries((meta?.clipModels ?? {}) as Record<string, number>).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (!entries.length || (entries.length === 1 && entries[0][0] === meta.model)) return '';
  const name = (m: string) => (m === UNKNOWN_MODEL ? 'modelo não registado' : `${veoLabel(tierOfModel(m))} (${m})`);
  return `clipes no vídeo: ${entries.map(([m, n]) => `${n} do ${name(m)}${m === meta.model ? '' : ', de gerações anteriores'}`).join('; ')}`;
}

/** Qualquer vídeo (fotografias, retratos animados ou Veo) só entra num episódio por publicar: nunca vai para o ar sem ser visto e aprovado. */
export const VIDEO_ONLY_PREVIEW = 'Um vídeo novo só se gera para um episódio em pré-visualização (antes de publicar), para ser visto e aprovado antes de ir para o ar. Num episódio publicado ou retirado, para uma nova versão regenere o guião ou recomece a produção.';
export const VEO_ONLY_PREVIEW = 'O vídeo do Google Veo só se gera para um episódio em pré-visualização (antes da primeira publicação), para ser visto e aprovado. Para uma nova versão, regenere o guião ou recomece a produção.';
export const VEO_CHANGES = 'O convidado pediu alterações a esta versão: reveja o guião, aprove-o e gere um episódio novo antes do vídeo do Google Veo.';
export const VEO_BUSY = 'O Google Veo está com procura elevada e recusou vários clipes seguidos: tente gerar de novo mais tarde. Os clipes já obtidos ficam guardados e são reaproveitados; as operações que falharam normalmente não são cobradas.';
export const VEO_NO_CREDENTIALS = 'Falta a conta de serviço do Vertex AI (ou a chave da Gemini API) em Definições → Google.';
export const VEO_SCRIPT_REPLACED = 'O guião deste episódio foi substituído: aprove o guião revisto e gere o episódio de novo antes do vídeo do Google Veo.';
export const VEO_NEEDS_QUOTE = 'A animação com o Google Veo faz-se por orçamento: calcule o orçamento e aceite-o (o valor fica cativo e só se cobram as falas animadas e verificadas). Sem orçamento, só a geram o administrador e o gestor de uma entidade com credenciais Google próprias.';
export const VEO_ENTITY_CREDS_GONE = 'As credenciais Google da entidade foram retiradas durante a geração: nada mais foi enviado à Google. Sem elas, a animação do gestor faz-se por orçamento, com créditos.';
export const VEO_HOST_WITHDRAWN = 'A autorização do entrevistador para o Google Veo foi retirada: nada mais foi enviado à Google e o vídeo não foi ligado ao episódio.';
export const VEO_GUEST_WITHDRAWN = 'A autorização do convidado para o Google Veo foi retirada: nada mais foi enviado à Google e o vídeo não foi ligado ao episódio.';
export const VEO_QUOTE_CLOSED = 'O orçamento já não está em curso (anulado, cancelado ou liquidado): nada mais foi enviado à Google.';
export const VEO_QUOTE_EXPIRED = 'O orçamento passou a validade antes de a produção terminar: os créditos cativos voltaram ao saldo. Peça um orçamento novo.';
export const VEO_QUOTE_RATE_OFF = 'O motor deste orçamento foi desativado: os créditos cativos voltaram ao saldo. Peça um orçamento novo.';
export const VEO_QUOTE_CHANGED = 'O guião, as fotografias, as vozes ou os pedaços a gerar mudaram desde a aceitação: o orçamento foi anulado antes de qualquer envio à Google e os créditos voltaram ao saldo. Peça um orçamento novo.';
export const VEO_CANARY = 'Dos primeiros 8 pedaços, menos de 4 passaram na verificação palavra a palavra: a produção parou para não gastar mais e todos os créditos cativos voltaram ao saldo';
export const VEO_QUOTA_PAUSED = 'A aguardar quota da Google: o trabalho volta a tentar mais tarde e o orçamento continua em curso (os clipes já obtidos ficam guardados).';
