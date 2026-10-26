import type { Db } from './db.ts';
import { config } from './config.ts';
import { storage } from './storage.ts';
import { videoGuestPhoto, usablePhotoSql } from './guest-photos.ts';
import { lipsyncMock } from './lipsync.ts';
import { inEntity, S } from './settings.ts';
import { settle, cr } from './wallet.ts';
import { PermanentError } from './jobs.ts';
import { queueEmail, emailShell } from './mail.ts';
import { esc, sha256 } from './lib.ts';

/**
 * Vídeo premium (animação de cada fala a partir da fotografia, com a voz do episódio), vendido por créditos.
 * O cliente nunca vê o nome da tecnologia; o fornecedor fica nomeado onde a lei o exige (/privacy e autorizações).
 * Tarifa = custo de produção por minuto × 2 (ver migrations/038_premium.sql).
 */
export const PREMIUM_ENGINE = 'heygen';
/** Avisos da animação premium (sem nomes de fornecedores). */
export const PREMIUM_ONLY_PREVIEW = 'O vídeo premium só se gera para um episódio em pré-visualização (antes da primeira publicação), para ser visto e aprovado. Para uma nova versão, regenere o guião ou recomece a produção.';
export const PREMIUM_SCRIPT_REPLACED = 'O guião aprovado deste episódio foi substituído: gere o episódio de novo antes do vídeo premium.';
export const PREMIUM_CHANGES = 'O entrevistado pediu alterações a este episódio: corrija e gere o episódio de novo antes do vídeo premium.';
export const PREMIUM_UNAVAILABLE = 'O vídeo premium não está disponível de momento.';
export const PREMIUM_CLOSED = 'O orçamento já não está em curso (anulado, cancelado ou liquidado): nada mais foi pedido ao fornecedor.';

const consent = async (db: Db, id: string, p: string) => !!(await db.one(`SELECT granted FROM consents WHERE interview_id=$1 AND purpose=$2 ORDER BY created_at DESC LIMIT 1`, [id, p]))?.granted;

/** Quem pode ser animado (autorizações, sem carregar fotografias): as mesmas regras do trabalho do vídeo. */
export async function premiumAllowed(db: Db, iv: any) {
  return {
    // Só autorizações dadas com o texto que nomeia o fornecedor da animação premium.
    host: !!(iv.host_ai_video && iv.host_ai_video_provider === 'heygen' && iv.host_photo_rights && iv.host_photo_asset_id),
    guest: !!(await db.one(`SELECT 1 FROM (SELECT granted, text_snapshot FROM consents WHERE interview_id=$1 AND purpose='ai_video' ORDER BY created_at DESC LIMIT 1) c WHERE c.granted AND c.text_snapshot ILIKE '%HeyGen%'`, [iv.id]))
      && (await consent(db, iv.id, 'publish_photo'))
      && !!(await db.one(`SELECT 1 FROM photos p WHERE p.interview_id=$1 AND ${usablePhotoSql('p')} LIMIT 1`, [iv.id])),
  };
}

/** Fotografias autorizadas do vídeo (as mesmas do trabalho): a do entrevistador com direitos; a do convidado com publicação. */
export async function videoPhotos(db: Db, iv: any, ep: any, photoId?: string | null) {
  const asset = async (id: string | null) => { if (!id) return null; const a = await db.one('SELECT storage_key FROM assets WHERE id=$1 AND deleted_at IS NULL', [id]); return a ? storage.get(a.storage_key) : null; };
  const host = iv.host_photo_rights ? await asset(iv.host_photo_asset_id) : null;
  let guest: Buffer | null = null, guestByHost = false;
  if (await consent(db, iv.id, 'publish_photo')) {
    const ph = await videoGuestPhoto(db, iv, { pid: photoId ?? undefined, coverIds: ep.technical?.coverPhotoIds });
    guest = ph ? await asset(ph.asset_id) : null;
    guestByHost = !!guest && ph!.added_by === 'host';
  }
  return { host, guest, guestByHost };
}

/** Chave de um clipe animado (mesma fotografia, mesmo áudio, mesma fala): um clipe igual nunca se paga duas vezes. */
export const clipTag = (heygen: boolean) => (lipsyncMock() ? 'mock' : heygen ? 'heygen' : 'replicate');
export const clipKeyOf = (photoSha: string, audioId: string, sg: { startMs: number; durationMs: number }, tag: string) => sha256(`${photoSha}|${audioId}|${sg.startMs}|${sg.durationMs}|${tag}`);

/** Chaves dos clipes de cada fala do episódio (para o orçamento: falas já animadas passam a 0 créditos). */
export async function premiumKeys(db: Db, iv: any, ep: any) {
  const ph = await videoPhotos(db, iv, ep);
  const sha = { host: ph.host ? sha256(ph.host) : null, guest: ph.guest ? sha256(ph.guest) : null };
  const tag = clipTag(true);
  const keyOf = (t: any) => { const s = t.role === 'host' ? sha.host : sha.guest; return s ? clipKeyOf(s, ep.audio_asset_id, t, tag) : null; };
  return { sha, keyOf, hash: sha256(JSON.stringify([ep.script_id, ep.audio_asset_id, sha.host, sha.guest])) };
}

