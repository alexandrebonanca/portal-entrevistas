import type { Db } from './db.ts';
import { config } from './config.ts';
import { esc } from './lib.ts';
import { queueEmail, emailShell } from './mail.ts';

/**
 * Aviso por email quando um trabalho longo termina (o vídeo pode levar dezenas de minutos e a página diz que se pode
 * fechar): episódio gerado, vídeo pronto e vídeo que falhou de vez. Vai para quem pediu (input.requestedBy) ou, sem ele,
 * para o titular da entrevista; uma vez por trabalho (dedupe pelo id). O vídeo de um orçamento já tem o email da
 * liquidação (veo-episode.ts), por isso não leva este quando corre bem.
 */
export type JobNotice = 'episode_ready' | 'video_ready' | 'video_failed';

export async function notifyJob(db: Db, job: { id: string; interview_id: string | null; input?: any }, what: JobNotice, detail = ''): Promise<void> {
  if (!job.interview_id) return;
  const iv = await db.one('SELECT id, title, owner_id FROM interviews WHERE id=$1', [job.interview_id]);
  if (!iv) return;
  const uid = typeof job.input?.requestedBy === 'string' ? job.input.requestedBy : iv.owner_id;
  const u = await db.one('SELECT email FROM users WHERE id=$1', [uid]) ?? await db.one('SELECT email FROM users WHERE id=$1', [iv.owner_id]);
  if (!u?.email) return;
  const url = `${config.baseUrl}/entrevistas/${iv.id}/producao`;
  const t = iv.title || 'a sua entrevista';
  const m = {
    episode_ready: { subject: `Episódio pronto: ${t}`, title: 'O episódio está pronto', body: `O episódio de «${t}» foi gerado. Pode ouvi-lo, rever as legendas, gerar o vídeo e enviá-lo para aprovação na página de produção.` },
    video_ready: { subject: `Vídeo pronto: ${t}`, title: 'O vídeo está pronto', body: `O vídeo de «${t}» foi gerado. Veja-o na página de produção antes de o aprovar e publicar.` },
    video_failed: { subject: `Não foi possível gerar o vídeo: ${t}`, title: 'O vídeo não foi gerado', body: `O vídeo de «${t}» não foi gerado.${detail ? ` Motivo: ${detail.slice(0, 400)}` : ''} O episódio continua como estava; na página de produção pode tentar de novo ou pedir ajuda.` },
  }[what];
  await queueEmail(db, { key: `job-${what}:${job.id}`, interviewId: iv.id, to: u.email, subject: m.subject,
    text: `${m.body}\n\n${url}`, html: emailShell(m.title, `<p>${esc(m.body)}</p>`, { label: 'Abrir a produção', url }) });
}
