import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultDbPath = join(here, '..', '..', 'data', 'refunds.db');

// Pass ':memory:' for a throwaway database (tests).
export function openDb(path = defaultDbPath) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON'); // SQLite leaves foreign keys off unless asked
  return db;
}

export function applySchema(db) {
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
}
