import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DB } from './db.js';
import { transaction } from './transaction.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => db.exec(readFileSync(join(here, 'schema.sql'), 'utf8')),
];

export function runMigrations(db: DB): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      MIGRATIONS[v]!(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
