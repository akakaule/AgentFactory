import type { DB } from './db.js';
import { transaction } from './transaction.js';
import { SCHEMA_SQL, MIGRATION_2_SQL, MIGRATION_3_SQL, MIGRATION_4_SQL, MIGRATION_5_SQL, MIGRATION_6_SQL, MIGRATION_7_SQL, MIGRATION_8_SQL, MIGRATION_9_SQL, MIGRATION_10_SQL, MIGRATION_11_SQL, MIGRATION_12_SQL, MIGRATION_13_SQL, MIGRATION_15_SQL, MIGRATION_16_SQL, MIGRATION_17_SQL, MIGRATION_18_SQL, MIGRATION_19_SQL, MIGRATION_20_SQL, MIGRATION_21_SQL } from './schema.js';

/**
 * Widen a CHECK constraint by rebuilding the table (SQLite cannot ALTER a CHECK). The rebuild is
 * data-driven — the new table's DDL is the table's OWN sqlite_master sql with only the CHECK list
 * replaced, and the copy uses the live column list from table_info — so columns this repo's history
 * doesn't know about (a diverged DB, e.g. the task-priority branch's `priority`) survive intact.
 * Idempotent: a no-op when the stored DDL already contains `newList`; fails loudly when it contains
 * neither list (an unexpected shape must never be "fixed" by guesswork). Secondary indexes are
 * captured and replayed (DROP TABLE takes them with it); UNIQUE/PK auto-indexes recreate themselves.
 * MUST run with foreign_keys=OFF (see the fkOff migration mode below): with FK enforcement on,
 * DROP TABLE would cascade-delete every child row, and the rename would not re-point child
 * REFERENCES clauses.
 */
export function widenCheck(db: DB, table: string, oldList: string, newList: string): void {
  const master = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name = ?").get(table) as { sql: string } | undefined;
  if (!master) throw new Error(`widenCheck: table not found: ${table}`);
  if (master.sql.includes(newList)) return; // already widened (re-slotted/diverged DB) — no-op
  if (!master.sql.includes(oldList)) throw new Error(`widenCheck: ${table} DDL contains neither the expected old nor new CHECK list`);
  const tmp = `${table}_new`;
  const createTmp = master.sql
    .replace(oldList, newList)
    .replace(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?["'\`]?${table}["'\`]?`, 'i'), `CREATE TABLE ${tmp}`);
  const cols = (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>)
    .map((c) => `"${c.name}"`).join(', ');
  const indexSql = (db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name = ? AND sql IS NOT NULL").all(table) as Array<{ sql: string }>)
    .map((r) => r.sql);
  db.exec(createTmp);
  db.exec(`INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  for (const sql of indexSql) db.exec(sql);
}

const STATUS_LIST_17 = `('backlog','queued','in_progress','in_review','done','blocked')`;
const STATUS_LIST_18 = `('backlog','queued','in_progress','in_review','delivering','done','blocked')`;
const SUPERVISOR_KIND_LIST_17 = `('dispatcher','reviewer')`;
const SUPERVISOR_KIND_LIST_18 = `('dispatcher','reviewer','watcher')`;

/** A plain migration runs inside the standard transaction; `fkOff` marks a table-rebuild
 *  migration that needs `PRAGMA foreign_keys = OFF` (which only takes effect OUTSIDE a
 *  transaction) around its transaction, plus a pre-commit foreign_key_check. */
type Migration = ((db: DB) => void) | { fkOff: true; run: (db: DB) => void };

const MIGRATIONS: Migration[] = [
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
  // #17 adds task.kind via ADD COLUMN, which (unlike the CREATE TABLE IF NOT EXISTS migrations) is
  // not idempotent. Guard it with table_info so a rewound/diverged DB re-running it is a no-op —
  // same reconcile pattern as #14 (SQLite has no ADD COLUMN IF NOT EXISTS).
  (db) => {
    const cols = (db.prepare("PRAGMA table_info('task')").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('kind')) db.exec(MIGRATION_17_SQL);
  },
  // #18 — 'delivering' status + watcher heartbeat kind + task_delivery (see schema.ts). The two
  // CHECK widenings rebuild their tables, hence fkOff; each is idempotent via widenCheck's
  // already-widened guard, and task_delivery is CREATE TABLE IF NOT EXISTS.
  {
    fkOff: true,
    run: (db) => {
      widenCheck(db, 'task', STATUS_LIST_17, STATUS_LIST_18);
      widenCheck(db, 'supervisor_heartbeat', SUPERVISOR_KIND_LIST_17, SUPERVISOR_KIND_LIST_18);
      db.exec(MIGRATION_18_SQL);
    },
  },
  // #19 adds workspace.pat via ADD COLUMN, which is not idempotent. Guard with table_info so a
  // rewound/diverged DB re-running it is a no-op — same reconcile pattern as #14/#17.
  (db) => {
    const cols = (db.prepare("PRAGMA table_info('workspace')").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('pat')) db.exec(MIGRATION_19_SQL);
  },
  // #20 adds workspace.prompt_overrides via ADD COLUMN — guard with table_info like #19.
  (db) => {
    const cols = (db.prepare("PRAGMA table_info('workspace')").all() as Array<{ name: string }>).map((c) => c.name);
    if (!cols.includes('prompt_overrides')) db.exec(MIGRATION_20_SQL);
  },
  (db) => db.exec(MIGRATION_21_SQL),
];

export function runMigrations(db: DB): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    const m = MIGRATIONS[v]!;
    if (typeof m === 'object') {
      // Table-rebuild migration: FK enforcement must be off for DROP-old/RENAME-new to preserve
      // child rows and REFERENCES targets. The pragma only takes effect outside a transaction, so
      // toggle around it; foreign_key_check before commit proves the rebuild left no orphans.
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        transaction(db, () => {
          m.run(db);
          const bad = db.prepare('PRAGMA foreign_key_check').all();
          if (bad.length > 0) throw new Error(`migration ${v + 1}: foreign_key_check failed (${bad.length} rows)`);
          db.exec(`PRAGMA user_version = ${v + 1}`);
        });
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    } else {
      transaction(db, () => {
        m(db);
        db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }
}
