import type { DB } from './db.js';
import { transaction } from './transaction.js';
import { SCHEMA_SQL, MIGRATION_2_SQL, MIGRATION_3_SQL, MIGRATION_4_SQL, MIGRATION_5_SQL, MIGRATION_6_SQL } from './schema.js';

const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => db.exec(SCHEMA_SQL),
  (db) => {
    db.exec(MIGRATION_2_SQL);
    // first insert into the fresh table inside this transaction -> id = 1, matching the
    // DEFAULT 1 that backfills pre-existing tasks. The seed is schema setup, not a user
    // mutation: a fixed epoch created_at keeps it out of getVersion()'s change signal.
    db.prepare('INSERT INTO workspace(name, repo_path, created_at) VALUES (?, ?, ?)')
      .run('default', '.', '1970-01-01T00:00:00.000Z');
  },
  (db) => db.exec(MIGRATION_3_SQL),
  (db) => db.exec(MIGRATION_4_SQL),
  (db) => db.exec(MIGRATION_5_SQL),
  (db) => db.exec(MIGRATION_6_SQL),
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
