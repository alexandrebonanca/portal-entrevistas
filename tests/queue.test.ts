import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const J = await import('../src/jobs.ts');
const { startWorker } = await import('../src/worker.ts');

let db: any;
before(async () => { db = await openDb(); await migrate(db); });
after(async () => { await db.close(); });
// Sem rede: estes testes só mexem na fila.
const realFetch = globalThis.fetch;
globalThis.fetch = ((u: any) => Promise.reject(new Error(`rede proibida nos testes: ${String(u)}`))) as any;
after(() => { globalThis.fetch = realFetch; });

const jobOf = (id: string) => db.one('SELECT * FROM jobs WHERE id=$1', [id]);
let seq = 0;
const add = async (kind: string, input: object = {}) => (await J.enqueue(db, { kind, input, dedupe: `t:${kind}:${++seq}` }))!;
const clear = () => db.query('DELETE FROM jobs');
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Espera (até 8 s) que a condição se verifique. */
const until = async (cond: () => boolean | Promise<boolean>, what: string) => {
  for (const t0 = Date.now(); Date.now() - t0 < 8000; await pause(15)) if (await cond()) return;
  assert.fail(`tempo esgotado à espera de: ${what}`);
};

test('vias: a curta nunca pega num vídeo e a dos vídeos só pega em vídeos; na via única os curtos vão primeiro', async () => {
  await clear();
  const ran: string[] = [];
  const h: any = { render_video: async () => { ran.push('video'); }, generate_episode: async () => { ran.push('curto'); } };
  const v = await add('render_video'), s = await add('generate_episode');
  assert.equal(await J.runOne(db, h, 'video'), true);
  assert.equal(await J.runOne(db, h, 'video'), false, 'a via dos vídeos não pega no episódio');
  assert.deepEqual(ran, ['video']);
  assert.equal(await J.runOne(db, h, 'short'), true);
  assert.equal(await J.runOne(db, h, 'short'), false, 'a via curta não pega em vídeos');
  assert.deepEqual(ran, ['video', 'curto']);
  for (const id of [v, s]) { const j = await jobOf(id); assert.equal(j.state, 'done'); assert.ok(j.ready_at, 'pôde arrancar: fica a hora'); }
  // Via única (os testes e WORKER_LANES=1): os curtos primeiro, mesmo que o vídeo tenha chegado antes.
  await clear(); ran.length = 0;
  await add('render_video'); await add('generate_episode');
  await db.query(`UPDATE jobs SET created_at=now() - interval '1 minute' WHERE kind='render_video'`); // o vídeo chegou antes
  while (await J.runOne(db, h)) { /* */ }
  assert.deepEqual(ran, ['curto', 'video']);
  assert.deepEqual(['render_video', 'talking_compare', 'lipsync_experiment', 'process_submission', 'generate_episode'].map(J.laneOf), ['video', 'video', 'video', 'short', 'short']);
});

test('uma entrevista de cada vez: o episódio novo espera pelo vídeo da mesma entrevista; os das outras entrevistas não', async () => {
  await clear();
  const u = await db.one(`INSERT INTO users(email, name, password_hash) VALUES ('fila@example.com', 'Fila', 'x') RETURNING id`);
  const iv = async (t: string) => (await db.one('INSERT INTO interviews(owner_id, title) VALUES ($1,$2) RETURNING id', [u.id, t])).id;
  const i1 = await iv('Um'), i2 = await iv('Dois');
  const v = (await J.enqueue(db, { kind: 'render_video', interviewId: i1, dedupe: 'i1:video' }))!;
  await db.query(`UPDATE jobs SET state='running', attempts=1, locked_at=now() WHERE id=$1`, [v]);
  const e1 = (await J.enqueue(db, { kind: 'generate_episode', interviewId: i1, dedupe: 'i1:ep' }))!;
  const e2 = (await J.enqueue(db, { kind: 'generate_episode', interviewId: i2, dedupe: 'i2:ep' }))!;
  const ran: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  const h: any = { generate_episode: async (j: any) => { ran.push(j.id); if (j.id === e1) await gate; } };
  assert.equal(await J.runOne(db, h, 'short'), true);
  assert.equal(await J.runOne(db, h, 'short'), false, 'o episódio da entrevista do vídeo espera');
  assert.deepEqual(ran, [e2]);
  // O vídeo termina: o episódio dessa entrevista arranca; um vídeo novo dela não pode arrancar enquanto o episódio corre.
  await db.query(`UPDATE jobs SET state='done', finished_at=now() WHERE id=$1`, [v]);
  const running = J.runOne(db, h, 'short');
  await until(() => ran.includes(e1), 'o episódio da entrevista arrancar');
  const v2 = (await J.enqueue(db, { kind: 'render_video', interviewId: i1, dedupe: 'i1:video2' }))!;
  assert.equal(await J.markReady(db), 0);
  assert.equal(await J.runOne(db, { render_video: async () => {} } as any, 'video'), false);
  open(); await running;
  assert.equal(await J.markReady(db), 1);
  assert.ok((await jobOf(v2)).ready_at);
});

