import type { Db } from './db.ts';
import { runOne, recoverOrphans } from './jobs.ts';
import { handlers } from './pipeline.ts';
import { flushOutbox } from './mail.ts';
import { openDb, migrate } from './db.ts';
import { walletHousekeeping } from './wallet.ts';

/** Ciclo do worker: emails da outbox e trabalhos pesados (FFmpeg, IA) fora do ciclo de pedidos HTTP. */
export function startWorker(db: Db, intervalMs = 2000) {
  let stopped = false, busy = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    try {
      await flushOutbox(db);
      while (!stopped && (await runOne(db, handlers))) { /* esvazia a fila */ }
    } catch (e: any) { console.error('[worker]', e?.message ?? e); }
    finally { busy = false; }
  };
  const h = setInterval(tick, intervalMs);
  // Emails (convites, pré-visualizações) num ciclo próprio: um vídeo do Veo de dezenas de minutos não os atrasa.
  let mailing = false;
  const mail = setInterval(async () => {
    if (stopped || mailing || !busy) return; // com o worker livre, o tick já trata da outbox
    mailing = true;
    try { await flushOutbox(db); } catch (e: any) { console.error('[worker] outbox', e?.message ?? e); } finally { mailing = false; }
  }, Math.max(intervalMs, 5000));
  // Carteiras de créditos num ciclo próprio (de hora a hora): aviso 30 dias antes da validade, caducidade dos lotes e
  // devolução do crédito de regenerações falhadas. Corre mesmo com o worker ocupado num vídeo longo.
  let housekeeping = false;
  const wallets = async () => {
    if (stopped || housekeeping) return;
    housekeeping = true;
    try { await walletHousekeeping(db); } catch (e: any) { console.error('[worker] carteiras', e?.message ?? e); } finally { housekeeping = false; }
  };
  const hk = setInterval(wallets, Number(process.env.WALLET_HOUSEKEEPING_MS ?? 3600_000));
  void (process.env.RUN_WORKER === '0' ? Promise.resolve() : recoverOrphans(db).catch(e => console.error('[worker] recuperação', e?.message))).then(tick).then(wallets);
  return { stop: () => { stopped = true; clearInterval(h); clearInterval(mail); clearInterval(hk); }, tick };
}

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('worker.ts')) {
  const db = await openDb();
  await migrate(db);
  console.log('Worker iniciado');
  startWorker(db);
}
