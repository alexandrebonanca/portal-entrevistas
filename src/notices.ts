import type { Db } from './db.ts';

/**
 * Avisos no portal ao titular da entrevista (a entidade ou o entrevistador que a promove): quando o entrevistado abre o
 * convite, aceita, responde (e se uma resposta ficou sem voz), envia fotografias, muda as autorizações, submete, aprova ou
 * pede alterações; e quando o episódio, o vídeo ou um convite para assistir têm novidades. Ficam em /avisos (com o número
 * por ler na navegação) e na atividade de cada entrevista. Nunca levam o conteúdo das respostas.
 */
export type NoticeLevel = 'info' | 'ok' | 'warn' | 'bad';

export async function notice(db: Db, interviewId: string, kind: string, title: string, o: { body?: string; level?: NoticeLevel; url?: string; dedupe?: string; userId?: string } = {}) {
  try {
    const iv = await db.one('SELECT owner_id FROM interviews WHERE id=$1', [interviewId]);
    const uid = o.userId ?? iv?.owner_id;
    if (!uid) return;
    await db.query(`INSERT INTO notices(user_id, interview_id, kind, level, title, body, url, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedupe_key) DO NOTHING`,
      [uid, interviewId, kind, o.level ?? 'info', title.slice(0, 300), (o.body ?? '').slice(0, 2000), o.url ?? `/entrevistas/${interviewId}`, o.dedupe ?? null]);
  } catch (e) { console.error('[avisos] falhou:', String((e as any)?.message ?? e).slice(0, 200)); } // um aviso nunca faz falhar a ação
}

export const guestLabel = async (db: Db, interviewId: string) => (await db.one('SELECT guest_name FROM interviews WHERE id=$1', [interviewId]))?.guest_name || 'O entrevistado';
export const mmssMs = (ms: number) => { const s = Math.round((Number(ms) || 0) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
