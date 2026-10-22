import { config } from './config.ts';
import { emailBrand } from './brand.ts';
import type { Db } from './db.ts';
import { esc, isRealEmail } from './lib.ts';
import { S, inEntity, entityOfInterview } from './settings.ts';

/** Coloca o email na outbox (deduplicado por chave). O envio real é feito por flushOutbox(). */
export async function queueEmail(db: Db, e: { key: string; interviewId?: string; to: string; subject: string; html: string; text: string }) {
  await db.query(
    `INSERT INTO emails(dedupe_key, interview_id, to_email, subject, html, text_body) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (dedupe_key) DO NOTHING`,
    [e.key, e.interviewId ?? null, e.to, e.subject, e.html, e.text]);
}

let lastWarn = 0;
export async function flushOutbox(db: Db) {
  // Em produção sem fornecedor configurado as mensagens ficam pendentes (não se fingem enviadas).
  if (config.production && !S('MAILERSEND_API_KEY')) {
    if (Date.now() - lastWarn > 300_000) { lastWarn = Date.now(); console.warn('[mail] MAILERSEND_API_KEY não configurada: emails pendentes na outbox'); }
    return;
  }
  // Os emails do formulário público de contacto (chaves contact:… e contact-reply:…; não confundir com contract:…, o
  // contrato da subscrição) vão depois dos outros: uma leva de pedidos de visitantes não atrasa convites nem recibos.
  const rows = await db.query(`SELECT * FROM emails WHERE state IN ('pending','failed') AND attempts < 6 AND next_attempt_at <= now()
    ORDER BY (starts_with(dedupe_key, 'contact:') OR starts_with(dedupe_key, 'contact-reply:')), created_at LIMIT 20`);
  for (const m of rows) {
    // Reserva a linha antes de enviar: dois processos não enviam a mesma mensagem.
    const claimed = await db.one(`UPDATE emails SET state='sending', attempts=attempts+1 WHERE id=$1 AND state IN ('pending','failed') AND attempts < 6 AND next_attempt_at <= now() RETURNING id`, [m.id]);
    if (!claimed) continue;
    try {
      // Com entrevista: chaves da entidade do dono; sem entrevista (ex.: teste): mantém o contexto atual.
      const id = m.interview_id ? await inEntity(await entityOfInterview(db, m.interview_id), () => deliver(m)) : await deliver(m);
      await db.query(`UPDATE emails SET state='sent', provider_id=$2, sent_at=now(), error=NULL WHERE id=$1`, [m.id, id]);
    } catch (err: any) {
      console.error(`[mail] falha ao enviar "${m.subject}" para ${m.to_email}: ${String(err?.message ?? err).slice(0, 300)}`);
      // Espera crescente entre tentativas (1, 2, 4, 8, 16 min) para não esgotar as tentativas em segundos.
      await db.query(`UPDATE emails SET state='failed', error=$2, next_attempt_at=now() + ($3 || ' minutes')::interval WHERE id=$1`, [m.id, String(err?.message ?? err).slice(0, 500), String(2 ** Math.max(0, m.attempts))]);
    }
  }
}

/**
 * Endereço de resposta: o email da entidade gestora (config.owner), se for um email real (não o de exemplo). Nunca o
 * SUPPORT_EMAIL, que é só configuração interna: as dúvidas seguem pela ajuda do portal ou pelo formulário de contacto.
 */
export const replyTo = () => (isRealEmail(config.owner.email) ? config.owner.email : '');

/**
 * Seguimento desligado em cada envio, seja qual for a configuração do domínio no painel da MailerSend: sem píxel de
 * aberturas, sem links reescritos para contar cliques e sem o conteúdo guardado na atividade (campos `settings` da API
 * v1, /v1/email). A /privacy diz que os emails não têm seguimento de aberturas nem de cliques.
 */
export const MAILERSEND_SETTINGS = { track_clicks: false, track_opens: false, track_content: false } as const;

async function deliver(m: any): Promise<string> {
  if (!S('MAILERSEND_API_KEY')) {
    // Sem fornecedor configurado: regista na consola (desenvolvimento). Não é entrega real.
    console.log(`[email:dev] para=${m.to_email} assunto="${m.subject}"\n${m.text_body}\n`);
    return 'console';
  }
  const res = await fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: { Authorization: `Bearer ${S('MAILERSEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: { email: S('MAIL_FROM') || config.mail.from, name: S('MAIL_FROM_NAME') || config.mail.fromName },
      // Respostas vão para o email da entidade gestora (o remetente é no-reply).
      ...(replyTo() ? { reply_to: { email: replyTo(), name: config.brand } } : {}),
      to: [{ email: m.to_email }],
      subject: m.subject, html: m.html, text: m.text_body,
      settings: MAILERSEND_SETTINGS,
    }),
  });
  if (!res.ok) throw new Error(`MailerSend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.headers.get('x-message-id') ?? 'accepted';
}

/** Ligação à página de privacidade no rodapé dos emails (o desta moldura e o dos convites, em invites.ts). */
export const emailPrivacyLink = (label: string) => `<a href="${esc(config.baseUrl)}/privacy" style="color:#b4691f">${esc(label)}</a>`;

/**
 * Rodapé por omissão dos emails: a marca, a ligação ao formulário de contacto do portal (nunca um endereço de email) e a
 * página de privacidade.
 */
export const emailFooter = (lang: 'pt' | 'en' = 'pt') =>
  `<p style="font:13px Arial,sans-serif;color:#6b655c;margin-top:32px">${esc(config.brand)} · <a href="${esc(config.baseUrl)}/contact" style="color:#b4691f">${lang === 'en' ? 'Contact us' : 'Contacto'}</a> · ${emailPrivacyLink(lang === 'en' ? 'Privacy' : 'Privacidade')}</p>`;

/**
 * Moldura dos emails. opts.after: texto secundário depois do botão; opts.footer: rodapé próprio (por omissão, a marca, o
 * formulário de contacto e a privacidade, na língua opts.lang).
 */
export function emailShell(title: string, bodyHtml: string, button?: { label: string; url: string }, opts: { footer?: string; after?: string; lang?: 'pt' | 'en' } = {}) {
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Georgia,serif;color:#1c1a17">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">${emailBrand()}
<h1 style="font-size:24px;line-height:1.25;margin:8px 0 18px">${esc(title)}</h1><div style="font-size:16px;line-height:1.6">${bodyHtml}</div>
${button ? `<p style="margin:28px 0"><a href="${esc(button.url)}" style="background:#1c1a17;color:#fff;text-decoration:none;padding:14px 22px;border-radius:6px;font:600 15px Arial,sans-serif;display:inline-block">${esc(button.label)}</a></p>` : ''}${opts.after ?? ''}
${opts.footer ?? emailFooter(opts.lang)}</div></body></html>`;
}

/** Depois de corrigir a configuração (chave, remetente), as mensagens falhadas voltam à fila. */
export async function retryFailedEmails(db: Db) {
  await db.query(`UPDATE emails SET state='pending', attempts=0, next_attempt_at=now() WHERE state='failed'`);
}
