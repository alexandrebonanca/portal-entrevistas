import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Teto global do formulário público de contacto (/contact), com os valores por omissão: mesmo com os limites por IP e por
// email contornados (X-Forwarded-For forjado e um endereço novo em cada pedido, com o mesmo carimbo reutilizado), passam
// no máximo 30 pedidos novos por hora e 100 por dia; acima disso, 429 sem gravar nem pôr emails na fila. E os emails do
// formulário vão para o fim da fila de envio. IA em modo simulado, sem rede.
delete process.env.CONTACT_PER_HOUR;
delete process.env.CONTACT_PER_DAY;
process.env.AI_MOCK = '1';
process.env.PGLITE_MEMORY = '1';
process.env.STORAGE_DIR = mkdtempSync(join(tmpdir(), 'pe-test-'));
process.env.BASE_URL = 'http://test.local';

const { openDb, migrate } = await import('../src/db.ts');
const { buildApp } = await import('../src/app.ts');
const { contactStamp } = await import('../src/support.ts');
const { flushOutbox, queueEmail } = await import('../src/mail.ts');
const { config } = await import('../src/config.ts');

let db: any, app: any;
before(async () => { db = await openDb(); await migrate(db); app = await buildApp(db); });
after(async () => { await app.close(); await db.close(); });

