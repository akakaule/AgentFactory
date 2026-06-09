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
