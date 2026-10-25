import type { Db } from './db.ts';

/**
 * Fotografias do convidado que podem ser usadas (capa, vídeo, Veo). As que o próprio convidado enviou seguem as
 * autorizações das fotografias. As que o entrevistador acrescentou (photos.added_by='host', por exemplo quando a Google
 * recusa animar a fotografia enviada) exigem ainda a autorização de edição dada ao aceitar o convite (host_edit) e a
 * política «o entrevistado aprova»: o convidado vê e aprova o episódio antes de qualquer publicação.
 * Condição SQL sobre a tabela photos com o alias `p`.
 */
export const usablePhotoSql = (p = 'p') => `(${p}.added_by<>'host' OR (
  EXISTS (SELECT 1 FROM interviews ui WHERE ui.id=${p}.interview_id AND ui.review_policy='guest_preview')
  AND COALESCE((SELECT c.granted FROM consents c WHERE c.interview_id=${p}.interview_id AND c.purpose='host_edit' ORDER BY c.created_at DESC LIMIT 1), false)))`;

/** O entrevistador pode acrescentar ou escolher uma fotografia do convidado nesta entrevista? (motivo da recusa, ou null) */
export async function hostPhotoBlock(db: Db, iv: { id: string; review_policy?: string; collection_status?: string }): Promise<string | null> {
  if (iv.collection_status !== 'submitted') return 'Só depois de o entrevistado submeter a entrevista.';
  if (iv.review_policy !== 'guest_preview') return 'Só com a política «o entrevistado vê e aprova a versão final»: uma fotografia escolhida por si tem de ser vista e aprovada por ele antes de publicar.';
  const ok = (await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose='host_edit' ORDER BY created_at DESC LIMIT 1`, [iv.id]))?.granted;
  if (!ok) return 'O entrevistado não deu (ou retirou) a autorização de edição. Os convites novos pedem-na ao aceitar; nesta entrevista, ele pode dá-la em «Autorizações das fotografias», a partir do link do convite ou da pré-visualização.';
  return null;
}

/**
 * Fotografia do convidado usada no vídeo: a pedida (`pid`), a escolhida pelo entrevistador (interviews.guest_photo_id), a
 * primeira da capa ou, sem nenhuma, a mais antiga. Só fotografias que podem ser usadas (usablePhotoSql); uma escolha que
 * deixou de poder ser usada passa à seguinte.
 */
export async function videoGuestPhoto(db: Db, iv: { id: string; guest_photo_id?: string | null }, o: { pid?: string | null; coverIds?: string[] } = {}): Promise<{ id: string; asset_id: string; added_by: string } | null> {
  for (const id of [o.pid, iv.guest_photo_id, o.coverIds?.[0]]) {
    if (!id) continue;
    const r = await db.one(`SELECT p.id, p.asset_id, p.added_by FROM photos p WHERE p.id=$1 AND p.interview_id=$2 AND ${usablePhotoSql('p')}`, [id, iv.id]);
    if (r) return r;
  }
  return db.one(`SELECT p.id, p.asset_id, p.added_by FROM photos p WHERE p.interview_id=$1 AND ${usablePhotoSql('p')} ORDER BY p.created_at LIMIT 1`, [iv.id]);
}