const form = (o: Record<string, any>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();
let n = 0;
/**
 * Um pedido da inundação: o mesmo cliente real (o último endereço, o do proxy) com um primeiro endereço forjado diferente
 * em cada pedido (sem TRUST_PROXY, é esse o IP dos limites) e, por omissão, um email novo.
 */
const flood = (stamp: string, email?: string) => {
  n++;
  return app.inject({ method: 'POST', url: '/contact', payload: form({ ts: stamp, name: 'Robô', email: email ?? `vitima${n}@exemplo.pt`, topic: 'other', message: `Mensagem ${n} da inundação.`, accept: '1' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `203.0.${Math.floor(n / 250)}.${n % 250}, 10.0.0.9` } });
};
const count = async (sql: string) => Number((await db.one(`SELECT count(*)::int AS n FROM ${sql}`)).n);
const threads = () => count(`support_threads WHERE origin='visitor'`);
const contactMails = () => count(`emails WHERE starts_with(dedupe_key, 'contact:')`);
const GLOBAL = /We are receiving an unusually high number of messages right now/;

test('inundação com um só carimbo, IP forjados e emails diferentes: passam 30 na hora; o resto recebe 429 sem pedido nem email', async () => {
  assert.equal(config.limits.contactPerHour, 30); assert.equal(config.limits.contactPerDay, 100);
  const stamp = contactStamp(Date.now() - 5000); // aberto uma vez e reutilizado em todos os pedidos
  // Sem registo de pedidos nos testes (logger desligado), o req.log é o app.log: apanham-se os avisos.
  const warns: any[] = [], warn = app.log.warn;
  app.log.warn = (o: any, msg: string) => { warns.push({ o, msg }); };
  try {
    for (let k = 0; k < 30; k++) assert.equal((await flood(stamp)).statusCode, 303, `pedido ${k + 1}`);
    const over = await flood(stamp, 'repetida@exemplo.pt');
    assert.equal(over.statusCode, 429, 'o 31.º na hora, de um IP e email novos');
    assert.match(over.body, GLOBAL);
    assert.match(over.body, /Mensagem 31 da inundação\./, 'o texto volta ao formulário');
    for (let k = 0; k < 29; k++) assert.equal((await flood(stamp)).statusCode, 429);
  } finally { app.log.warn = warn; }
  assert.equal(await threads(), 30, '30 pedidos gravados');
  assert.equal(await contactMails(), 30, '30 emails na fila');
  assert.equal(warns.length, 1, 'um só aviso no registo (no máximo de 5 em 5 minutos)');
  assert.match(warns[0].msg, /teto global de pedidos novos atingido/);
  assert.deepEqual(warns[0].o, { refused: 1, perHour: 30, perDay: 100 });
  assert.doesNotMatch(JSON.stringify(warns), /exemplo\.pt|203\.0\./, 'sem emails nem IP no aviso');
});

test('fila de envio: os emails do formulário vão depois dos convites e dos contratos', async () => {
  // 30 emails do formulário à espera, mais antigos; um convite e um contrato (contract:…, não contact:…) chegam depois.
  await queueEmail(db, { key: 'invite:teste-fila', to: 'convidado@exemplo.pt', subject: 'Convite', html: '<p>Convite</p>', text: 'Convite' });
  await queueEmail(db, { key: 'contract:teste-fila', to: 'cliente@exemplo.pt', subject: 'Contrato', html: '<p>Contrato</p>', text: 'Contrato' });
  const log = console.log;
  console.log = () => {}; // o envio de desenvolvimento escreve cada email na consola
  try { await flushOutbox(db); } finally { console.log = log; }
  const state = async (key: string) => (await db.one('SELECT state FROM emails WHERE dedupe_key=$1', [key])).state;
  assert.equal(await state('invite:teste-fila'), 'sent', 'o convite sai na primeira leva de 20');
  assert.equal(await state('contract:teste-fila'), 'sent', 'o contrato também');
  assert.equal(await count(`emails WHERE starts_with(dedupe_key, 'contact:') AND state='sent'`), 18, 'o resto da leva: emails do formulário');
  assert.equal(await count(`emails WHERE starts_with(dedupe_key, 'contact:') AND state='pending'`), 12);
});

test('o teto global renova-se à hora sem gastar os limites do email; por dia passam 100; 0 fecha o formulário', async () => {
  const real = Date.now;
  try {
    // Hora seguinte: o email recusado pelo teto global não gastou o limite dele (3 por hora), e o do email continua a valer.
    Date.now = () => real() + 3600_000 + 1000;
    const stamp = contactStamp(Date.now() - 5000);
    for (let k = 0; k < 3; k++) assert.equal((await flood(stamp, 'repetida@exemplo.pt')).statusCode, 303, `repetida ${k + 1}`);
    const own = await flood(stamp, 'repetida@exemplo.pt');
    assert.equal(own.statusCode, 429); assert.match(own.body, /Too many messages have been sent from this email address/);
    for (let k = 0; k < 27; k++) assert.equal((await flood(stamp)).statusCode, 303, `hora 1, pedido ${k + 4}`);
    assert.match((await flood(stamp)).body, GLOBAL, 'hora 1: 30');
    // Mais uma hora com 30 e, na seguinte, só 10: 100 em 24 horas.
    Date.now = () => real() + 2 * 3600_000 + 2000;
    for (let k = 0; k < 30; k++) assert.equal((await flood(stamp)).statusCode, 303, `hora 2, pedido ${k + 1}`);
    assert.equal((await flood(stamp)).statusCode, 429);
    Date.now = () => real() + 3 * 3600_000 + 3000;
    for (let k = 0; k < 10; k++) assert.equal((await flood(stamp)).statusCode, 303, `hora 3, pedido ${k + 1}`);
    const day = await flood(stamp);
    assert.equal(day.statusCode, 429, 'o 101.º em 24 horas'); assert.match(day.body, GLOBAL);
    assert.equal(await threads(), 100);
    // 24 horas depois do primeiro: os 30 da primeira hora saem da conta do dia.
    Date.now = () => real() + 24 * 3600_000 + 1000;
    assert.equal((await flood(contactStamp(Date.now() - 5000))).statusCode, 303);
    assert.equal(await threads(), 101);
    // Teto a 0 (CONTACT_PER_HOUR=0): o formulário deixa de aceitar pedidos novos.
    const keep = config.limits.contactPerHour;
    config.limits.contactPerHour = 0;
    try {
      const closed = await flood(contactStamp(Date.now() - 5000));
      assert.equal(closed.statusCode, 429); assert.match(closed.body, GLOBAL);
    } finally { config.limits.contactPerHour = keep; }
  } finally { Date.now = real; }
  assert.equal(await threads(), 101, 'nenhuma recusa gravou um pedido');
});
