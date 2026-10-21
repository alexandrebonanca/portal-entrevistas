import type { Db } from './db.ts';
import { config } from './config.ts';
import { inEntity, entityOfInterview } from './settings.ts';

export interface EnqueueOpts { kind: string; interviewId?: string | null; input?: object; dedupe?: string; costUsd?: number; delayMs?: number }

/** Deduplicada: a mesma chave não cria dois trabalhos (cliques duplicados, retries de pedido). */
export async function enqueue(db: Db, o: EnqueueOpts) {
  const row = await db.one(
    `INSERT INTO jobs(interview_id, kind, input, dedupe_key, cost_estimate_usd, run_after) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' milliseconds')::interval)
     ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`,
    [o.interviewId ?? null, o.kind, JSON.stringify(o.input ?? {}), o.dedupe ?? null, o.costUsd ?? null, String(o.delayMs ?? 0)]);
  return row?.id as string | undefined;
}

export type Handler = (job: any, ctx: { db: Db; progress: (done: number, total?: number, label?: string) => Promise<void> }) => Promise<object | void>;

/** Obtém e executa um trabalho. Erros permanentes (PermanentError) não são repetidos às cegas. */
export class PermanentError extends Error {}
/**
 * Pausa: o trabalho volta à fila daqui a `delayMs` sem gastar uma tentativa (ex.: quota da Google esgotada, confirmação
 * por email ainda por enviar). A mensagem fica como etapa visível.
 */
export class JobPaused extends Error {
  delayMs: number;
  constructor(message: string, delayMs: number) { super(message); this.delayMs = delayMs; }
}

/**
 * Vias da fila: os vídeos (Veo, retratos animados, laboratório) levam de minutos a horas e correm numa via própria, para
 * nunca atrasarem a transcrição, o guião e o episódio dos outros clientes (via curta). 'all' é a via única (testes e
 * WORKER_LANES=1), com os curtos primeiro.
 */
export type Lane = 'short' | 'video';
export const VIDEO_KINDS = ['render_video', 'talking_compare', 'lipsync_experiment'];
export const laneOf = (kind: string): Lane => (VIDEO_KINDS.includes(kind) ? 'video' : 'short');
const VIDEO_IN = `(${VIDEO_KINDS.map(k => `'${k}'`).join(',')})`; // constantes do código, nunca dados de quem pede
const laneWhere = (lane: Lane | 'all') => (lane === 'video' ? `kind IN ${VIDEO_IN}` : lane === 'short' ? `kind NOT IN ${VIDEO_IN}` : 'true');
/** A entrevista do trabalho não tem outro trabalho a correr (sem entrevista: laboratório). A ordem de chegada desempata
 * pelo id (vários trabalhos postos na fila na mesma transação têm o mesmo created_at). */
const IDLE_INTERVIEW = (j: string) => `(${j}.interview_id IS NULL OR NOT EXISTS (SELECT 1 FROM jobs r WHERE r.state='running' AND r.interview_id=${j}.interview_id))`;
/** Trabalhos a correr neste processo: o vigilante nunca os dá como interrompidos. */
export const runningHere = new Set<string>();

