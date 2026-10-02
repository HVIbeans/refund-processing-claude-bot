// npm run db:reset — rebuilds data/refunds.db from the schema and seed data.
import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { applySchema, defaultDbPath, openDb } from './index.js';
import { seed } from './seed.js';

rmSync(defaultDbPath, { force: true });
mkdirSync(dirname(defaultDbPath), { recursive: true });

const db = openDb();
applySchema(db);
seed(db);

for (const table of ['customers', 'payment_methods', 'orders', 'payments', 'refunds', 'escalations']) {
  const { n } = db.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  console.log(`${table.padEnd(16)} ${n}`);
}
db.close();
console.log(`\nReset ${defaultDbPath}`);
