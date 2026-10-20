import type { Db } from './db.ts';

/** Quem aparece animado por IA (Google Veo ou animação por fala) tem de ver e aprovar o vídeo, seja qual for a política. */
export const guestMustApprove = (iv: { review_policy?: string }, vmeta: any) =>
  iv.review_policy === 'guest_preview' || !!vmeta?.guestAiVideo || !!vmeta?.guestAnimated;

/**
 * Alcance da aprovação do convidado: «all» com a política «o entrevistado aprova»; «video» quando só conta
 * por aparecer animado por IA no vídeo atual; «none» quando a publicação não depende dele.
 * É a mesma regra da publicação (guestMustApprove) e decide o texto e o formulário que o convidado vê.
 */
export type ApprovalScope = 'all' | 'video' | 'none';
export const approvalScope = (iv: { review_policy?: string }, vmeta: any): ApprovalScope =>
  iv.review_policy === 'guest_preview' ? 'all' : vmeta?.guestAiVideo || vmeta?.guestAnimated ? 'video' : 'none';

/** Meta do vídeo ligado ao episódio (null sem vídeo). */
export const videoMeta = async (db: Db, videoAssetId: string | null | undefined) =>
  videoAssetId ? (await db.one('SELECT meta FROM assets WHERE id=$1', [videoAssetId]))?.meta ?? null : null;

/** Alcance da aprovação no episódio que o convidado veria agora (o mais recente, atual), ou null sem episódio. */
export async function guestReviewScope(db: Db, iv: { id: string; review_policy?: string }): Promise<ApprovalScope | null> {
  const ep = await db.one(`SELECT video_asset_id FROM episodes WHERE interview_id=$1 AND status IN ('preview','published') AND stale=false ORDER BY created_at DESC LIMIT 1`, [iv.id]);
  return ep ? approvalScope(iv, await videoMeta(db, ep.video_asset_id)) : null;
}
