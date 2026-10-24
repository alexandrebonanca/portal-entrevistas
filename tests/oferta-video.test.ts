import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Duas opções de vídeo para o cliente (normal e premium, sem modelos nem custos internos), estimativa do tempo desde o
// início da barra de progresso e email quando o episódio ou o vídeo ficam prontos (ou o vídeo falha).
process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-oferta-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { notifyJob } = await import('../src/notify.ts');
const { expectedSec } = await import('../src/routes/production.ts');
const { videoSummary, VIDEO_NORMAL, VIDEO_PREMIUM } = await import('../src/video-offer.ts');
const { quoteTier } = await import('../src/quotes.ts');

let db: any, app: any, ivId = '', userId = '';
before(async () => {
  db = await openDb(); await migrate(db); app = await buildApp(db);
  userId = (await db.one(`INSERT INTO users(email, name, password_hash, role) VALUES ('ana@example.com','Ana','x','interviewer') RETURNING id`)).id;
  ivId = (await db.one(`INSERT INTO interviews(owner_id, title) VALUES ($1,'Histórias do mar') RETURNING id`, [userId])).id;
});
after(async () => { await app.close(); await db.close(); });

test('o Premium vende-se sempre com o Fast', () => { assert.equal(quoteTier(), 'fast'); });

test('resumo do vídeo para o cliente: normal ou premium, sem custos, modelos nem fornecedor', () => {
  assert.equal(videoSummary({ video_lang: 'en' }, { lang: 'en', graphics: {} }), `Legendas: en · ${VIDEO_NORMAL}`);
  const p = videoSummary({ video_lang: 'en' }, { engine: 'veo', model: 'veo-3.1-fast-generate-001', tier: 'fast', veoUsd: 3.2, fallbackSegments: ['s1', 's2'] });
  assert.match(p, new RegExp(`${VIDEO_PREMIUM.replace(/[()]/g, '\\$&')} · 2 falas com a fotografia fixa`));
  assert.doesNotMatch(p, /Veo|Fast|Lite|\$|Google/);
});

test('email quando termina: episódio pronto, vídeo pronto (para quem pediu) e vídeo falhado com o motivo, uma vez por trabalho', async () => {
  const other = (await db.one(`INSERT INTO users(email, name, password_hash, role) VALUES ('rui@example.com','Rui','x','admin') RETURNING id`)).id;
  await notifyJob(db, { id: '00000000-0000-0000-0000-000000000001', interview_id: ivId, input: {} }, 'episode_ready');
  await notifyJob(db, { id: '00000000-0000-0000-0000-000000000002', interview_id: ivId, input: { requestedBy: other } }, 'video_ready');
  await notifyJob(db, { id: '00000000-0000-0000-0000-000000000002', interview_id: ivId, input: { requestedBy: other } }, 'video_ready');
  await notifyJob(db, { id: '00000000-0000-0000-0000-000000000003', interview_id: ivId, input: {} }, 'video_failed', 'Capa ou áudio do episódio em falta');
  const rows = await db.query(`SELECT dedupe_key, to_email, subject, text_body, html FROM emails WHERE interview_id=$1 ORDER BY created_at, dedupe_key`, [ivId]);
  assert.deepEqual(rows.map((r: any) => [r.to_email, r.subject]), [
    ['ana@example.com', 'Episódio pronto: Histórias do mar'],
    ['rui@example.com', 'Vídeo pronto: Histórias do mar'],
    ['ana@example.com', 'Não foi possível gerar o vídeo: Histórias do mar']]);
  assert.match(rows[2].text_body, /Motivo: Capa ou áudio do episódio em falta/);
  assert.match(rows[1].text_body, new RegExp(`http://test.local/entrevistas/${ivId}/producao`));
  assert.match(rows[1].html, /Abrir a produção/);
});

test('estimativa inicial do tempo: por omissão pelo tamanho do episódio e depois pelo histórico do servidor', async () => {
  const sc = (await db.one(`INSERT INTO scripts(interview_id, revision, title_en, segments, status, prompt_version, model) VALUES ($1,1,'t','[]','approved','t','t') RETURNING id`, [ivId])).id;
  const ep = async (min: number) => (await db.one(`INSERT INTO episodes(interview_id, script_id, slug, title, duration_ms) VALUES ($1,$2,$3,'t',$4) RETURNING id`, [ivId, sc, `s-${Math.random()}`, min * 60000])).id;
  const e15 = await ep(15);
  assert.equal(await expectedSec(db, { kind: 'render_video', input: { episodeId: e15 } }), 40 * 15, 'fotografias: ~40 s por minuto de episódio');
  assert.equal(await expectedSec(db, { kind: 'render_video', input: { episodeId: e15, engine: 'veo' } }), 150 * 15, 'Veo sem orçamento');
  // histórico: dois vídeos de 10 min que levaram 5 min → 30 s por minuto de episódio
  for (let k = 0; k < 2; k++) {
    const e = await ep(10);
    await db.query(`INSERT INTO jobs(interview_id, kind, input, state, started_at, finished_at) VALUES ($1,'render_video',$2,'done', now() - interval '6 minutes', now() - interval '1 minute')`, [ivId, JSON.stringify({ episodeId: e })]);
  }
  assert.equal(await expectedSec(db, { kind: 'render_video', input: { episodeId: e15 } }), 30 * 15);
  assert.equal(await expectedSec(db, { kind: 'generate_episode', input: {} }), null, 'sem histórico, só pelo ritmo');
});