test('worker: um vídeo de horas não atrasa os trabalhos curtos dos outros; o batimento renova o bloqueio enquanto corre', async () => {
  await clear();
  const hb = config.queue.heartbeatMs;
  config.queue.heartbeatMs = 30;
  let open!: () => void;
  const gate = new Promise<void>(r => { open = r; });
  let started = false;
  const done: string[] = [];
  const h: any = { render_video: async () => { started = true; await gate; return { ok: 1 }; }, generate_episode: async (j: any) => { done.push(j.id); } };
  const v = await add('render_video');
  const w = startWorker(db, { intervalMs: 20, handlers: h, recover: false });
  try {
    await until(() => started, 'o vídeo começar');
    const lock0 = new Date((await jobOf(v)).locked_at).getTime();
    const s1 = await add('generate_episode'), s2 = await add('generate_episode');
    await until(() => done.length === 2, 'os dois episódios correrem com o vídeo ocupado');
    assert.deepEqual(done.sort(), [s1, s2].sort());
    assert.equal((await jobOf(v)).state, 'running', 'o vídeo continua a correr na via dele');
    assert.ok(J.runningHere.has(v));
    await until(async () => new Date((await jobOf(v)).locked_at).getTime() > lock0, 'o batimento renovar o bloqueio');
    open();
    await until(async () => (await jobOf(v)).state === 'done', 'o vídeo terminar');
    assert.ok(!J.runningHere.has(v));
  } finally { open(); await w.stop(); config.queue.heartbeatMs = hb; }
});

test('vigilante e arranque: um reinício não gasta tentativa num trabalho de orçamento; os outros gastam e, sem tentativas, falham pelo __onFail', async () => {
  await clear();
  const failed: string[] = [];
  const h: any = { __onFail: async (j: any) => { failed.push(j.id); } };
  const quote = await add('render_video', { quoteId: '00000000-0000-4000-8000-000000000001', engine: 'veo' });
  const ep = await add('generate_episode'), sub = await add('process_submission');
  // Os três estavam a correr num processo que morreu: o de orçamento e o episódio já na última tentativa.
  await db.query(`UPDATE jobs SET state='running', attempts=3, locked_at=now() - interval '10 minutes' WHERE id IN ($1,$2)`, [quote, ep]);
  await db.query(`UPDATE jobs SET state='running', attempts=1, locked_at=now() - interval '10 minutes' WHERE id=$1`, [sub]);
  assert.deepEqual(await J.recoverStale(db, h), { resumed: 2, failed: 1 });
  let q = await jobOf(quote);
  assert.deepEqual([q.state, q.attempts, q.interruptions], ['queued', 2, 1], 'o reinício não conta como tentativa');
  assert.match(q.progress_label, /reinício/);
  const s = await jobOf(sub);
  assert.deepEqual([s.state, s.attempts, s.interruptions], ['queued', 1, 1], 'nos outros, a tentativa interrompida conta');
  const e = await jobOf(ep);
  assert.equal(e.state, 'failed'); assert.match(e.error, /sem mais tentativas/);
  assert.deepEqual(failed, [ep], 'o __onFail corre (ex.: devolve o crédito de uma regeneração paga)');
  // Batimento recente: o trabalho está a correr noutro lado; não se toca.
  await db.query(`UPDATE jobs SET state='running', attempts=3, locked_at=now() WHERE id=$1`, [quote]);
  assert.deepEqual(await J.recoverStale(db, h), { resumed: 0, failed: 0 });
  // A correr neste processo: nunca se retoma, mesmo sem batimento.
  await db.query(`UPDATE jobs SET locked_at=now() - interval '10 minutes' WHERE id=$1`, [quote]);
  J.runningHere.add(quote);
  try { assert.deepEqual(await J.recoverStale(db, h), { resumed: 0, failed: 0 }); } finally { J.runningHere.delete(quote); }
  // No arranque (instância única) todos os 'running' ficaram órfãos: retomam logo, sem esperar pelo batimento.
  await db.query(`UPDATE jobs SET locked_at=now() WHERE id=$1`, [quote]);
  assert.deepEqual(await J.recoverOrphans(db, h), { resumed: 1, failed: 0 });
  q = await jobOf(quote);
  assert.deepEqual([q.state, q.attempts, q.interruptions], ['queued', 2, 2]);
  // Ao fim de JOB_MAX_INTERRUPTIONS reinícios, falha (o __onFail liberta o orçamento).
  await db.query(`UPDATE jobs SET state='running', interruptions=$2, locked_at=now() WHERE id=$1`, [quote, config.queue.maxInterruptions]);
  assert.deepEqual(await J.recoverOrphans(db, h), { resumed: 0, failed: 1 });
  q = await jobOf(quote);
  assert.equal(q.state, 'failed'); assert.match(q.error, /reinícios do servidor/);
  assert.deepEqual(failed, [ep, quote]);
});

