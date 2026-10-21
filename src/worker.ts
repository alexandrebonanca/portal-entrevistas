import type { Db } from './db.ts';
import { config } from './config.ts';
import { runOne, recoverOrphans, recoverStale, markReady, type Handler, type Lane } from './jobs.ts';
import { handlers as pipelineHandlers } from './pipeline.ts';
import { flushOutbox } from './mail.ts';
import { openDb, migrate } from './db.ts';
import { walletHousekeeping } from './wallet.ts';
import { quoteHousekeeping } from './quotes.ts';
import { purgeAssistantLog } from './assistant.ts';

/**
 * Worker, fora do ciclo de pedidos HTTP, com cada parte no seu ciclo (nenhuma espera pelas outras):
 * - duas vias de trabalhos: a curta (transcrição, guião, episódio) e a dos vídeos, que leva de minutos a horas;
 * - a outbox dos emails (convites, confirmações dos orçamentos);
 * - o vigilante da fila: retoma trabalhos de um processo que morreu, marca os vídeos que já podem arrancar (prazo de 24 h)
 *   e liberta os orçamentos parados;
 * - o registo do assistente: apaga as perguntas com mais de 180 dias (no máximo uma vez por hora);
 * - as carteiras de créditos (de hora a hora): aviso 30 dias antes da validade, caducidade e devoluções.
 */
export function startWorker(db: Db, o: { intervalMs?: number; handlers?: Record<string, Handler>; recover?: boolean } = {}) {
  const intervalMs = o.intervalMs ?? 2000, handlers = o.handlers ?? pipelineHandlers;
  let stopped = false;
  const timers: ReturnType<typeof setInterval>[] = [];
  const inFlight = new Set<Promise<void>>();
  /** Ciclo com exclusão: uma volta não começa enquanto a anterior corre. */
  const cycle = (name: string, everyMs: number, fn: () => Promise<unknown>) => {
    let busy = false;
    const run = (): Promise<void> => {
      if (stopped || busy) return Promise.resolve();
      busy = true;
      const p = fn().then(() => {}, (e: any) => { console.error(`[worker] ${name}`, e?.message ?? e); }).finally(() => { busy = false; inFlight.delete(p); });
      inFlight.add(p);
      return p;
    };
    timers.push(setInterval(run, everyMs));
    return run;
  };
  const drain = (lane: Lane | 'all') => async () => { while (!stopped && (await runOne(db, handlers, lane))) { /* esvazia a via */ } };
  const lanes = config.queue.lanes === 1 ? [cycle('fila', intervalMs, drain('all'))] : [cycle('via curta', intervalMs, drain('short')), cycle('via dos vídeos', intervalMs, drain('video'))];
  const mail = cycle('outbox', intervalMs, () => flushOutbox(db));
  const watchdog = cycle('vigilante', config.queue.watchdogMs, async () => { await recoverStale(db, handlers); await markReady(db); await quoteHousekeeping(db); });
  const assistantLog = cycle('registo do assistente', config.queue.watchdogMs, () => purgeAssistantLog(db));
  const wallets = cycle('carteiras', Number(process.env.WALLET_HOUSEKEEPING_MS ?? 3600_000), () => walletHousekeeping(db));
  const recover = o.recover ?? process.env.RUN_WORKER !== '0';
  void (recover ? recoverOrphans(db, handlers).catch(e => console.error('[worker] recuperação', e?.message)) : Promise.resolve())
    .then(() => Promise.all([...lanes.map(l => l()), mail(), watchdog(), wallets(), assistantLog()]));
  return {
    /** Pára os ciclos; a promessa resolve quando as voltas em curso terminam (o servidor não espera por um vídeo). */
    stop: () => { stopped = true; timers.forEach(clearInterval); return Promise.all([...inFlight]).then(() => {}); },
    tick: () => Promise.all(lanes.map(l => l())),
  };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('worker.ts')) {
  const db = await openDb();
  await migrate(db);
  console.log('Worker iniciado');
  startWorker(db);
}
