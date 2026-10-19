import type { Db } from './db.ts';
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

export async function runOne(db: Db, handlers: Record<string, Handler>): Promise<boolean> {
  // Recupera trabalhos presos (worker morreu a meio): volta à fila apenas se ainda tiver tentativas.
  await db.query(`UPDATE jobs SET state='queued', locked_at=NULL WHERE state='running' AND locked_at < now() - interval '15 minutes' AND attempts < max_attempts`);
  const job = await db.one(
    `UPDATE jobs SET state='running', attempts=attempts+1, locked_at=now(), started_at=COALESCE(started_at, now())
     WHERE id = (SELECT id FROM jobs WHERE state='queued' AND run_after <= now() ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`);
  if (!job) return false;
  const h = handlers[job.kind];
  try {
    if (!h) throw new PermanentError(`Sem handler para ${job.kind}`);
    const ent = job.interview_id ? await entityOfInterview(db, job.interview_id) : null;
    const result = await inEntity(ent, () => h(job, { db, progress: async (done, total, label) => { await db.query('UPDATE jobs SET progress_done=$2, progress_total=COALESCE($3, progress_total), progress_label=COALESCE($4, progress_label) WHERE id=$1', [job.id, done, total ?? null, label ?? null]); } }));
    await db.query(`UPDATE jobs SET state='done', result=$2, finished_at=now(), error=NULL WHERE id=$1`, [job.id, JSON.stringify(result ?? {})]);
  } catch (err: any) {
    const permanent = err instanceof PermanentError || job.attempts >= job.max_attempts;
    const backoffSec = 30 * 2 ** (job.attempts - 1);
    await db.query(
      `UPDATE jobs SET state=$2, error=$3, finished_at=CASE WHEN $2='failed' THEN now() END, run_after=now() + ($4 || ' seconds')::interval, locked_at=NULL WHERE id=$1`,
      [job.id, permanent ? 'failed' : 'queued', String(err?.message ?? err).slice(0, 800), String(backoffSec)]);
    if (permanent && handlers['__onFail']) await handlers['__onFail'](job, { db, progress: async () => {} });
  }
  return true;
}
