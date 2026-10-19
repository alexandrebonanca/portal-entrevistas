import { openDb, migrate } from './db.ts';
const db = await openDb();
await migrate(db);
console.log('Migrações aplicadas.');
await db.close();
