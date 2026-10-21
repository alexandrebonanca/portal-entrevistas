import type { Db } from './db.ts';
import { config } from './config.ts';

/** Tolerância no fim de uma gravação: o gravador pára no limite, mas o ficheiro pode ficar uns décimos acima. */
export const LIMIT_SLACK_MS = 2000;
/** Uma pergunta adicional só se envia se o convidado ainda tiver, pelo menos, este tempo de resposta. */
export const FOLLOWUP_MIN_LEFT_SEC = 30;

/** Limites a fixar na entrevista no convite: os do plano da subscrição que o autoriza; o administrador não tem limite. */
export function inviteLimits(quota: { unlimited: boolean; plan: any }): { answerLimitSec: number | null; questionLimit: number | null } {
  if (quota.unlimited) return { answerLimitSec: null, questionLimit: null };
  return {
    answerLimitSec: Number(quota.plan?.max_answer_total_sec ?? config.limits.maxAnswerTotalSec),
    questionLimit: Number(quota.plan?.max_questions ?? config.limits.maxQuestions),
  };
}

/** Máximo de perguntas no rascunho: o do plano (ou o geral, sem plano ou para o administrador). */
export const draftQuestionMax = (quota: { unlimited: boolean; plan: any }) =>
  quota.unlimited ? config.limits.maxQuestions : Number(quota.plan?.max_questions ?? config.limits.maxQuestions);

/** Duração (ms) das respostas escolhidas de todas as perguntas da entrevista, adicionais incluídas; opcionalmente sem a de uma pergunta. */
export async function answeredMs(db: Db, interviewId: string, exceptQuestionId: string | null = null): Promise<number> {
  const r = await db.one(`SELECT COALESCE(sum(ast.duration_ms),0)::bigint AS ms FROM answers an JOIN answer_takes t ON t.id=an.selected_take_id JOIN assets ast ON ast.id=t.asset_id
    WHERE an.interview_id=$1 AND an.status='answered' AND ($2::uuid IS NULL OR an.question_id<>$2::uuid)`, [interviewId, exceptQuestionId]);
  return Number(r?.ms ?? 0);
}

/** Segundos de resposta que ainda restam (null = sem limite). */
export const secondsLeft = (limitSec: number | null | undefined, usedMs: number): number | null =>
  limitSec == null ? null : Math.max(0, Math.floor((limitSec * 1000 - usedMs) / 1000));

export const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ---- regenerações do guião e do episódio ----
/** Regenerações já contadas na entrevista (trabalhos marcados como regeneração e que não falharam). */
export async function regenerationsUsed(db: Db, interviewId: string): Promise<number> {
  return Number((await db.one(`SELECT count(*)::int AS n FROM jobs WHERE interview_id=$1 AND kind IN ('process_submission','prepare_script','generate_episode')
    AND input->>'regen'='true' AND state<>'failed'`, [interviewId]))?.n ?? 0);
}

export const REGEN_BLOCKED = () => `Já usou as ${config.limits.includedRegenerations} regenerações incluídas nesta entrevista (guião e episódio). Cada regeneração seguinte custa 1 crédito.`;
