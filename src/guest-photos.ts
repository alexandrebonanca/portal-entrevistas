import type { Db } from './db.ts';

/**
 * Fotografias do convidado que podem ser usadas (capa, vídeo, Veo). As que o próprio convidado enviou seguem as
 * autorizações das fotografias. As que o entrevistador acrescentou (photos.added_by='host', por exemplo quando a Google
 * recusa animar a fotografia enviada) exigem ainda a autorização de edição dada ao aceitar o convite (host_edit) e a
 * política «o entrevistado aprova»: o convidado vê e aprova o episódio antes de qualquer publicação.
 * Condição SQL sobre a tabela photos com o alias `p`.
 */
export const usablePhotoSql = (p = 'p') => `(${p}.added_by<>'host' OR COALESCE((SELECT c.granted AND (c.text_snapshot ILIKE '%fotografia%' OR c.text_snapshot ILIKE '%photo%')
  FROM consents c WHERE c.interview_id=${p}.interview_id AND c.purpose='host_edit' ORDER BY c.created_at DESC LIMIT 1), false))`;

/** O entrevistador pode acrescentar ou escolher uma fotografia do convidado nesta entrevista? (motivo da recusa, ou null) */
export async function hostPhotoBlock(db: Db, iv: { id: string; review_policy?: string; collection_status?: string }): Promise<string | null> {
  if (iv.collection_status !== 'submitted') return 'Só depois de o entrevistado submeter a entrevista.';
  // A autorização tem de cobrir a fotografia (o texto da política «só o entrevistador aprova» só passou a cobri-la na v6).
  const c = await db.one(`SELECT granted, text_snapshot FROM consents WHERE interview_id=$1 AND purpose='host_edit' ORDER BY created_at DESC LIMIT 1`, [iv.id]);
  const ok = !!c?.granted && /fotografia|photo/i.test(String(c.text_snapshot ?? ''));
  if (!ok) return 'O entrevistado não deu (ou retirou) a autorização de edição, ou deu-a num texto anterior que não incluía a fotografia. Os convites novos pedem-na ao aceitar; nesta entrevista, ele pode dá-la em «Autorizações das fotografias», a partir do link do convite ou da pré-visualização.';
  return null;
}

/**
 * Fotografia do convidado usada no vídeo: a pedida (`pid`), a escolhida pelo entrevistador (interviews.guest_photo_id), a
 * primeira da capa ou, sem nenhuma, a mais antiga. Só fotografias que podem ser usadas (usablePhotoSql); uma escolha que
 * deixou de poder ser usada passa à seguinte.
 */
export async function videoGuestPhoto(db: Db, iv: { id: string; guest_photo_id?: string | null }, o: { pid?: string | null; coverIds?: string[] } = {}): Promise<{ id: string; asset_id: string; added_by: string } | null> {
  for (const [k, id] of [o.pid, iv.guest_photo_id, o.coverIds?.[0]].entries()) {
    if (!id) continue;
    // A da capa só serve se a Google não a recusou (a pedida e a escolhida pelo entrevistador valem sempre).
    const r = await db.one(`SELECT p.id, p.asset_id, p.added_by FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.id=$1 AND p.interview_id=$2 AND ${usablePhotoSql('p')} AND ($3::boolean OR a.meta->>'veoRefused' IS NULL)`, [id, iv.id, k < 2]);
    if (r) return r;
  }
  // Sem escolha: a mais antiga que a Google não recusou (e, se todas foram recusadas, a mais antiga).
  return db.one(`SELECT p.id, p.asset_id, p.added_by FROM photos p JOIN assets a ON a.id=p.asset_id WHERE p.interview_id=$1 AND ${usablePhotoSql('p')} ORDER BY (a.meta->>'veoRefused' IS NOT NULL), p.created_at LIMIT 1`, [iv.id]);
}
