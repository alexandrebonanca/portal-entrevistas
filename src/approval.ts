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

/**
 * Capa feita com fotografias do convidado cuja autorização da capa (`cover_use`) foi retirada depois (RGPD, art. 7.º,
 * n.º 3): essa versão não se publica (publishBlock) e, publicada, a capa, a miniatura e o vídeo (que mostra a capa no
 * aviso inicial e no agradecimento) deixam de ser servidos e de aparecer na página e na galeria, até o convidado voltar a
 * autorizar. `technical.coverPhotos` são as fotografias que entraram de facto na capa; nos episódios anteriores a esse
 * campo conta, por prudência, a escolha do entrevistador (`coverPhotoIds`) se a autorização chegou a ser dada.
 * Expressão SQL sobre o episódio com o alias `e`.
 */
export const coverWithdrawnSql = (e = 'e') => `((CASE
    WHEN jsonb_typeof(${e}.technical->'coverPhotos') = 'array' THEN jsonb_array_length(${e}.technical->'coverPhotos') > 0
    WHEN jsonb_typeof(${e}.technical->'coverPhotoIds') = 'array' THEN jsonb_array_length(${e}.technical->'coverPhotoIds') > 0
      AND EXISTS (SELECT 1 FROM consents c WHERE c.interview_id=${e}.interview_id AND c.purpose='cover_use' AND c.granted)
    ELSE false END)
  AND NOT COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=${e}.interview_id AND c.purpose='cover_use' ORDER BY c.created_at DESC LIMIT 1), false))`;

/** A capa deste episódio tem fotografias do convidado e a autorização da capa foi retirada (ver coverWithdrawnSql). */
export const coverWithdrawn = async (db: Db, episodeId: string) =>
  !!(await db.one(`SELECT ${coverWithdrawnSql('e')} AS w FROM episodes e WHERE e.id=$1`, [episodeId]))?.w;

/** O que o convidado veria agora: alcance da aprovação e se o episódio já foi publicado. */
export interface GuestReview { scope: ApprovalScope; published: boolean }

/** Episódio que o convidado veria agora (o mais recente, atual), ou null sem episódio. */
export async function guestReview(db: Db, iv: { id: string; review_policy?: string }): Promise<GuestReview | null> {
  const ep = await db.one(`SELECT status, video_asset_id FROM episodes WHERE interview_id=$1 AND status IN ('preview','published') AND stale=false ORDER BY created_at DESC LIMIT 1`, [iv.id]);
  return ep ? { scope: approvalScope(iv, await videoMeta(db, ep.video_asset_id)), published: ep.status === 'published' } : null;
}

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
