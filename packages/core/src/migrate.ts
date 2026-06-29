import type { DB } from './db.js';
import { transaction } from './transaction.js';
import { SCHEMA_SQL, MIGRATION_2_SQL, MIGRATION_3_SQL, MIGRATION_4_SQL, MIGRATION_5_SQL, MIGRATION_6_SQL, MIGRATION_7_SQL, MIGRATION_8_SQL, MIGRATION_9_SQL, MIGRATION_10_SQL, MIGRATION_11_SQL, MIGRATION_12_SQL, MIGRATION_13_SQL, MIGRATION_15_SQL, MIGRATION_16_SQL } from './schema.js';

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
  (db) => db.exec(MIGRATION_7_SQL),
  (db) => db.exec(MIGRATION_8_SQL),
  (db) => {
    db.exec(MIGRATION_9_SQL);
    // first insert into the fresh table -> id = 1, the anchor every default-attributed
    // path can reference. Schema setup, not a user mutation: a fixed epoch created_at
    // mirrors the workspace seed (#2) and stays out of getVersion()'s change signal.
    db.prepare('INSERT INTO app_user(email, display_name, is_system, created_at) VALUES (?, ?, ?, ?)')
      .run('system@localhost', 'System', 1, '1970-01-01T00:00:00.000Z');
  },
  (db) => db.exec(MIGRATION_10_SQL),
  (db) => db.exec(MIGRATION_11_SQL),
  (db) => db.exec(MIGRATION_12_SQL),
  (db) => db.exec(MIGRATION_13_SQL),
  // Migration #14 — reconcile DBs that diverged past migration #11. Migrations are gated purely
  // on PRAGMA user_version, so a slot is identified by *position*, not content. Parallel feature
  // branches each appended a "migration #11" (main's #11 adds original_spec; an unmerged
  // feature/task-priority branch's #11 added a `priority` column). A DB migrated by that branch
  // first reached user_version 11 via the priority migration, so main's #11 (original_spec) was
  // silently skipped and never ran — leaving original_spec / original_acceptance_criteria absent
  // while user_version still climbed to 13. snapshotOriginal() (repo/tasks.ts) writes those
  // columns, so the description-stage submit_result then fails with "no such column: original_spec".
  // This migration re-adds them only if missing: a no-op on a correctly-migrated/fresh DB (the
  // columns already exist from #11), self-healing on a diverged one. SQLite has no
  // ADD COLUMN IF NOT EXISTS, hence the table_info guard.
  (db) => {
    const cols = (db.prepare("PRAGMA table_info('task')").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('original_spec')) db.exec('ALTER TABLE task ADD COLUMN original_spec TEXT;');
    if (!cols.includes('original_acceptance_criteria')) db.exec('ALTER TABLE task ADD COLUMN original_acceptance_criteria TEXT;');
  },
  (db) => db.exec(MIGRATION_15_SQL),
  (db) => db.exec(MIGRATION_16_SQL),
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
