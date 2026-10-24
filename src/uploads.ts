import type { Db } from './db.ts';
import { config } from './config.ts';
import { storage } from './storage.ts';
import { unpaidAccount } from './free-interview.ts';

/**
 * Espaço ocupado pelos ficheiros que as pessoas enviam (não pelos que o portal gera, que já têm os totais dos trabalhos):
 * respostas do convidado (áudio e texto), fotografias do convidado e do entrevistador, e gravações do entrevistador
 * (perguntas e objetivo). Conta só o que está guardado (deleted_at IS NULL): uma resposta, uma gravação ou uma fotografia
 * substituída sai do disco (discardAsset) e deixa de contar.
 *
 * Dois tetos (MB, variáveis do Render; 0 desliga):
 *  - por entrevista (INTERVIEW_UPLOAD_MB), para todas as contas: cobre o pior caso legítimo (15 min de respostas em WAV,
 *    3 fotografias do convidado e a do entrevistador no máximo do envio, e as gravações do entrevistador) com folga;
 *  - por conta sem pagamento (UNPAID_ACCOUNT_UPLOAD_MB), a soma de todas as entrevistas dela: a 1.ª entrevista grátis e
 *    os rascunhos. As contas pagas, de entidade, os gestores e o administrador não têm este teto.
 * O administrador não tem nenhum dos dois (nem nos envios que faz na entrevista de outra pessoa).
 */
export const UPLOAD_KINDS = ['answer_audio', 'answer_text', 'guest_photo', 'host_photo', 'objective_audio', 'question_audio'] as const;
const KINDS_SQL = `kind IN (${UPLOAD_KINDS.map(k => `'${k}'`).join(',')})`;
const UPLOAD_LOCK = 7710400;
const MB = 1024 * 1024;

export interface UploadRefusal { scope: 'interview' | 'account'; limitMb: number; usedMb: number }

const toMb = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

/**
 * Há espaço para um envio de `bytes` nesta entrevista? `except`: ficheiros que o envio vai substituir (não contam).
 * `stored`: o ficheiro novo já está guardado (conta já na soma; `bytes` deve ser 0). Sem bloqueios: serve para recusar
 * cedo, antes de escrever no disco. A decisão definitiva é a de `reserveUploadRoom`, numa transação.
 */
export async function uploadRoom(q: Db, interviewId: string, bytes: number, o: { except?: (string | null | undefined)[]; admin?: boolean } = {}): Promise<UploadRefusal | null> {
  if (o.admin) return null;
  const lim = config.limits;
  if (!lim.interviewUploadMb && !lim.unpaidAccountUploadMb) return null;
  const except = (o.except ?? []).filter((x): x is string => !!x);
  const iv = await q.one(`SELECT i.id, i.owner_id, u.role, u.entity_id FROM interviews i JOIN users u ON u.id=i.owner_id WHERE i.id=$1`, [interviewId]);
  if (!iv) return null;
  if (lim.interviewUploadMb) {
    const used = Number((await q.one(`SELECT COALESCE(sum(size),0)::bigint AS b FROM assets WHERE interview_id=$1 AND deleted_at IS NULL AND ${KINDS_SQL} AND NOT (id = ANY($2::uuid[]))`, [interviewId, except]))?.b ?? 0);
    if (used + bytes > lim.interviewUploadMb * MB) return { scope: 'interview', limitMb: lim.interviewUploadMb, usedMb: toMb(used) };
  }
  if (lim.unpaidAccountUploadMb && await unpaidAccount(q, { id: iv.owner_id, role: iv.role, entity_id: iv.entity_id })) {
    const used = Number((await q.one(`SELECT COALESCE(sum(a.size),0)::bigint AS b FROM assets a JOIN interviews i ON i.id=a.interview_id
      WHERE i.owner_id=$1 AND a.deleted_at IS NULL AND a.${KINDS_SQL} AND NOT (a.id = ANY($2::uuid[]))`, [iv.owner_id, except]))?.b ?? 0);
    if (used + bytes > lim.unpaidAccountUploadMb * MB) return { scope: 'account', limitMb: lim.unpaidAccountUploadMb, usedMb: toMb(used) };
  }
  return null;
}

