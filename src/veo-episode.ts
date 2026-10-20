import { config } from './config.ts';
import { storage } from './storage.ts';
import { sha256 } from './lib.ts';
import { saveAsset, hasAudioStream } from './media.ts';
import { transcribeClip, translateSubtitleCues, aiAvailable, type Word } from './ai/openai.ts';
import { renderBases, subtitleFrame, encodeComposite, buildAudioTrack, mockTalkingClip, type Part, type Shot, type Scene, type AudioPiece } from './video.ts';
import { cuesFromWords } from './subtitles.ts';
import { veoSubmit, veoAwait, veoEpisodePrompt, VeoQuotaError, VeoCancelled, VEO_MODEL, VEO_PRICE_PER_SEC } from './talking.ts';
import { S } from './settings.ts';
import { PermanentError, type Handler } from './jobs.ts';

/**
 * Vídeo do episódio inteiramente com o Google Veo: cada fala autorizada é dividida em pedaços que cabem num clipe
 * (até 8 s), o Veo gera imagem E voz a partir da fotografia autorizada e do texto aprovado, e os clipes são colados.
 * O som do vídeo é o dos clipes (não o áudio sintético do episódio). Cada clipe é transcrito e comparado palavra a
 * palavra com o guião: só entra no vídeo um clipe que diga o texto aprovado (toleram-se apenas grafias de nomes e
 * variantes ortográficas, nunca negações nem números). Se não disser, é gerado de novo (no máximo `veoRetries`
 * vezes); sem clipe aprovado, essa fala fica com a fotografia fixa e a voz do episódio. As legendas seguem o que foi dito.
 */

export const VEO_MAX_WORDS = 15; // palavras FALADAS (~6 s a 2,5/s): cabe num clipe de 8 s com folga
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
  return out;
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

/** Clipes e custo previstos (sem e com uma nova tentativa por clipe). */
export function veoEstimate(timing: any[], segments: any[], hostOk: boolean, guestOk: boolean) {
  const textOf = new Map<string, string>(segments.map((s: any) => [s.id, s.textEnglish]));
  let clips = 0, sec = 0;
  for (const t of timing) {
    if (t.kind === 'disclosure' || !(t.role === 'host' ? hostOk : guestOk)) continue;
    for (const c of chunkText(textOf.get(t.id) ?? '')) { clips++; sec += veoDuration(c); }
  }
  return { clips, sec, usd: sec * VEO_PRICE_PER_SEC, usdMax: clips * 8 * VEO_PRICE_PER_SEC * 2, minutes: Math.ceil(clips / 2) * 1.5 + 2 };
}

type Seg = { id: string; role: 'host' | 'guest'; kind: string; startMs: number; durationMs: number; endMs: number; text: string };
type Chunk = { seg: Seg; k: number; text: string; dur: 4 | 6 | 8; key: string; prompt: string };
type Attempt = { assetId: string; storageKey: string; words: Word[]; heard: string; checked: boolean; edits: number | null; hard: number | null; dur: number };

const passes = (a: Attempt) => a.checked && a.words.length > 0 && a.hard === 0;

