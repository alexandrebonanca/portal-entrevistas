import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Concorrência da carteira em Postgres REAL com várias ligações (o PGlite dos outros testes tem uma só ligação e serializa
 * tudo, por isso não prova o UPDATE condicional nem os bloqueios). Corre só com TEST_DATABASE_URL (uma base de testes,
 * nunca a de produção): cria um esquema temporário, aplica as migrações e apaga-o no fim.
 *   TEST_DATABASE_URL=postgres://utilizador:palavra@localhost:5432/testes npm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';

test('carteira em Postgres real: duas cativações em simultâneo nunca deixam o saldo negativo; um lote credita-se uma vez', { skip: !url && 'sem TEST_DATABASE_URL (Postgres real de testes)' }, async () => {
  const pg = (await import('pg')).default;
  const W = await import('../src/wallet.ts');
  const schema = `carteira_teste_${process.pid}_${Date.now()}`;
  const admin = new pg.Pool({ connectionString: url, max: 1 });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url, max: 6, options: `-c search_path=${schema},public` });
  // O mesmo invólucro de src/db.ts: cada transação numa ligação própria.
  const mk = (client: any): any => ({
    query: async (sql: string, p: any[] = []) => (await client.query(sql, p)).rows,
    one: async (sql: string, p: any[] = []) => (await client.query(sql, p)).rows[0],
    tx: async (fn: any) => { const c = await pool.connect(); try { await c.query('BEGIN'); const r = await fn(mk(c)); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); } },
  });
  const db = mk(pool);
  try {
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of readdirSync(dir).filter(f => f.endsWith('.sql')).sort())
      await db.tx(async (t: any) => { for (const stmt of readFileSync(new URL(f, dir), 'utf8').split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) await t.query(stmt); });
    const u = await db.one(`INSERT INTO users(email, name, password_hash, role) VALUES ('pg@example.com','PG','x','interviewer') RETURNING id`);
    const w = await W.walletFor(db, u.id, null);
    const lot = await db.one(`INSERT INTO credit_topups(wallet_id, user_id, net_cents, vat_cents, gross_cents, vat_rate, vat_regime, customer_kind, customer_country) VALUES ($1,$2,2500,575,3075,23,'domestic','business','PT') RETURNING id`, [w.id, u.id]);
    // o mesmo pagamento confirmado duas vezes em simultâneo (webhook e regresso do Checkout): credita uma vez
    const credits = await Promise.all([1, 2].map(() => db.tx(async (t: any) => { const r = await W.creditTopup(t, lot.id, { paymentIntent: 'pi_pg' }); await t.query('SELECT pg_sleep(0.2)'); return r; }).catch(() => false)));
    assert.deepEqual(credits.filter(Boolean).length, 1);
    assert.equal((await W.walletFor(db, u.id, null)).available_cents, 2500);
    // duas aceitações de 20 créditos ao mesmo tempo com 25 de saldo: uma passa, a outra fica sem saldo
    const slow = (ref: string, delay: number) => new Promise(r => setTimeout(r, delay)).then(() => db.tx(async (t: any) => {
      const e = await W.reserve(t, w.id, 2000, { ref });
      await t.query('SELECT pg_sleep(0.3)'); // a outra transação fica à espera do bloqueio da carteira e reavalia a condição
      return e;
    }));
    const [a, b] = await Promise.all([slow('pg:a', 0), slow('pg:b', 50)]);
    assert.equal([a, b].filter(Boolean).length, 1, 'só uma cativação');
    const cur = await W.walletFor(db, u.id, null);
    assert.deepEqual([cur.available_cents, cur.reserved_cents], [500, 2000]);
    // gasto e libertação em simultâneo na mesma carteira
    await Promise.all([db.tx((t: any) => W.release(t, a ? 'pg:a' : 'pg:b')), db.tx((t: any) => W.spend(t, w.id, 500, { ref: 'pg:gasto', note: 'teste' }))]);
    const end = await W.walletFor(db, u.id, null);
    assert.deepEqual([end.available_cents, end.reserved_cents], [2000, 0]);
    assert.deepEqual(await W.ledgerCheck(db), []);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`).catch(() => {});
    await admin.end();
  }
});
