import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc, newToken, sha256 } from './lib.ts';
import { queueEmail, emailShell } from './mail.ts';
import { t, normLang } from './i18n.ts';

/** Revoga convites anteriores e cria um novo; o email vai para a outbox (deduplicado por convite). */
export async function createInvitation(db: Db, interview: any, host: { name: string }, opts: { followup?: boolean; preview?: boolean } = {}) {
  const token = newToken(32);
  const days = config.limits.inviteDays;
  let exp = new Date(Date.now() + days * 86400_000);
  if (interview.deadline) { const d = new Date(interview.deadline); d.setHours(23, 59, 59); if (d > new Date()) exp = d; }
  const inv = await db.tx(async tx => {
    await tx.query(`UPDATE invitations SET revoked_at=now() WHERE interview_id=$1 AND revoked_at IS NULL`, [interview.id]);
    return tx.one(`INSERT INTO invitations(interview_id, token_hash, question_version, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
      [interview.id, sha256(token), interview.version, exp]);
  });
  const nQ = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [interview.id]))?.n);
  const lang = normLang(interview.interaction_lang);
  const d = t(lang);
  const url = `${config.baseUrl}/i/${token}`;
  const hostName = interview.host_name || host.name;
  const intro = opts.preview ? (lang === 'en' ? 'The episode made from your interview is ready for your review.' : 'O episódio feito a partir da sua entrevista está pronto para revisão.') : opts.followup ? (lang === 'en' ? 'There are additional questions for you.' : 'Há perguntas adicionais para si.') : d.invitedBy(hostName);
  const body = `<p>${esc(intro)}</p>${interview.personal_message ? `<blockquote style="border-left:3px solid #b4691f;margin:16px 0;padding:4px 16px;color:#4a443b">${esc(interview.personal_message)}</blockquote>` : ''}
<p><strong>${esc(interview.title)}</strong><br>${esc(d.qCount(nQ))}${interview.deadline ? `<br>${esc(d.deadline)}: ${esc(new Date(interview.deadline).toLocaleDateString(lang))}` : ''}</p><p>${esc(d.emailLine)}</p>
<p style="font-size:14px;color:#6b655c">${esc(d.emailDecline)} ${esc(config.supportEmail)}</p>`;
  const text = `${intro}\n\n${interview.title}\n${d.qCount(nQ)}\n\n${d.open}: ${url}\n\n${d.emailDecline}\n${config.supportEmail}`;
  await queueEmail(db, {
    key: `invite:${inv.id}`, interviewId: interview.id, to: interview.guest_email,
    subject: opts.preview ? (lang === 'en' ? `Please review your episode — ${interview.title}` : `Reveja o seu episódio — ${interview.title}`) : d.emailSubject(hostName, interview.title), html: emailShell(interview.title, body, { label: d.open, url }), text,
  });
  return { invitationId: inv.id, url, expires: exp };
}
