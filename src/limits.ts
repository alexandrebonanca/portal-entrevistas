import type { Db } from './db.ts';
import { config } from './config.ts';

/** Tolerância no fim de uma gravação: o gravador pára no limite, mas o ficheiro pode ficar uns décimos acima. */
export const LIMIT_SLACK_MS = 2000;
/** Uma pergunta adicional só se envia se o convidado ainda tiver, pelo menos, este tempo de resposta. */
export const FOLLOWUP_MIN_LEFT_SEC = 30;

/**
 * Limites a fixar na entrevista no convite: os do plano da subscrição que o autoriza, ou os gerais sem plano (gestor de
 * entidade, que convida sem subscrição); o administrador não tem limite.
 */
export function inviteLimits(quota: { exempt: boolean; plan: any }): { answerLimitSec: number | null; questionLimit: number | null } {
  if (quota.exempt) return { answerLimitSec: null, questionLimit: null };
  return {
    answerLimitSec: Number(quota.plan?.max_answer_total_sec ?? config.limits.maxAnswerTotalSec),
    questionLimit: Number(quota.plan?.max_questions ?? config.limits.maxQuestions),
  };
}

/** Máximo de perguntas no rascunho: o do plano (ou o geral, sem plano ou para o administrador). */
export const draftQuestionMax = (quota: { exempt: boolean; plan: any }) =>
  quota.exempt ? config.limits.maxQuestions : Number(quota.plan?.max_questions ?? config.limits.maxQuestions);

/** Duração (ms) das respostas escolhidas de todas as perguntas da entrevista, adicionais incluídas; opcionalmente sem a de uma pergunta. */
export async function answeredMs(db: Db, interviewId: string, exceptQuestionId: string | null = null): Promise<number> {
  const r = await db.one(`SELECT COALESCE(sum(ast.duration_ms),0)::bigint AS ms FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets ast ON ast.id=t.asset_id
    WHERE an.interview_id=$1 AND an.status='answered' AND ($2::uuid IS NULL OR an.question_id<>$2::uuid)`, [interviewId, exceptQuestionId]);
  return Number(r?.ms ?? 0);
}

/**
 * Resposta escrita (ficheiro Word ou texto): conta para os limites como a duração estimada da leitura pela voz sintética,
 * a ~150 palavras por minuto. O teto por resposta é o mesmo das gravações, em palavras.
 */
export const WORDS_PER_MIN = 150;
export const wordsToMs = (words: number) => Math.round((words * 60_000) / WORDS_PER_MIN);
export const msToWords = (ms: number) => Math.floor((ms * WORDS_PER_MIN) / 60_000);
export const maxAnswerWords = () => msToWords(config.limits.maxAnswerSeconds * 1000);

/** Segundos de resposta que ainda restam (null = sem limite). */
export const secondsLeft = (limitSec: number | null | undefined, usedMs: number): number | null =>
  limitSec == null ? null : Math.max(0, Math.floor((limitSec * 1000 - usedMs) / 1000));

export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---- línguas das legendas ----
/** Línguas das legendas que o portal oferece (o inglês do guião e as quatro traduções), com o nome na página. */
export const SUBTITLE_LANGS: readonly (readonly [code: string, label: string])[] = [['en', 'English'], ['pt-PT', 'Português (PT)'], ['es', 'Español'], ['fr', 'Français'], ['de', 'Deutsch']];
/**
 * Línguas das legendas pedidas: só as oferecidas e cada uma uma vez, pela ordem do pedido (no máximo as de
 * SUBTITLE_LANGS). Antes, o /gerar, o /gerar/repetir e o «Guardar» só tiravam as desconhecidas: um pedido com ['en',
 * 'de' × 3000] dava um trabalho com 3001 línguas e 3000 traduções das legendas (gpt-4.1, sem cache), numa só geração.
 */
export const subtitleLangs = (v: unknown): string[] =>
  [...new Set(([] as unknown[]).concat(v ?? []).filter((l): l is string => typeof l === 'string' && SUBTITLE_LANGS.some(s => s[0] === l)))];

/** 1.ª entrevista grátis: trabalhos de produção por entrevista (ver free-interview.ts, freeProductionJobs; aqui para os termos). */
export const FREE_PRODUCTION_JOBS = 8;
/** Trabalhos de produção por usar de que um guião novo precisa na entrevista grátis: o dele e o da geração do episódio (ver free-interview.ts). */
export const FREE_JOBS_FOR_SCRIPT = 2;
/** 1.ª entrevista grátis: gerações do vídeo com fotografias por entrevista (ver free-interview.ts, freeVideoRenders; aqui para os termos). */
export const FREE_VIDEO_RENDERS = 3;

