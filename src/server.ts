import fastifyStatic from '@fastify/static';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { openDb, migrate } from './db.ts';
import { buildApp } from './app.ts';
import { startWorker } from './worker.ts';

// sharp (libvips): sem cache de operações e uma thread — com 512 MB a cache e a fragmentação da memória somavam-se
// fala a fala durante a animação até o servidor ser morto por falta de memória.
{ const sharp = (await import('sharp')).default; sharp.cache(false); sharp.concurrency(1); }

const db = await openDb();
await migrate(db);
const app = await buildApp(db);
await app.register(fastifyStatic, { root: fileURLToPath(new URL('../public/', import.meta.url)), prefix: '/static/', maxAge: '5m' });

// Por omissão o worker corre no mesmo processo (instância única). RUN_WORKER=0 para o separar (npm run worker).
const worker = process.env.RUN_WORKER === '0' ? null : startWorker(db);

await app.listen({ port: config.port, host: '0.0.0.0' });
console.log(`${config.brand} a escutar em ${config.baseUrl} (porta ${config.port})`);

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { worker?.stop(); await app.close(); await db.close(); process.exit(0); });
