import { config } from './config.ts';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';

export interface Db {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  one<T = any>(sql: string, params?: any[]): Promise<T | undefined>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function wrap(raw: { query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }, tx: Db['tx'], close: () => Promise<void>): Db {
  return {
    async query(sql, params = []) { return (await raw.query(sql, params)).rows; },
    async one(sql, params = []) { return (await raw.query(sql, params)).rows[0]; },
    tx, close,
  };
}

export async function openDb(): Promise<Db> {
  if (config.databaseUrl) {
    const pg = (await import('pg')).default;
    const ssl = /sslmode=disable|localhost|127\.0\.0\.1/.test(config.databaseUrl) ? undefined : { rejectUnauthorized: false };
    const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: 8 });
    const mk = (client: any): Db => wrap(client, async (fn) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(mk(c)); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    }, async () => { await pool.end(); });
    return mk(pool);
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = process.env.PGLITE_MEMORY ? undefined : config.pgliteDir;
  if (dir) mkdirSync(dir, { recursive: true });
  const lite = new PGlite(dir);
  const mk = (client: any): Db => wrap(client, async (fn) => {
    return lite.transaction(async (t: any) => fn(mk(t)));
  }, async () => { await lite.close(); });
  return mk(lite);
}

/** Aplica as migrações em falta; `until` (inclusive) pára antes das seguintes, para os testes de uma migração com dados antigos. */
export async function migrate(db: Db, opts: { until?: string } = {}) {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const dir = new URL('../migrations/', import.meta.url);
  const files = readdirSync(dir).filter(f => f.endsWith('.sql') && (!opts.until || f <= opts.until)).sort();
  for (const f of files) {
    if (await db.one('SELECT 1 FROM schema_migrations WHERE name=$1', [f])) continue;
    const sql = readFileSync(new URL(f, dir), 'utf8');
    await db.tx(async (t) => {
      for (const stmt of sql.split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) await t.query(stmt);
      await t.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
  }
}