// ---- regenerações do guião e do episódio ----
/** Regenerações já contadas na entrevista (trabalhos marcados como regeneração e que não falharam). */
export async function regenerationsUsed(db: Db, interviewId: string): Promise<number> {
  return Number((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind IN ('process_submission','prepare_script','generate_episode')
    AND input->>'regen'='true' AND state<>'failed'`, [interviewId]))?.n ?? 0);
}

export const REGEN_BLOCKED = () => `Já usou as ${config.limits.includedRegenerations} regenerações incluídas nesta entrevista (guião e episódio). Cada regeneração seguinte custa 1 crédito.`;

// ---- tamanho do guião (síntese de voz) ----
/**
 * Máximo de caracteres de cada segmento do guião, abaixo do limite de entrada da síntese de voz da OpenAI (4096 por pedido):
 * antes, um segmento maior só falhava dentro do trabalho do episódio, depois de pagos os anteriores.
 */
export const SCRIPT_SEGMENT_MAX = 4000;
/**
 * Máximo de caracteres do guião inteiro (cerca de uma hora de voz). Antes, o guião editado à mão não tinha limite (só o do
 * pedido, MAX_UPLOAD_MB): cada geração pagava a voz, os tempos das legendas e as traduções de todo o texto escrito, e a
 * estimativa só olha para os minutos de resposta.
 */
export const SCRIPT_TOTAL_MAX = 60_000;
/**
 * 1.ª entrevista grátis (sem pagamento): o total acompanha a entrevista, com folga — o texto editorial (apresentação,
 * transições, agradecimento), uma vez e meia o texto das perguntas e, por minuto de resposta, cerca do dobro do que se diz
 * num minuto (~900 caracteres, como em estimateCost).
 */
export const FREE_SCRIPT_BASE = 3000, FREE_SCRIPT_PER_MIN = 2000;

/**
 * 1.ª entrevista grátis: máximo de caracteres de uma transcrição de resposta editada à mão, pela duração da gravação (com
 * folga: uma base e cerca do dobro do que se diz num minuto). Antes, cada transcrição editada ia até 20 000 caracteres, para
 * qualquer gravação: com elas, o guião do gpt-4.1 (processar ou regenerar) e a verificação recebiam texto sem relação com a
 * gravação, e uma saída cortada (JSON incompleto) falhava depois de paga. Nunca abaixo da transcrição automática (a 1.ª
 * revisão). null: sem este máximo (entrevista paga, administrador).
 */
export const FREE_TRANSCRIPT_BASE = 300, FREE_TRANSCRIPT_PER_MIN = 2000;
export async function transcriptMax(db: Db, iv: { id: string; free_at?: unknown }, takeId: string, admin: boolean): Promise<{ max: number; minutes: number } | null> {
  if (admin || !iv.free_at) return null;
  const r = await db.one(`SELECT COALESCE(ast.duration_ms,0)::bigint AS ms,
      (SELECT length(tr.text) FROM transcripts tr WHERE tr.source_kind='answer_take' AND tr.source_id=t.id ORDER BY tr.revision LIMIT 1) AS first
    FROM answer_takes t JOIN answers a ON a.id=t.answer_id JOIN assets ast ON ast.id=t.asset_id WHERE t.id=$1 AND a.interview_id=$2`, [takeId, iv.id]);
  const ms = Number(r?.ms ?? 0);
  return { max: Math.max(Math.ceil(FREE_TRANSCRIPT_BASE + (FREE_TRANSCRIPT_PER_MIN * ms) / 60000), Number(r?.first ?? 0)), minutes: ms / 60000 };
}

/** Inteiro com espaço a separar os milhares («28 120»). */
export const milhares = (n: number) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Máximo de caracteres do guião inteiro para quem pede (null: o administrador, que não fica bloqueado). */
export async function scriptTotalMax(db: Db, iv: { id: string; free_at?: unknown }, admin: boolean): Promise<{ max: number; free: boolean; minutes: number } | null> {
  if (admin) return null;
  if (!iv.free_at) return { max: SCRIPT_TOTAL_MAX, free: false, minutes: 0 };
  const minutes = (await answeredMs(db, iv.id)) / 60000;
  const q = await db.one(`SELECT COALESCE(sum(length(COALESCE(NULLIF(q.text,''), (SELECT t.text FROM transcripts t WHERE t.source_kind='question' AND t.source_id=q.id ORDER BY t.revision DESC LIMIT 1), ''))),0)::int AS n
    FROM questions q WHERE q.interview_id=$1`, [iv.id]);
  const max = Math.ceil(FREE_SCRIPT_BASE + 1.5 * Number(q?.n ?? 0) + FREE_SCRIPT_PER_MIN * minutes);
  return { max: Math.min(SCRIPT_TOTAL_MAX, max), free: true, minutes };
}

/**
 * Porque é que o guião não se pode gravar, aprovar ou gerar (null = pode), em português: um segmento acima de
 * SCRIPT_SEGMENT_MAX (para todos: é o limite da síntese de voz) ou o guião acima do total de scriptTotalMax.
 */
export async function scriptSizeError(db: Db, iv: { id: string; free_at?: unknown }, segments: { id: string; textEnglish: string }[], admin: boolean): Promise<string | null> {
  const long = segments.filter(s => s.textEnglish.length > SCRIPT_SEGMENT_MAX);
  if (long.length) return `${long.map(s => `O segmento ${s.id} tem ${milhares(s.textEnglish.length)} caracteres`).join('; ')}: cada segmento pode ter até ${milhares(SCRIPT_SEGMENT_MAX)} (limite da síntese de voz). Encurte-o${long.length > 1 ? 's' : ''}.`;
  const lim = await scriptTotalMax(db, iv, admin);
  const total = segments.reduce((a, s) => a + s.textEnglish.length, 0);
  if (!lim || total <= lim.max) return null;
  return lim.free
    ? `O guião tem ${milhares(total)} caracteres e, na 1.ª entrevista grátis, pode ter até ${milhares(lim.max)} (calculado a partir das perguntas e de ${lim.minutes.toFixed(1).replace('.', ',')} min de respostas). Encurte o texto dos segmentos.`
    : `O guião tem ${milhares(total)} caracteres e pode ter até ${milhares(lim.max)}. Encurte o texto dos segmentos.`;
}
