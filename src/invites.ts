import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc, newToken, sha256 } from './lib.ts';
import { queueEmail, emailShell } from './mail.ts';
import { t, normLang } from './i18n.ts';
import { guestReviewScope } from './approval.ts';

/** Revoga convites anteriores e cria um novo; o email vai para a outbox (deduplicado por convite). */
export async function createInvitation(db: Db, interview: any, host: { name: string }, opts: { followup?: boolean; preview?: boolean } = {}) {
  const token = newToken(32);
  const days = config.limits.inviteDays;
  // O link vale até ao fim do último dia em qualquer fuso (UTC−12), e é esse dia que o email mostra.
  // O prazo da recolha não se aplica ao link de validação do episódio.
  const ymd = (v: any) => (typeof v === 'string' ? v : v instanceof Date
    ? (v.getUTCHours() === 0 && v.getUTCMinutes() === 0 ? v.toISOString() : `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`) : '').slice(0, 10);
  const endOfDay = (day: string) => new Date(`${day}T23:59:59Z`).getTime() + 12 * 3600_000;
  let lastDay = new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);
  if (interview.deadline && !opts.preview) { const dl = ymd(interview.deadline); if (/^\d{4}-\d{2}-\d{2}$/.test(dl) && dl >= new Date().toISOString().slice(0, 10)) lastDay = dl; }
  const exp = new Date(endOfDay(lastDay));
  const inv = await db.tx(async tx => {
    await tx.query(`UPDATE invitations SET revoked_at=now() WHERE interview_id=$1 AND revoked_at IS NULL`, [interview.id]);
    return tx.one(`INSERT INTO invitations(interview_id, token_hash, question_version, expires_at, purpose) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [interview.id, sha256(token), interview.version, exp, opts.preview ? 'preview' : opts.followup ? 'followup' : 'invite']);
  });
  const nQ = Number((await db.one('SELECT count(*)::int AS n FROM questions WHERE interview_id=$1', [interview.id]))?.n);
  const lang = normLang(interview.interaction_lang);
  const d = t(lang);
  const url = `${config.baseUrl}/i/${token}`;
  const hostName = interview.host_name || (await db.one('SELECT name FROM users WHERE id=$1', [interview.owner_id ?? null]))?.name || host.name;
  // Rodapé dos emails ao convidado: marca, frase e endereço do portal; contacto de apoio no corpo.
  const site = new URL(config.baseUrl).host;
  const footer = `<p style="font:13px Arial,sans-serif;color:#6b655c;margin-top:32px">${esc(config.brand)} — ${esc(d.tagline)} · <a href="${esc(config.baseUrl)}" style="color:#b4691f">${esc(site)}</a></p>`;
  const footerText = `${config.brand} — ${d.tagline} · ${site}`;
  const help = `${d.help} ${config.supportEmail}`;
  const small = (s: string) => `<p style="font-size:14px;color:#6b655c">${esc(s)}</p>`;
  if (opts.preview) {
    // Validação do episódio: email próprio (sem número de perguntas, sem «responder no telemóvel», sem recusa).
    // O texto segue o alcance da aprovação do convidado no episódio atual (a mesma regra da publicação).
    const scope = await guestReviewScope(db, interview);
    const steps = scope === 'video' ? d.reviewStepsVideo : scope === 'none' ? d.reviewStepsView : d.reviewSteps;
    const body = `<p>${esc(d.reviewIntro(hostName))}</p><p><strong>${esc(interview.title)}</strong></p><p>${esc(steps)}</p>`;
    const text = [d.reviewTitle, d.reviewIntro(hostName), interview.title, steps, `${d.reviewOpen}: ${url}`, help, footerText].join('\n\n');
    await queueEmail(db, { key: `invite:${inv.id}`, interviewId: interview.id, to: interview.guest_email, subject: d.reviewSubject(interview.title), html: emailShell(d.reviewTitle, body, { label: d.reviewOpen, url }, { footer, after: small(help) }), text });
    return { invitationId: inv.id, url, expires: exp };
  }
  // Convite: quem convida e sobre quê, a mensagem pessoal, como funciona o portal (para quem não o conhece) e até quando vale o link.
  const followup = !!opts.followup;
  // Perguntas adicionais: quantas estão por responder (singular ou plural no texto).
  // (só as perguntas adicionais ainda por responder; sem nenhuma, o texto fica no plural genérico)
  const nOpen = followup ? Number((await db.one(`SELECT count(*)::int AS n FROM questions q WHERE q.interview_id=$1 AND q.followup
    AND NOT EXISTS (SELECT 1 FROM answers a WHERE a.question_id=q.id AND a.status IN ('answered','refused'))`, [interview.id]))?.n ?? 0) || 2 : 0;
  const heading = followup ? d.followupHeading(nOpen) : d.inviteHeading;
  const lead = `${followup ? d.followupLead(hostName, nOpen) : d.inviteLead(hostName)} `;
  const end = /[.?!…]$/.test(String(interview.title).trim()) ? '' : '.'; // sem «?.» quando o título já termina em pontuação
  const steps = followup ? [] : [d.howAnswer(nQ), d.howListen, interview.review_policy === 'host_only' ? d.howConsent : d.howApprove];
  const until = d.linkUntil(new Date(`${lastDay}T12:00:00Z`).toLocaleDateString(lang === 'en' ? 'en-GB' : 'pt-PT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }));
  const pm = String(interview.personal_message ?? '').trim();
  const body = `<p>${esc(lead)}<strong>${esc(interview.title)}</strong>${end}</p>${pm ? `<blockquote style="border-left:3px solid #b4691f;margin:16px 0;padding:4px 16px;color:#4a443b">${esc(pm).replace(/\r?\n/g, '<br>')}</blockquote>` : ''}
${steps.length ? `<p style="margin:18px 0 6px"><strong>${esc(d.howTitle(config.brand))}</strong></p><ul style="padding-left:20px;margin:0 0 16px">${steps.map(s => `<li style="margin:4px 0">${esc(s)}</li>`).join('')}</ul>` : ''}
<p>${esc(until)}</p>`;
  const quote = (s: string) => (lang === 'en' ? `“${s}”` : `«${s}»`);
  const text = [heading, `${lead}${interview.title}${end}`, pm ? quote(pm) : '', steps.length ? `${d.howTitle(config.brand)}\n${steps.map(s => `• ${s}`).join('\n')}` : '',
    until, `${d.open}: ${url}`, followup ? help : `${d.emailDecline}\n${help}`, footerText].filter(Boolean).join('\n\n');
  await queueEmail(db, {
    key: `invite:${inv.id}`, interviewId: interview.id, to: interview.guest_email,
    subject: followup ? d.followupSubject(hostName, interview.title, nOpen) : d.emailSubject(hostName, interview.title),
    html: emailShell(heading, body, { label: d.open, url }, { footer, after: small(followup ? help : `${d.emailDecline} ${help}`) }), text,
  });
  return { invitationId: inv.id, url, expires: exp };
}
