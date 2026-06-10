export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS task (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  key                 TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  spec                TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  status              TEXT NOT NULL
    CHECK (status IN ('backlog','queued','in_progress','in_review','done','blocked')),
  result_summary      TEXT,
  seq                 INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('status_change','comment','result','feedback')),
  actor       TEXT NOT NULL CHECK (actor IN ('human','agent')),
  from_status TEXT,
  to_status   TEXT,
  body        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('branch','pr','worktree','log','url')),
  label   TEXT NOT NULL,
  url     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_status_seq ON task(status, seq);
CREATE INDEX IF NOT EXISTS idx_activity_task   ON activity(task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_updated    ON task(updated_at);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
CREATE INDEX IF NOT EXISTS idx_link_task       ON link(task_id);
`;

// Migration #2 — workspaces. task.workspace_id has no REFERENCES clause: SQLite rejects
// ADD COLUMN combining REFERENCES with a non-NULL default while foreign_keys=ON, and the
// pragma is a no-op inside the migration transaction. Integrity is app-level (ops resolve
// slug -> id in-transaction; workspace deletion does not exist).
export const MIGRATION_2_SQL = `
CREATE TABLE IF NOT EXISTS workspace (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,
  repo_path  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
ALTER TABLE task ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_task_workspace ON task(workspace_id, status, seq);
`;

// Migration #3 — claim metadata. Current-state only (history lives in activity);
// set on claim, cleared on any transition into 'queued'.
export const MIGRATION_3_SQL = `
ALTER TABLE task ADD COLUMN claimed_by TEXT;
ALTER TABLE task ADD COLUMN claimed_at TEXT;
`;