/**
 * Decisão definitiva, dentro de uma transação, com o ficheiro novo já guardado (conta na soma): bloqueia o dono da
 * entrevista (bloqueio consultivo por conta, sempre depois do FOR UPDATE da entrevista quando o há), para que envios em
 * simultâneo, na mesma entrevista ou noutras da mesma conta, não passem o teto juntos (no pior caso, um deles é recusado
 * sem necessidade e pode ser repetido).
 */
export async function reserveUploadRoom(tx: Db, interviewId: string, o: { except?: (string | null | undefined)[]; admin?: boolean } = {}): Promise<UploadRefusal | null> {
  if (o.admin || (!config.limits.interviewUploadMb && !config.limits.unpaidAccountUploadMb)) return null;
  const iv = await tx.one('SELECT owner_id FROM interviews WHERE id=$1', [interviewId]);
  if (!iv) return null;
  await tx.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [UPLOAD_LOCK, iv.owner_id]);
  return uploadRoom(tx, interviewId, 0, o);
}

/** Texto da recusa, para o entrevistador (português) ou para o convidado (na língua dele). */
export function uploadRefusalText(r: UploadRefusal, who: 'host' | 'guest-pt' | 'guest-en'): string {
  if (who === 'guest-en') return `This interview has reached its storage limit for files (${r.limitMb} MB). Replace or remove an earlier answer or photo, or contact the person who invited you.`;
  if (who === 'guest-pt') return `Esta entrevista atingiu o limite de espaço para ficheiros (${r.limitMb} MB). Substitua ou retire uma resposta ou fotografia anterior, ou contacte quem o convidou.`;
  return r.scope === 'interview'
    ? `Esta entrevista atingiu o limite de ${r.limitMb} MB de ficheiros enviados (gravações, respostas e fotografias; ocupados ${r.usedMb} MB). Uma gravação ou fotografia substituída deixa de contar. Use ficheiros mais pequenos (por exemplo, MP3 em vez de WAV) ou peça ajuda à equipa do portal.`
    : `As entrevistas desta conta sem subscrição atingiram o limite de ${r.limitMb} MB de ficheiros enviados (ocupados ${r.usedMb} MB). Elimine rascunhos que já não usa, use ficheiros mais pequenos ou, com uma subscrição (Conta), deixa de haver este limite por conta.`;
}

/**
 * Tira do disco um ficheiro que deixou de ser usado (marca deleted_at e o motivo em meta.erased). Só os ativos ainda
 * guardados; uma falha a apagar o ficheiro fica no registo e não interrompe o pedido (a linha já não o serve nem conta).
 */
export async function discardAsset(db: Db, assetId: string | null | undefined, reason: string): Promise<boolean> {
  if (!assetId) return false;
  const a = await db.one(`UPDATE assets SET deleted_at=now(), meta=meta || jsonb_build_object('erased', $2::text) WHERE id=$1 AND deleted_at IS NULL RETURNING storage_key`, [assetId, reason]);
  if (!a) return false;
  try { await storage.remove(a.storage_key); } catch (e: any) { console.error(`[armazenamento] ficheiro ${assetId} por apagar: ${String(e?.message ?? e).slice(0, 200)}`); }
  return true;
}

/**
 * Resposta do convidado substituída (nova gravação ou ficheiro na mesma pergunta) ou recusada: o take anterior sai do
 * disco, com o texto de uma resposta escrita, se nunca fez parte de uma submissão (as respostas submetidas são o
 * original do que o convidado entregou e ficam). Devolve se apagou.
 */
