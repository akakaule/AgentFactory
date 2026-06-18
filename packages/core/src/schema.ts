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

// Migration #4 — worker-reported usage. One row per report (a re-submission after
// feedback adds another); aggregate = SUM tokens/cost, latest non-null model.
// All metric fields nullable: unreported is a first-class state, never zero.
export const MIGRATION_4_SQL = `
CREATE TABLE IF NOT EXISTS task_metric (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  model       TEXT,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  cost_usd    REAL,
  reported_by TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metric_task ON task_metric(task_id);
`;

// Migration #5 — spec image attachments. Bytes live in the shared SQLite (one-file
// model); cascade with the task; mutations are backlog-only and bump task.updated_at.
export const MIGRATION_5_SQL = `
CREATE TABLE IF NOT EXISTS attachment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  filename   TEXT NOT NULL,
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attachment_task ON attachment(task_id);
`;

// Migration #6 — server-named feature branch. Computed at first claim
// (feature/<key>-<kebab-title>) and persisted so reclaims reuse the same name even
// after a title edit; it is also the exact ref submit_result's guardrails verify
// against origin. Nullable: tasks claimed before this feature stay NULL and skip
// the guardrails (never brick an in-flight task on deploy).
export const MIGRATION_6_SQL = `
ALTER TABLE task ADD COLUMN branch TEXT;
`;

// Migration #7 — pipeline stages. A task walks description → plan → implementation,
// cycling through the existing statuses once per stage; approving an in-review doc
// stage advances the stage and re-queues. Legacy rows backfill to 'implementation'
// (today's behavior). `plan` holds the plan stage's deliverable; the description
// stage's deliverable updates spec/acceptance_criteria in place.
export const MIGRATION_7_SQL = `
ALTER TABLE task ADD COLUMN stage TEXT NOT NULL DEFAULT 'implementation'
  CHECK (stage IN ('description','plan','implementation'));
ALTER TABLE task ADD COLUMN plan TEXT;
`;

// Migration #8 — archive. A timestamp, not a status: the task keeps status 'done', so
// transitions and metrics are untouched and nothing is moved or rewritten. NULL means
// active; default read paths filter on it, the archive view flips the filter. Nullable:
// pre-existing rows backfill to active.
export const MIGRATION_8_SQL = `
ALTER TABLE task ADD COLUMN archived_at TEXT;
CREATE INDEX IF NOT EXISTS idx_task_archived ON task(archived_at);
`;

// Migration #9 — identity foundation. `app_user` (named to dodge the SQL-reserved `user`,
// which would force quoting here and in the eventual Postgres port) holds real humans;
// `api_token` holds hashed bearer credentials (raw token shown once, never stored). The
// new `activity.actor_user_id` records WHICH human is behind a 'human' action — orthogonal
// to the binary `actor` enum (which the transition machine + auto-approve still read), so
// it is strictly additive and nullable: agent/system/legacy rows stay NULL. No REFERENCES
// on the ALTER (SQLite forbids it with foreign_keys=ON); integrity is app-level, matching
// the workspace_id convention. The seed system user (id=1) is added in migrate.ts.
export const MIGRATION_9_SQL = `
CREATE TABLE IF NOT EXISTS app_user (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  oidc_subject TEXT UNIQUE,
  is_system    INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_token (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,
  user_id      INTEGER REFERENCES app_user(id),
  label        TEXT NOT NULL,
  is_service   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);
ALTER TABLE activity ADD COLUMN actor_user_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_activity_actor_user ON activity(actor_user_id);
`;

// Migration #10 — live agent sessions. Current-state (not history): one row per running
// agent, started on claim, updated by heartbeats/milestones, ended on submit/exit. A partial
// unique index keeps at most one *live* row per task. Deliberately NOT read by getVersion()
// (see version.ts) so frequent heartbeats never bump the board version → no full-board refetch
// thrash; the live surfaces poll /api/agents instead. `recent` is a small capped JSON feed.
export const MIGRATION_10_SQL = `
CREATE TABLE IF NOT EXISTS agent_session (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  label        TEXT,
  workspace    TEXT NOT NULL,
  stage        TEXT NOT NULL,
  phase        TEXT,
  phase_at     TEXT,
  recent       TEXT,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  started_at   TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  ended_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_session_live ON agent_session(task_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_agent_session_ended ON agent_session(ended_at);
`;

// Migration #11 — preserve the original description. The description stage rewrites
// spec/acceptance_criteria in place (ops/submitResult.ts), losing the human's original
// wording. These columns hold a one-time snapshot taken just before that first rewrite,
// so a finished task can still show what the human asked for. Nullable: implementation-only
// tasks (the common case) and legacy rows never get a description-stage rewrite, so they
// stay NULL and the UI shows no "Original description" section.
export const MIGRATION_11_SQL = `
ALTER TABLE task ADD COLUMN original_spec TEXT;
ALTER TABLE task ADD COLUMN original_acceptance_criteria TEXT;
`;

// Migration #12 — per-workspace engineering discipline. `policy` is free-text engineering
// standards injected into the worker claim payload and the reviewer prompt (a tunable,
// project-local "constitution"); `verify_command` is the command the implementation stage must
// run and pass before handoff (generalising the worker prompt's hardcoded npm test/build).
// Both nullable: existing workspaces backfill to "no policy / no command" and behave as today.
export const MIGRATION_12_SQL = `
ALTER TABLE workspace ADD COLUMN policy TEXT;
ALTER TABLE workspace ADD COLUMN verify_command TEXT;
`;

// Migration #13 — supervisor health + a small key/value store. `supervisor_heartbeat` is
// current-state (one row per supervisor, upserted by name each poll): it lets the board answer
// "is the loop alive?" without reading a console. Like agent_session it is DELIBERATELY NOT read
// by getVersion() (see version.ts) — a heartbeat every poll would bump the board version and
// thrash a full-board refetch; the health surface polls /api/supervisors instead. `app_kv` is a
// generic single-row-per-key store for small server state (the notifier's activity cursor),
// also outside getVersion().
export const MIGRATION_13_SQL = `
CREATE TABLE IF NOT EXISTS supervisor_heartbeat (
  name         TEXT PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('dispatcher','reviewer')),
  workspaces   TEXT NOT NULL DEFAULT '',
  in_flight    INTEGER NOT NULL DEFAULT 0,
  capacity     INTEGER NOT NULL DEFAULT 0,
  poll_seconds INTEGER,
  polls        INTEGER NOT NULL DEFAULT 0,
  version      TEXT,
  started_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;