export async function renderVeoVideo(job: any, { db, progress }: Parameters<Handler>[1]) {
  const ep = await db.one('SELECT * FROM episodes WHERE id=$1 AND interview_id=$2', [job.input.episodeId, job.interview_id]);
  if (!ep || ep.stale || ep.status === 'superseded') throw new PermanentError('Episódio inexistente ou desatualizado');
  if (ep.status !== 'preview') throw new PermanentError(VEO_ONLY_PREVIEW);
  const iv = await db.one('SELECT * FROM interviews WHERE id=$1', [ep.interview_id]);
  const timing = ep.technical?.timing as any[] | undefined;
  if (!timing?.length) throw new PermanentError('Este episódio foi gerado antes do vídeo existir: gere o episódio de novo');
  const mock = config.openai.mock;
  if (!mock && !S('GEMINI_API_KEY')) throw new PermanentError('Falta a chave da Google (Gemini API) em Definições');
  // Sem transcrição não há verificação: não se paga nenhum clipe que depois não se possa verificar.
  if (!mock && !aiAvailable()) throw new PermanentError('Falta a chave da OpenAI (transcrição para verificar os clipes) em Definições');
  const script = await db.one('SELECT segments, status FROM scripts WHERE id=$1', [ep.script_id]);
  // Só a partir do guião aprovado em vigor (um guião substituído pode ter o texto que o convidado contestou).
  if (script?.status !== 'approved') throw new PermanentError(VEO_SCRIPT_REPLACED);
  const textOf = new Map<string, string>((script?.segments ?? []).map((s: any) => [s.id, s.textEnglish]));
  const consent = async (p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [iv.id, p]))?.granted;
  // Pedido de alterações do convidado neste episódio ou noutro episódio do mesmo guião (um episódio novo não o apaga).
  const guestAskedChanges = async () => !!(await db.one(`SELECT 1 FROM approvals a JOIN episodes e2 ON e2.id=a.episode_id WHERE e2.script_id=$1 AND a.actor='guest' AND a.valid AND a.decision='changes' LIMIT 1`, [ep.script_id]));
  if (await guestAskedChanges()) throw new PermanentError(VEO_CHANGES);
  // Lida de novo antes de cada envio à Google: uma autorização retirada ou um pedido de alterações a meio param o trabalho.
  const stillAllowed = async (role: 'host' | 'guest'): Promise<string | null> => {
    if (await guestAskedChanges()) return VEO_CHANGES;
    const cur = await db.one(`SELECT e.status, e.stale, s.status AS script_status FROM episodes e LEFT JOIN scripts s ON s.id=e.script_id WHERE e.id=$1`, [ep.id]);
    if (!cur || cur.stale || cur.status !== 'preview') return 'O episódio mudou durante a geração (publicado, retirado ou desatualizado): nada mais foi enviado à Google.';
    if (cur.script_status !== 'approved') return VEO_SCRIPT_REPLACED;
    if (role === 'host') { const r = await db.one('SELECT host_ai_video, host_photo_rights FROM interviews WHERE id=$1', [iv.id]); return r?.host_ai_video && r?.host_photo_rights ? null : 'A autorização do entrevistador para o Google Veo foi retirada durante a geração: nada mais foi enviado à Google e o vídeo não foi ligado ao episódio.'; }
    const r = await db.one('SELECT review_policy FROM interviews WHERE id=$1', [iv.id]);
    return (await consent('ai_video')) && (await consent('publish_photo')) && r?.review_policy === 'guest_preview' ? null : 'A autorização do convidado para o Google Veo foi retirada durante a geração: nada mais foi enviado à Google e o vídeo não foi ligado ao episódio.';
  };
  await progress(0, 100, 'A preparar as imagens');
  const asset = async (id: string | null) => { if (!id) return null; const a = await db.one('SELECT storage_key FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]); return a ? storage.get(a.storage_key) : null; };

  // Só fotografias autorizadas; o Veo exige ainda a autorização específica de cada pessoa.
  const hostPhoto = iv.host_photo_rights ? await asset(iv.host_photo_asset_id) : null;
  let guestPhoto: Buffer | null = null;
  if (await consent('publish_photo')) {
    const pid = job.input.photoId ?? ep.technical?.coverPhotoIds?.[0] ?? null;
    const ph = pid ? await db.one('SELECT asset_id FROM photos WHERE id=$1 AND interview_id=$2', [pid, iv.id]) : await db.one('SELECT asset_id FROM photos WHERE interview_id=$1 ORDER BY created_at LIMIT 1', [iv.id]);
    guestPhoto = ph ? await asset(ph.asset_id) : null;
  }
  const hostVeo = !!hostPhoto && !!iv.host_ai_video;
  // O convidado só aparece no Veo se puder ver e aprovar o vídeo antes da publicação (política «o entrevistado aprova»).
  const guestVeo = !!guestPhoto && (await consent('ai_video')) && iv.review_policy === 'guest_preview';
  if (!hostVeo && !guestVeo) throw new PermanentError('Ninguém autorizou o vídeo gerado pelo Google Veo (entrevistador: em Editar; convidado: em «Autorizações das fotografias», e só com a política «o entrevistado aprova»)');
  const cover = await asset(ep.cover_asset_id);
  const audio = await asset(ep.audio_asset_id);
  if (!cover || !audio) throw new PermanentError('Capa ou áudio do episódio em falta');
  const lang: string | null = job.input.lang && ep.subtitles?.[job.input.lang] ? job.input.lang : null;
  const names = { host: iv.host_name || 'Host', guest: iv.guest_name || 'Guest' };
  const bases = await renderBases({ cover, title: ep.title, brand: config.brand, host: { name: names.host, photo: hostPhoto }, guest: { name: names.guest, photo: guestPhoto } });
  const { default: ff } = await import('@ffmpeg-installer/ffmpeg');
  const ffmpeg = process.env.FFMPEG_PATH || ff.path;
  const { default: sharp } = await import('sharp');

  // Imagem inicial: a fotografia recortada a 16:9 (ou 9:16 se for vertical, mostrada ao centro como os grandes planos).
  const startImage = async (photo: Buffer) => {
    const upright = await sharp(photo).rotate().toBuffer();
    const m = await sharp(upright).metadata();
    const vertical = (m.height ?? 0) > (m.width ?? 0) * 1.05;
    const image = await sharp(upright).resize(vertical ? 720 : 1280, vertical ? 1280 : 720, { fit: 'cover', position: 'attention' }).jpeg({ quality: 90 }).toBuffer();
    return { image, vertical, hash: sha256(image) };
  };
  const start = { host: hostVeo ? await startImage(hostPhoto!) : null, guest: guestVeo ? await startImage(guestPhoto!) : null };
  const voice = { host: iv.question_voice === 'male' ? 'male' : 'female', guest: iv.guest_voice === 'male' ? 'male' : 'female' } as const;
  const personNameSet = personNames([iv.host_name ?? '', iv.guest_name ?? '']);

  const segs: Seg[] = timing.map((t: any, i: number) => ({ ...t, endMs: i + 1 < timing.length ? timing[i + 1].startMs : ep.duration_ms, text: t.kind === 'disclosure' ? config.aiDisclosure : textOf.get(t.id) ?? '' }));
  const chunks: Chunk[] = [];
  for (const s of segs) if (s.kind !== 'disclosure' && start[s.role]) chunkText(s.text).forEach((text, k) => {
    const st = start[s.role]!, prompt = veoEpisodePrompt({ role: s.role, text, voice: voice[s.role] });
    // A chave não inclui a duração: as tentativas com outra duração contam para o mesmo pedaço.
    chunks.push({ seg: s, k, text, dur: veoDuration(text), prompt, key: sha256(`${st.hash}|${prompt}|${st.vertical ? '9:16' : '16:9'}|${VEO_MODEL}|${mock}`) });
  });

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

  // 1. Clipes: reaproveita tentativas já pagas e operações pagas por concluir; gera só o que falta.
  const maxAttempts = 1 + Math.max(0, Math.min(2, Number(job.input.veoRetries ?? 1)));
  const chosen: (Attempt | null)[] = new Array(chunks.length).fill(null);
  const attemptsOf: Attempt[][] = chunks.map(() => []);
  let spentUsd = 0, generated = 0, doneN = 0, next = 0;
  let abort: Error | null = null; // chave recusada, quota esgotada, autorização retirada ou erro inesperado: os dois trabalhadores param
  let timeouts = 0; // Google degradada: duas esperas esgotadas seguidas param o trabalho (as operações ficam pendentes e retomam-se)
  const pct = () => 5 + Math.round((doneN / Math.max(1, chunks.length)) * 70);
  const inflight = new Map<string, Promise<Attempt[]>>(); // pedaços iguais (mesmo papel e texto) geram-se uma só vez

  const runChunk = async (c: Chunk): Promise<Attempt[]> => {
    const st = start[c.seg.role]!;
    const prev = await db.query(`SELECT id, storage_key, meta FROM assets WHERE interview_id=$1 AND kind='veo_clip' AND meta->>'chunkKey'=$2 AND deleted_at IS NULL ORDER BY created_at`, [iv.id, c.key]);
    const atts: Attempt[] = [];
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
      atts.push({ assetId: a.id, storageKey: a.storage_key, words: m.words ?? [], heard: m.heard ?? '', checked: !!m.checked, edits: m.edits ?? null, hard: m.hard ?? null, dur: Number(m.dur ?? m.billedSec ?? 8) });
    }
    // Operações que falharam (ou expiraram) em execuções anteriores contam para o limite (o teto vale entre execuções).
    if (!mock) await db.query(`UPDATE veo_ops SET state='expired' WHERE interview_id=$1 AND chunk_key=$2 AND state='pending' AND created_at < now() - interval '36 hours'`, [iv.id, c.key]);
    let failures = mock ? 0 : Number((await db.one(`SELECT count(*)::int AS n FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state IN ('failed','expired')`, [iv.id, c.key]))?.n ?? 0);
    while (!abort && !atts.some(passes) && atts.length + failures < maxAttempts) {
      // Transcrição por fazer (OpenAI ou ffprobe em falha): não se paga outro clipe; volta a verificar-se na próxima execução.
      if (atts.length && !atts[atts.length - 1].checked) break;
      // Duração: a prevista; se a tentativa anterior saiu cortada (fala até ao fim do clipe ou incompleta), a seguinte.
      const last = atts[atts.length - 1];
      let dur: 4 | 6 | 8 = c.dur;
      if (last) {
        const lastEnd = last.words.length ? last.words[last.words.length - 1].end : 0;
        const short = normWords(last.heard).length < normWords(c.text).length * 0.85;
        dur = (lastEnd > last.dur - 0.6 || short) ? nextDuration(last.dur) : (last.dur as 4 | 6 | 8);
      }
      const label = `Google Veo: clipe ${doneN + 1} de ${chunks.length}${atts.length + failures ? ' (nova tentativa: o texto dito não coincidia)' : ''}`;
      await progress(pct(), 100, label);
      const onStatus = async (s: string) => progress(pct(), 100, `${label} — ${s}`);
      let opId: string | null = null;
      // Antes de CADA envio (também nas repetições após 429): trabalho não parado e autorizações em vigor.
      const canSend = async () => {
        if (abort) return false;
        const why = await stillAllowed(c.seg.role);
        if (why) { abort ??= new PermanentError(why); return false; }
        return true;
      };
      try {
        let video: Buffer;
        if (mock) {
          if (!(await canSend())) break;
          video = await mockTalkingClip(ffmpeg, st.image, dur * 1000, st.vertical);
        } else {
          // Uma operação já paga e por concluir (trabalho interrompido, erro de rede) é retomada, não submetida de novo.
          const pending = await db.one(`SELECT id, op_name, duration_sec FROM veo_ops WHERE interview_id=$1 AND chunk_key=$2 AND state='pending' ORDER BY created_at LIMIT 1`, [iv.id, c.key]);
          let opName: string;
          if (pending) { opId = pending.id; opName = pending.op_name; dur = Number(pending.duration_sec) as 4 | 6 | 8; }
          else {
            const s = await veoSubmit({ image: st.image, prompt: c.prompt, aspectRatio: st.vertical ? '9:16' : '16:9', durationSeconds: dur, onStatus, canSend });
            opName = s.opName; dur = s.dur;
            const usd = dur * VEO_PRICE_PER_SEC; spentUsd += usd;
            // A Google já aceitou (e cobra): registo da operação e do custo numa só transação, com novas tentativas.
            // Se não for possível registar, o trabalho pára em vez de voltar a submeter (o que pagaria duas vezes).
            for (let k = 0; ; k++) {
              try {
                opId = await db.tx(async tx => {
                  const id = (await tx.one(`INSERT INTO veo_ops(interview_id, chunk_key, op_name, duration_sec) VALUES ($1,$2,$3,$4) RETURNING id`, [iv.id, c.key, opName, dur])).id;
                  await tx.query('INSERT INTO usage_ledger(interview_id, kind, quantity, cost_usd, estimated) VALUES ($1,$2,$3,$4,true)', [iv.id, 'veo_usd', dur, usd]);
                  return id as string;
                });
                break;
              } catch (e: any) {
                if (k >= 2) { console.error(`[veo] operação paga ${opName} sem registo: ${String(e?.message ?? e).slice(0, 200)}`); abort ??= new PermanentError('Falha a registar uma operação já paga à Google: o trabalho parou para não pagar outra vez.'); throw new VeoCancelled('sem registo'); }
                await sleep(2000 * (k + 1));
              }
            }
          }
          try { video = (await veoAwait(opName, dur, onStatus)).video; }
          catch (e: any) {
            const m = String(e?.message ?? e);
            // Chave recusada na consulta: a operação paga fica pendente (retoma-se com a chave certa), não é dada como falhada.
            if (e instanceof PermanentError && !/^Veo 40[13]/.test(m)) await db.query(`UPDATE veo_ops SET state='failed' WHERE id=$1`, [opId]);
            if (/tempo excedido/.test(m) && ++timeouts >= 2) abort ??= new PermanentError('O Google Veo não está a concluir os clipes (duas esperas de 20 min esgotadas): tente mais tarde. As operações pagas ficam pendentes e são retomadas.');
            throw e;
          }
        }
        generated++;
        const tr = await transcribe(video, c.text, dur);
        if (!tr.checked) abort ??= new PermanentError('A verificação dos clipes (transcrição) falhou: o trabalho parou para não pagar clipes que não se podem verificar. Os clipes pagos ficam guardados e são verificados na próxima geração.');
        const j = judge(c, tr.words, tr.checked, tr.text);
        const meta = { chunkKey: c.key, segmentId: c.seg.id, role: c.seg.role, text: c.text, attempt: atts.length + 1, dur, billedSec: mock ? 0 : dur, words: tr.words, checked: tr.checked, ...j, model: VEO_MODEL, mock };
        const assetId = await saveAsset(db, { interviewId: iv.id, kind: 'veo_clip', mime: 'video/mp4', ext: 'mp4', data: video, durationMs: dur * 1000, meta });
        if (opId) await db.query(`UPDATE veo_ops SET state='done' WHERE id=$1`, [opId]);
        const a = await db.one('SELECT storage_key FROM assets WHERE id=$1', [assetId]);
        atts.push({ assetId, storageKey: a.storage_key, words: tr.words, heard: j.heard, checked: tr.checked, edits: j.edits, hard: j.hard, dur });
      } catch (e: any) {
        const m = String(e?.message ?? e);
        if (e instanceof VeoCancelled || abort) break;
        if (/^Veo 40[13]/.test(m)) { abort = new PermanentError(`A Google recusou a chave: ${m.slice(0, 200)}`); break; }
        if (e instanceof VeoQuotaError) { abort = new PermanentError(`${m} Os clipes já pagos ficam guardados e são reaproveitados.`); break; }
        failures++;
        console.error(`[veo] pedaço ${c.seg.id}/${c.k} falhou: ${m.slice(0, 300)}`);
      }
    }
    return atts;
  };

  await progress(5, 100, `Google Veo: 0 de ${chunks.length} clipes`);
  const worker = async () => {
    while (next < chunks.length && !abort) {
      const i = next++, c = chunks[i];
      try {
        let p = inflight.get(c.key);
        if (!p) { p = runChunk(c); inflight.set(c.key, p); }
        const atts = await p;
        attemptsOf[i] = atts;
        chosen[i] = atts.find(passes) ?? null; // nunca um clipe que não disse o texto aprovado
        doneN++;
        await progress(pct(), 100, `Google Veo: ${doneN} de ${chunks.length} clipes`);
      } catch (e: any) { abort ??= e instanceof PermanentError ? e : new Error(`Falha a gerar os clipes: ${String(e?.message ?? e).slice(0, 300)}`); }
    }
  };
  await Promise.allSettled([worker(), worker()]); // só termina quando os dois pararam (nenhum fica a gerar sozinho)
  if (abort) throw abort;

  // 2. Linha temporal: aviso inicial (capa + voz do episódio), falas do Veo, reserva em imagem fixa, cartão final.
  const parts: Part[] = [], audioPieces: AudioPiece[] = [];
  const sceneOf = new Map<Part, Scene>();
  type C = { id: string; startMs: number; endMs: number; text: string };
  const veoCues: C[] = [], fixedCues: C[] = [];
  const epCues: any[] = lang ? ep.subtitles[lang] : [];
  const stillScene = (s: Seg): Scene => (s.kind === 'disclosure' || s.kind === 'editorial_outro' ? 'cover' : s.kind === 'editorial_intro' ? 'studio' : s.role);
  const veoSegs = new Set<string>(), fallbackSegs: string[] = [];
  let t = 0;
  for (const s of segs) {
    const mine = chunks.map((c, i) => ({ c, ch: chosen[i] })).filter(x => x.c.seg === s);
    if (!mine.length || mine.some(x => !x.ch)) {
      if (mine.length) fallbackSegs.push(s.id);
      const from = s === segs[0] ? 0 : s.startMs, dur = snap(s.endMs - from);
      if (dur < 40) continue;
      for (const c of epCues) if (c.endMs > from && c.startMs < from + dur) fixedCues.push({ id: c.id, startMs: Math.max(t, t + c.startMs - from), endMs: Math.min(t + dur, t + c.endMs - from), text: c.text });
      const still: Part = { kind: 'still', startMs: t, endMs: t + dur, shots: [] };
      parts.push(still); sceneOf.set(still, stillScene(s));
      audioPieces.push({ durMs: dur, src: audio, ext: 'mp3', offsetMs: from });
      t += dur;
      continue;
    }
    veoSegs.add(s.id);
    for (const { c, ch } of mine) {
      const at = ch!, clipMs = at.dur * 1000, w = at.words;
      const { a, b } = trimWindow(w, clipMs, c.text);
      const dur = b - a;
      const cues = cuesFromWords(w, { id: `${s.id}-${c.k}`, role: s.role, text: at.heard, startMs: t - a, durationMs: clipMs }, 'en');
      for (const q of cues) if (q.endMs > t && q.startMs < t + dur) veoCues.push({ id: q.id, startMs: Math.max(t, q.startMs), endMs: Math.min(t + dur, q.endMs), text: q.text });
      const load = () => storage.get(at.storageKey);
      parts.push({ kind: 'anim', startMs: t, endMs: t + dur, base: s.role === 'host' ? bases.animHost : bases.animGuest, clip: load, clipOffsetMs: a, notice: VEO_NOTICE, who: { name: names[s.role], role: s.role === 'host' ? 'Host' : 'Guest' }, cues: [] });
      audioPieces.push({ durMs: dur, src: load, ext: 'mp4', offsetMs: a });
      t += dur;
    }
  }
  if (parts[parts.length - 1]?.kind === 'anim') { // fecho na capa
    const end: Part = { kind: 'still', startMs: t, endMs: t + 1600, shots: [] };
    parts.push(end); sceneOf.set(end, 'cover');
    audioPieces.push({ durMs: 1600 }); t += 1600;
  }

  // 3. Legendas na língua escolhida: as do Veo seguem o que foi dito (traduzidas se preciso); as fixas vêm do episódio.
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
    else p.shots = stillShots(sceneOf.get(p) ?? 'cover', p.startMs, p.endMs, inside.map(c => ({ ...c, startMs: c.startMs + p.startMs, endMs: c.endMs + p.startMs })));
  }

  // 4. Som (dos clipes, codificado uma só vez em AAC) e montagem.
  await progress(78, 100, 'A juntar o som dos clipes');
  let track: Buffer | null = await buildAudioTrack(ffmpeg, audioPieces);
  await progress(80, 100, 'A montar o vídeo');
  const frameFor = (sh: Shot) => subtitleFrame((bases as any)[sh.scene], sh.text);
  const mp4 = await encodeComposite(ffmpeg, parts, frameFor, track, async (i, n) => progress(80 + Math.round((i / n) * 12), 100, `A montar o vídeo (${i} de ${n} partes)`), 'm4a');
  track = null;

  const fidelity = chunks.map((c, i) => {
    const best = chosen[i] ?? [...attemptsOf[i]].filter(a => a.checked).sort((x, y) => (x.hard ?? 99) - (y.hard ?? 99))[0];
    return { segmentId: c.seg.id, role: c.seg.role, expected: c.text, heard: best?.heard ?? '', checked: !!best?.checked, edits: best?.edits ?? null, ok: !!chosen[i], attempts: attemptsOf[i].length, used: veoSegs.has(c.seg.id) };
  });
  const uniq = new Map<string, Attempt[]>(chunks.map((c, i) => [c.key, attemptsOf[i]]));
  const costUsd = mock ? 0 : [...uniq.values()].flat().reduce((x, a) => x + a.dur * VEO_PRICE_PER_SEC, 0);
  await progress(94, 100, 'A guardar o vídeo');
  const usedRoles = new Set(segs.filter(s => veoSegs.has(s.id)).map(s => s.role));
  const meta = { engine: 'veo', model: VEO_MODEL, lang, guestPhoto: !!guestPhoto, hostPhoto: !!hostPhoto, guestAiVideo: usedRoles.has('guest'), hostAiVideo: usedRoles.has('host'),
    veoClips: chunks.length, veoSegments: veoSegs.size, fallbackSegments: fallbackSegs, generatedClips: generated, spentUsd, veoUsd: costUsd,
    fidelityIssues: fidelity.filter(f => !f.ok).length, fidelity, mock };
  const id = await saveAsset(db, { interviewId: iv.id, kind: 'episode_video', mime: 'video/mp4', ext: 'mp4', data: mp4, durationMs: t, meta });
  // Ligação ao episódio e fim das aprovações anteriores numa só transação, com as autorizações lidas no próprio momento.
  // As aprovações ficam também presas ao vídeo que foi visto (approvals.video_asset_id): uma aprovação antiga não serve.
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
    return row;
  });
  if (!linked) throw new PermanentError('Uma autorização foi retirada, o convidado pediu alterações ou o episódio mudou durante a geração: o vídeo não foi ligado ao episódio e fica privado. Os clipes pagos ficam guardados.');
  await progress(100, 100, 'Concluído');
  return { videoAssetId: id, veoClips: chunks.length, generatedClips: generated, spentUsd, veoUsd: costUsd, fallbackSegments: fallbackSegs, fidelityIssues: meta.fidelityIssues };
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

export const VEO_ONLY_PREVIEW = 'O vídeo do Google Veo só se gera para um episódio em pré-visualização (antes da primeira publicação), para ser visto e aprovado. Para uma nova versão, regenere o guião ou recomece a produção.';
export const VEO_CHANGES = 'O convidado pediu alterações a esta versão: reveja o guião, aprove-o e gere um episódio novo antes do vídeo do Google Veo.';
export const VEO_SCRIPT_REPLACED = 'O guião deste episódio foi substituído: aprove o guião revisto e gere o episódio de novo antes do vídeo do Google Veo.';