export async function runOne(db: Db, handlers: Record<string, Handler>, lane: Lane | 'all' = 'all'): Promise<boolean> {
  // Em cada via, por ordem de chegada; na via única, os vídeos (longos) depois dos trabalhos curtos. Um trabalho por
  // entrevista de cada vez, como na via única (ex.: um episódio novo não começa a meio do vídeo do anterior); as vias
  // reclamam uma de cada vez (bloqueio consultivo), para esta regra não ter corridas.
  // ready_at: a primeira vez que o trabalho pôde arrancar (o prazo de 24 h dos orçamentos conta daqui).
  const job = await db.tx(async t => {
    await t.query('SELECT pg_advisory_xact_lock(7710301)');
    return t.one(
      `UPDATE jobs SET state='running', attempts=attempts+1, locked_at=now(), started_at=COALESCE(started_at, now()), ready_at=COALESCE(ready_at, now())
       WHERE id = (SELECT c.id FROM jobs c WHERE c.state='queued' AND c.run_after <= now() AND ${laneWhere(lane)} AND ${IDLE_INTERVIEW('c')}
         ORDER BY ${lane === 'all' ? `(kind IN ${VIDEO_IN}), ` : ''}c.created_at, c.id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
  });
  if (!job) return false;
  runningHere.add(job.id);
  // Batimento: enquanto o trabalho corre, o bloqueio renova-se sozinho, mesmo sem progresso (ex.: à espera de uma operação
  // da Google); o vigilante só retoma um trabalho sem batimento, ou seja, de um processo que morreu.
  const beat = setInterval(() => { db.query(`UPDATE jobs SET locked_at=now() WHERE id=$1 AND state='running'`, [job.id]).catch(() => {}); }, Math.max(10, config.queue.heartbeatMs));
  beat.unref?.();
  const h = handlers[job.kind];
  try {
    if (!h) throw new PermanentError(`Sem handler para ${job.kind}`);
    const ent = job.interview_id ? await entityOfInterview(db, job.interview_id) : null;
    const result = await inEntity(ent, () => h(job, { db, progress: async (done, total, label) => { await db.query('UPDATE jobs SET progress_done=$2, progress_total=COALESCE($3, progress_total), progress_label=COALESCE($4, progress_label), locked_at=now() WHERE id=$1', [job.id, done, total ?? null, label ?? null]); } }));
    await db.query(`UPDATE jobs SET state='done', result=$2, finished_at=now(), error=NULL WHERE id=$1`, [job.id, JSON.stringify(result ?? {})]);
  } catch (err: any) {
    if (err instanceof JobPaused) {
      console.error(`[job] ${job.kind} ${job.id} em pausa ${Math.round(err.delayMs / 1000)} s: ${err.message.slice(0, 300)}`);
      await db.query(`UPDATE jobs SET state='queued', attempts=GREATEST(attempts-1, 0), locked_at=NULL, error=$2, progress_label=$2, run_after=now() + ($3 || ' milliseconds')::interval WHERE id=$1`,
        [job.id, err.message.slice(0, 800), String(Math.max(1000, Math.round(err.delayMs)))]);
      return true;
    }
    const permanent = err instanceof PermanentError || job.attempts >= job.max_attempts;
    console.error(`[job] ${job.kind} ${job.id} tentativa ${job.attempts}${permanent ? ' (definitiva)' : ''}: ${String(err?.message ?? err).slice(0, 400)}`);
    const backoffSec = 30 * 2 ** (job.attempts - 1);
    await db.query(
      `UPDATE jobs SET state=$2, error=$3, finished_at=CASE WHEN $2='failed' THEN now() END, run_after=now() + ($4 || ' seconds')::interval, locked_at=NULL WHERE id=$1`,
      [job.id, permanent ? 'failed' : 'queued', String(err?.message ?? err).slice(0, 800), String(backoffSec)]);
    if (permanent && handlers['__onFail']) await handlers['__onFail'](job, { db, progress: async () => {} });
  } finally {
    clearInterval(beat);
    runningHere.delete(job.id);
  }
  return true;
}

/**
 * Retoma os trabalhos interrompidos (o processo que os corria morreu: reinício, deploy, falha). Um trabalho de orçamento
 * (input.quoteId) volta à fila SEM gastar a tentativa, porque a retoma é idempotente (clipes e operações já pagas
 * reaproveitam-se, a cativação e a liquidação são únicas); só falha ao fim de JOB_MAX_INTERRUPTIONS reinícios. Os outros
 * gastam a tentativa, como antes. Os que falham de vez passam pelo __onFail (orçamento libertado, crédito devolvido).
 */
async function recoverInterrupted(db: Db, handlers: Record<string, Handler> | undefined, silentMs: number, label: string) {
  const max = Math.max(1, config.queue.maxInterruptions);
  // Uma só instrução (o mesmo instante para todos): um trabalho nunca escapa a uma volta para cair na seguinte.
  const quoteJob = `input->>'quoteId' IS NOT NULL`;
  const resumable = `(CASE WHEN ${quoteJob} THEN interruptions < $3 ELSE attempts < max_attempts END)`;
  const rows = await db.query(
    `UPDATE jobs SET state=CASE WHEN ${resumable} THEN 'queued' ELSE 'failed' END, locked_at=NULL, interruptions=interruptions+1,
       run_after=CASE WHEN ${resumable} THEN now() ELSE run_after END,
       progress_label=CASE WHEN ${resumable} THEN $4 ELSE progress_label END,
       attempts=CASE WHEN ${quoteJob} AND ${resumable} THEN GREATEST(attempts-1, 0) ELSE attempts END,
       finished_at=CASE WHEN ${resumable} THEN finished_at ELSE now() END,
       error=CASE WHEN ${resumable} THEN error WHEN ${quoteJob} THEN $5 ELSE COALESCE(error, 'Interrompido e sem mais tentativas') END
     WHERE state='running' AND id::text NOT IN (SELECT jsonb_array_elements_text($2::jsonb))
       ${silentMs > 0 ? `AND (locked_at IS NULL OR locked_at < now() - ($1 || ' milliseconds')::interval)` : `AND $1::text IS NOT NULL`}
     RETURNING *`,
    [String(Math.max(0, Math.round(silentMs))), JSON.stringify([...runningHere]), max, label, `Interrompido ${max} vezes por reinícios do servidor: a produção parou e os créditos cativos voltaram ao saldo.`]);
  const failed = rows.filter((j: any) => j.state === 'failed');
  for (const j of failed) {
    console.error(`[job] ${j.kind} ${j.id} interrompido e sem mais tentativas`);
    try { await handlers?.['__onFail']?.(j, { db, progress: async () => {} }); } catch (e: any) { console.error('[job] __onFail', e?.message ?? e); }
  }
  return { resumed: rows.length - failed.length, failed: failed.length };
}

/** Vigilante: trabalhos sem batimento há JOB_STALE_MS e que não correm neste processo ficaram órfãos. */
export const recoverStale = (db: Db, handlers?: Record<string, Handler>) =>
  recoverInterrupted(db, handlers, config.queue.staleMs, 'Retomado: o processo que o corria parou (reinício do servidor)');

/** No arranque (instância única): os trabalhos que estavam 'running' ficaram órfãos com o reinício — retomam já. */
export const recoverOrphans = (db: Db, handlers?: Record<string, Handler>) =>
  recoverInterrupted(db, handlers, 0, 'Retomado depois de um reinício do servidor');

/**
 * Vídeos que já podem arrancar: o primeiro da via por ordem de chegada, com a via livre (nada a correr nem à frente) e
 * sem outro trabalho da mesma entrevista a correr.
 * O prazo de 24 h dos orçamentos aceites conta a partir daqui (ou do arranque, se o worker o apanhar antes do vigilante),
 * nunca do tempo à espera dos vídeos à frente na fila.
 */
export async function markReady(db: Db) {
  return (await db.query(`UPDATE jobs j SET ready_at=now() WHERE j.state='queued' AND j.ready_at IS NULL AND j.run_after <= now() AND j.kind IN ${VIDEO_IN} AND ${IDLE_INTERVIEW('j')}
    AND NOT EXISTS (SELECT 1 FROM jobs o WHERE o.kind IN ${VIDEO_IN} AND o.id<>j.id AND (o.state='running' OR (o.state='queued' AND o.run_after <= now() AND (o.created_at, o.id) < (j.created_at, j.id))))
    RETURNING j.id`)).length;
}

/** Minutos de um vídeo sem orçamento à frente na fila (o Veo do administrador; retratos animados e laboratório). */
const DEFAULT_VIDEO_MIN = { veo: 30, other: 5 };

/**
 * Posição na via dos vídeos: quantos estão à frente (todos os que correm e os que chegaram antes, também os em pausa,
 * que voltam) e os minutos estimados até a via ficar livre (o do orçamento; a parte que falta, se já começou). Sem
 * trabalho (orçamento por aceitar), conta tudo o que está na via.
 */
export async function videoQueue(db: Db, jobId?: string | null): Promise<{ ahead: number; minutes: number; running: boolean }> {
  const me = jobId ? await db.one('SELECT id, state FROM jobs WHERE id=$1', [jobId]) : null;
  if (me?.state === 'running') return { ahead: 0, minutes: 0, running: true };
  const rows = await db.query(`SELECT j.state, j.input, j.progress_done, j.progress_total, q.est_minutes FROM jobs j LEFT JOIN animation_quotes q ON q.id::text = j.input->>'quoteId'
    WHERE j.kind IN ${VIDEO_IN} AND j.id IS DISTINCT FROM $1::uuid
      AND (j.state='running' OR (j.state='queued' AND ($1::uuid IS NULL OR (j.created_at, j.id) < (SELECT m.created_at, m.id FROM jobs m WHERE m.id=$1::uuid))))`, [me?.id ?? null]);
  let minutes = 0;
  for (const r of rows) {
    const full = r.est_minutes != null ? Number(r.est_minutes) : r.input?.engine === 'veo' ? DEFAULT_VIDEO_MIN.veo : DEFAULT_VIDEO_MIN.other;
    const total = Number(r.progress_total) || 0, done = Math.min(Number(r.progress_done) || 0, total);
    minutes += r.state === 'running' && total ? full * (1 - done / total) : full;
  }
  return { ahead: rows.length, minutes: Math.ceil(minutes), running: false };
}