export async function discardReplacedTake(db: Db, interviewId: string, takeId: string | null | undefined): Promise<boolean> {
  if (!takeId) return false;
  const t = await db.one(`SELECT t.id, t.asset_id FROM answer_takes t JOIN answers an ON an.id=t.answer_id
    WHERE t.id=$1 AND an.interview_id=$2 AND (an.selected_take_id IS NULL OR an.selected_take_id<>t.id)`, [takeId, interviewId]);
  if (!t) return false;
  const submitted = await db.one(`SELECT 1 FROM submissions WHERE interview_id=$1 AND snapshot->'answers' @> jsonb_build_array(jsonb_build_object('assetId', $2::text)) LIMIT 1`, [interviewId, t.asset_id]);
  if (submitted) return false;
  // Uma resposta escrita guarda o texto também como transcrição (origem «document»); a transcrição de áudio só se faz
  // depois da submissão, por isso um take nunca submetido não tem outras.
  await db.query(`DELETE FROM transcripts WHERE interview_id=$1 AND source_kind='answer_take' AND source_id=$2`, [interviewId, t.id]);
  return discardAsset(db, t.asset_id, 'replaced');
}

/**
 * Gravação do entrevistador (pergunta ou objetivo) substituída ou com a pergunta eliminada: sai do disco se nenhuma
 * pergunta nem entrevista a usar. Uma transcrição ainda na fila para ela termina sem nada fazer (transcribe_asset).
 */
export async function discardHostRecording(db: Db, assetId: string | null | undefined): Promise<boolean> {
  if (!assetId) return false;
  const used = await db.one(`SELECT 1 FROM questions WHERE audio_asset_id=$1 UNION ALL SELECT 1 FROM interviews WHERE objective_asset_id=$1 LIMIT 1`, [assetId]);
  if (used) return false;
  const a = await db.one(`SELECT 1 FROM assets WHERE id=$1 AND kind IN ('question_audio','objective_audio')`, [assetId]);
  if (!a) return false;
  return discardAsset(db, assetId, 'replaced');
}

/** Vídeo só com fotografias (sem Veo e sem retratos animados): refaz-se no servidor sem IA nem custo por fala. */
const PHOTO_VIDEO_SQL = `a.kind='episode_video' AND a.meta->>'engine' IS NULL AND COALESCE(a.meta->>'animatedSegments','0') IN ('0','')`;

/**
 * Vídeos com fotografias que deixaram de servir antes de irem para o ar: substituídos por um vídeo novo no episódio em
 * pré-visualização ou de um episódio substituído (versão nova ou «Recomeçar») que nunca foi publicado. Ficam os ligados a
 * um episódio atual, a um que já esteve publicado (retirado incluído) e os que nunca chegaram a ser ligados (geração cuja
 * ligação foi recusada, guardados em privado). Os vídeos com o Google Veo ou com retratos animados (pagos por fala) ficam
 * sempre. `only`: limita a um vídeo (o que acabou de ser substituído). Devolve quantos saíram.
 */
export async function purgeUnpublishedPhotoVideos(db: Db, interviewId: string, only?: string | null): Promise<number> {
  const rows = await db.query(`SELECT a.id FROM assets a WHERE a.interview_id=$1 AND a.deleted_at IS NULL AND ${PHOTO_VIDEO_SQL}
      AND ($2::uuid IS NULL OR a.id=$2::uuid)
      AND (EXISTS (SELECT 1 FROM episodes e WHERE e.video_asset_id=a.id) OR a.id=$2::uuid)
      AND NOT EXISTS (SELECT 1 FROM episodes e WHERE e.video_asset_id=a.id AND (e.status<>'superseded' OR e.published_at IS NOT NULL))`, [interviewId, only ?? null]);
  let n = 0;
  for (const r of rows) {
    if (await discardAsset(db, r.id, 'replaced_unpublished')) {
      await db.query(`UPDATE episodes SET video_asset_id=NULL WHERE video_asset_id=$1 AND status='superseded' AND published_at IS NULL`, [r.id]);
      n++;
    }
  }
  return n;
}