/** Falta alguma coisa do lado do portal para gerar o vídeo premium? (chave do fornecedor, nas Definições globais) */
export const premiumConfigured = () => config.openai.mock || !!inEntity(null, () => S('HEYGEN_API_KEY'));

/**
 * Liquidação do vídeo premium, na transação que liga o vídeo ao episódio: cobra só as falas que saíram animadas (nunca
 * mais do que o orçamento), uma vez por clipe, e liberta o resto do cativo.
 */
export async function settlePremiumQuote(t: Db, quoteId: string, animated: Map<string, string>) {
  const q = await t.one('SELECT * FROM animation_quotes WHERE id=$1 FOR UPDATE', [quoteId]);
  if (q?.status !== 'running') throw new PermanentError(PREMIUM_CLOSED);
  let charged = 0, n = 0;
  const report: any[] = [];
  for (const it of q.selection as any[]) {
    const key = animated.get(it.segmentId);
    const row = { segmentId: it.segmentId, role: it.role, sec: it.sec, cents: 0, status: 'photo', reason: null as string | null };
    if (key) {
      n++;
      if (it.reused || !(it.cents > 0)) row.status = it.reused ? 'reused' : 'included';
      else {
        const ins = await t.one(`INSERT INTO animation_charges(interview_id, reuse_key, take, quote_id, segment_id, role, cents, chunks) VALUES ($1,$2,1,$3,$4,$5,$6,'[]')
          ON CONFLICT (interview_id, reuse_key, take) DO NOTHING RETURNING id`, [q.interview_id, key, q.id, it.segmentId, it.role, it.cents]);
        if (ins) { charged += it.cents; row.cents = it.cents; row.status = 'charged'; } else row.status = 'reused';
      }
    } else row.reason = 'premium_failed';
    report.push(row);
  }
  const captured = Math.min(charged, q.price_cents);
  let released = q.price_cents - captured;
  if (q.price_cents > 0) {
    const s = await settle(t, `quote:${q.id}`, captured, `vídeo premium: ${n} de ${q.selection.length} falas animadas`);
    if (!s) throw new Error('Orçamento sem cativação por liquidar');
    released = s.released;
  }
  await t.query(`UPDATE animation_quotes SET status='settled', charged_cents=$2, released_cents=$3, spent_usd=$4, settlement=$5, settled_at=now(), status_note=NULL, updated_at=now() WHERE id=$1`,
    [q.id, captured, released, 0, JSON.stringify({ segments: report })]);
  return { charged: captured, released, owner: q.owner_id };
}

/** Passa o orçamento a «em curso» (ou retoma-o); recusa um orçamento já fechado, fora da validade ou de tarifa desativada. */
export async function startPremiumQuote(db: Db, quoteId: string, interviewId: string) {
  return db.tx(async t => {
    const q = await t.one('SELECT * FROM animation_quotes WHERE id=$1 AND interview_id=$2 FOR UPDATE', [quoteId, interviewId]);
    if (!q || !['accepted', 'running'].includes(q.status)) throw new PermanentError(PREMIUM_CLOSED);
    if (new Date(q.valid_until).getTime() < Date.now()) throw new PermanentError('O orçamento passou a validade antes de a produção começar: os créditos cativos voltam ao saldo.');
    const rate = await t.one('SELECT active FROM animation_rates WHERE id=$1', [q.rate_id]);
    if (!rate?.active) throw new PermanentError(PREMIUM_UNAVAILABLE);
    return t.one(`UPDATE animation_quotes SET status='running', started_at=COALESCE(started_at, now()), status_note=NULL, updated_at=now() WHERE id=$1 RETURNING *`, [q.id]);
  });
}

/** Email com o resultado do vídeo premium: cobrado, libertado e o relatório por fala na página do orçamento. */
export async function premiumSettledEmail(db: Db, quote: any, s: { charged: number; released: number; owner: string }, iv: any) {
  const u = await db.one('SELECT email FROM users WHERE id=$1', [s.owner]);
  if (!u) return;
  const url = `${config.baseUrl}/entrevistas/${iv.id}/orcamentos/${quote.id}`;
  const text = `O vídeo premium de «${iv.title}» está pronto. Cobrados: ${cr(s.charged)} créditos (só as falas animadas). Libertados e de volta ao saldo: ${cr(s.released)} créditos. Veja o vídeo e aprove-o na página da produção; o relatório por fala está em ${url}`;
  await queueEmail(db, { key: `quote-settled:${quote.id}`, interviewId: iv.id, to: u.email, subject: `Vídeo premium pronto: ${cr(s.charged)} créditos cobrados`, text,
    html: emailShell('Vídeo premium pronto', `<p>${esc(text.replace(url, ''))}</p>`, { label: 'Ver o relatório', url }) });
}