test('pode arrancar: só o primeiro vídeo elegível com a via livre; a espera pela fila não conta para o prazo', async () => {
  await clear();
  const a = await add('render_video', { engine: 'veo' });
  const b = await add('render_video', { quoteId: '00000000-0000-4000-8000-000000000002', engine: 'veo' });
  const later = await add('render_video');
  await db.query(`UPDATE jobs SET run_after=now() + interval '1 hour' WHERE id=$1`, [later]);
  // ordem de chegada explícita (o relógio do PGlite pode dar o mesmo instante a inserções seguidas)
  for (const [k, id] of [a, b, later].entries()) await db.query(`UPDATE jobs SET created_at=now() - ($2 || ' seconds')::interval WHERE id=$1`, [id, String(10 - k)]);
  // A via está livre: só o primeiro (por ordem de chegada) pode arrancar já.
  assert.equal(await J.markReady(db), 1);
  assert.ok((await jobOf(a)).ready_at); assert.equal((await jobOf(b)).ready_at, null);
  // O primeiro arranca: o segundo espera pela nossa fila (sem contar o prazo).
  await db.query(`UPDATE jobs SET state='running', attempts=1, locked_at=now() WHERE id=$1`, [a]);
  assert.equal(await J.markReady(db), 0);
  assert.equal((await jobOf(b)).ready_at, null);
  let pos = await J.videoQueue(db, b);
  assert.deepEqual([pos.ahead, pos.minutes], [1, 30], 'um Veo do administrador à frente (sem orçamento: ~30 min)');
  await db.query(`UPDATE jobs SET progress_done=50, progress_total=100 WHERE id=$1`, [a]);
  assert.equal((await J.videoQueue(db, b)).minutes, 15, 'a meio: metade do tempo');
  const draft = await J.videoQueue(db, null);
  assert.deepEqual([draft.ahead, draft.minutes], [3, 15 + 30 + 5], 'para um orçamento por aceitar: tudo o que está na via (o que está em pausa também volta)');
  // O primeiro termina: o segundo passa a poder arrancar.
  await db.query(`UPDATE jobs SET state='done', finished_at=now() WHERE id=$1`, [a]);
  assert.equal(await J.markReady(db), 1);
  assert.ok((await jobOf(b)).ready_at); assert.equal((await jobOf(later)).ready_at, null, 'em pausa: ainda não pode arrancar');
  pos = await J.videoQueue(db, b);
  assert.deepEqual([pos.ahead, pos.minutes, pos.running], [0, 0, false]);
  await db.query(`UPDATE jobs SET state='running' WHERE id=$1`, [b]);
  assert.equal((await J.videoQueue(db, b)).running, true);
});
