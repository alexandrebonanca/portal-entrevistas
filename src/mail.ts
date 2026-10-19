import { config } from './config.ts';
import type { Db } from './db.ts';
import { esc } from './lib.ts';
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
  const rows = await db.query(`SELECT * FROM emails WHERE state IN ('pending','failed') AND attempts < 6 AND next_attempt_at <= now() ORDER BY created_at LIMIT 20`);
  for (const m of rows) {
    // Reserva a linha antes de enviar: dois processos não enviam a mesma mensagem.
    const claimed = await db.one(`UPDATE emails SET state='sending', attempts=attempts+1 WHERE id=$1 AND state IN ('pending','failed') RETURNING id`, [m.id]);
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
      to: [{ email: m.to_email }],
      subject: m.subject, html: m.html, text: m.text_body,
    }),
  });
  if (!res.ok) throw new Error(`MailerSend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.headers.get('x-message-id') ?? 'accepted';
}

export function emailShell(title: string, bodyHtml: string, button?: { label: string; url: string }) {
  return `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Georgia,serif;color:#1c1a17">
<div style="max-width:560px;margin:0 auto;padding:32px 20px"><p style="letter-spacing:.14em;text-transform:uppercase;font:600 12px Arial,sans-serif;color:#8a5a2b">${esc(config.brand)}</p>
<h1 style="font-size:24px;line-height:1.25;margin:8px 0 18px">${esc(title)}</h1><div style="font-size:16px;line-height:1.6">${bodyHtml}</div>
${button ? `<p style="margin:28px 0"><a href="${esc(button.url)}" style="background:#1c1a17;color:#fff;text-decoration:none;padding:14px 22px;border-radius:6px;font:600 15px Arial,sans-serif;display:inline-block">${esc(button.label)}</a></p>` : ''}
<p style="font:13px Arial,sans-serif;color:#6b655c;margin-top:32px">${esc(config.brand)} · ${esc(config.supportEmail)}</p></div></body></html>`;
}

/** Depois de corrigir a configuração (chave, remetente), as mensagens falhadas voltam à fila. */
export async function retryFailedEmails(db: Db) {
  await db.query(`UPDATE emails SET state='pending', attempts=0, next_attempt_at=now() WHERE state='failed'`);
}
