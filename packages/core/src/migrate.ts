import type { DB } from './db.js';
import { transaction } from './transaction.js';
import { SCHEMA_SQL } from './schema.js';

const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => db.exec(SCHEMA_SQL),
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
