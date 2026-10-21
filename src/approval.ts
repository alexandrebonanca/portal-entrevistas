import type { Db } from './db.ts';
import { t, type Lang } from './i18n.ts';

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

/** O que o convidado veria agora: alcance da aprovação e se o episódio já foi publicado. */
export interface GuestReview { scope: ApprovalScope; published: boolean }

/** Episódio que o convidado veria agora (o mais recente, atual), ou null sem episódio. */
export async function guestReview(db: Db, iv: { id: string; review_policy?: string }): Promise<GuestReview | null> {
  const ep = await db.one(`SELECT status, video_asset_id FROM episodes WHERE interview_id=$1 AND status IN ('preview','published') AND stale=false ORDER BY created_at DESC LIMIT 1`, [iv.id]);
  return ep ? { scope: approvalScope(iv, await videoMeta(db, ep.video_asset_id)), published: ep.status === 'published' } : null;
}

/** Alcance da aprovação no episódio que o convidado veria agora, ou null sem episódio. */
export const guestReviewScope = async (db: Db, iv: { id: string; review_policy?: string }): Promise<ApprovalScope | null> => (await guestReview(db, iv))?.scope ?? null;

/** O convidado decide (aprova ou pede alterações) só num episódio por publicar em que a aprovação dele conta. */
export const guestDecides = (r: GuestReview | null | undefined) => !!r && r.scope !== 'none' && !r.published;

/**
 * Textos da validação (email, página do link e pré-visualização): «Confirme e valide» só quando o convidado decide;
 * senão «ver o episódio», com o motivo (a publicação é do entrevistador, já foi publicado ou não há episódio).
 */
export function reviewCopy(lang: Lang, r: GuestReview | null | undefined) {
  const d = t(lang);
  if (guestDecides(r)) return { title: d.reviewTitle, subject: d.reviewSubject, open: d.reviewOpen, steps: r!.scope === 'video' ? d.reviewStepsVideo : d.reviewSteps };
  return { title: d.viewTitle, subject: d.viewSubject, open: d.viewOpen, steps: !r ? d.nothingToView : r.published ? d.publishedSteps : d.reviewStepsView };
}
