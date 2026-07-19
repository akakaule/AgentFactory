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

// Migration #15 — per-task agent transcript. The dispatcher captures the running `claude -p`
// session's raw JSONL (tailing it live, then persisting the whole thing at exit) so the drawer
// can show what the agent actually *did*, not just its milestones — and so a finished/stranded/
// failed task stays reviewable after its worktree is pruned. One row per (task, attempt): while
// the session runs it holds a capped rolling `live_buf` (state 'live'); at exit `raw_gz` gets the
// gzipped full transcript and `live_buf` is cleared (state 'final'). `bytes` is the uncompressed
// size (UI badge + guardrail); `format` tags the codec for forward compatibility. Like
// agent_session (#10) and supervisor_heartbeat (#13) it is DELIBERATELY NOT read by getVersion()
// (see version.ts): live appends arrive faster than heartbeats and must never bump the board
// version / trigger a full-board refetch — the open drawer polls /api/tasks/:key/transcript instead.
export const MIGRATION_15_SQL = `
CREATE TABLE IF NOT EXISTS task_transcript (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  attempt     INTEGER NOT NULL DEFAULT 1,
  session_id  TEXT,
  engine      TEXT NOT NULL DEFAULT 'claude',
  format      TEXT NOT NULL DEFAULT 'claude-jsonl-gz',
  raw_gz      BLOB,
  live_buf    TEXT,
  bytes       INTEGER,
  state       TEXT NOT NULL DEFAULT 'live' CHECK (state IN ('live','final')),
  started_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_transcript_task_attempt ON task_transcript(task_id, attempt);
`;

// Migration #16 — the change visualization: one self-contained HTML overview per task (Mermaid
// flow + file map, the `/visualize-change` treatment), attached during review so a human gets a
// visual read of the diff next to the description. Stored gzipped like task_transcript (#15); one
// row per task (latest attach replaces). UNLIKE the transcript it IS folded into getVersion() (see
// version.ts): an attach is a once-per-review event, not a high-frequency stream, so bumping the
// board version is safe and makes the drawer's button appear live. `bytes` is the uncompressed
// HTML size (UI badge); `format` tags the codec for forward compatibility.
export const MIGRATION_16_SQL = `
CREATE TABLE IF NOT EXISTS task_visualization (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id      INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  format       TEXT NOT NULL DEFAULT 'html-gz',
  html_gz      BLOB NOT NULL,
  bytes        INTEGER NOT NULL,
  generated_at TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_visualization_task ON task_visualization(task_id);
`;

// Migration #17 — task kind: 'code' (the default — an agent-implemented feature, today's only shape)
// vs 'pr-review' (review a teammate's GitHub PR; the deliverable is the review, not code). Additive
// and defaulted so every existing row is 'code' and behaves exactly as before. The kind has no axis
// in the transition table (transitions.ts) — ops/updateStatus.ts gates the kind-specific edges
// (a 'pr-review' task is born straight into in_review and is never claimed for implementation).
export const MIGRATION_17_SQL = `
ALTER TABLE task ADD COLUMN kind TEXT NOT NULL DEFAULT 'code' CHECK (kind IN ('code','pr-review'));
`;

// Migration #18 — the 'delivering' lifecycle state + PR/CI delivery tracking. Approving an
// implementation-stage review no longer means "done": when the task's workspace has a
// recognizable GitHub/Azure-DevOps origin, approve routes to 'delivering' and the watcher
// supervisor completes it to 'done' only once the PR is merged and the pipeline is green
// (or bounces it back to 'queued' with a failure/v1 comment). Widening the status CHECK
// (and supervisor_heartbeat.kind for the new watcher) requires a table rebuild — SQLite
// cannot ALTER a CHECK — which lives in migrate.ts as a data-driven rebuild (it must not
// enumerate columns: a diverged DB may carry extras this repo's history doesn't know about).
// Only `task_delivery` is plain SQL: current-state per task (like agent_session #10), seeded
// at approve, updated by the watcher's polls. Like #10/#13 it is DELIBERATELY NOT read by
// getVersion(): a poll every minute must not thrash the board version — ops bump
// task.updated_at only when the *observed state changes* (rare), which is what refreshes the UI.
export const MIGRATION_18_SQL = `
CREATE TABLE IF NOT EXISTS task_delivery (
  task_id          INTEGER PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL CHECK (provider IN ('github','azdo')),
  branch           TEXT NOT NULL,
  pr_url           TEXT,
  pr_id            TEXT,
  pr_state         TEXT NOT NULL DEFAULT 'unknown' CHECK (pr_state IN ('unknown','not_found','open','merged','closed')),
  checks_state     TEXT NOT NULL DEFAULT 'unknown' CHECK (checks_state IN ('unknown','none','pending','passing','failing')),
  detail           TEXT,
  checked_at       TEXT,
  state_changed_at TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
`;

// Migration #19 — per-workspace git PAT. A credential the board owns (set in the UI) for the
// workspace's git host, so rotating an expired token is an edit in the board rather than a
// hand-edit of the repo's embedded-in-origin-URL credential. Nullable: unset = fall back to the
// env vars (<BASE>_<WORKSPACE> then <BASE>) exactly as before. Write-only over the API — the
// value never leaves core (see toWorkspace, which exposes only a `hasPat` boolean). Consumed by
// the worker's git (dispatcher injects it as an http.extraheader), the submit-verify (mcp
// checkSubmission), and the watcher's REST — all via resolveGitAuth / getWorkspacePat.
export const MIGRATION_19_SQL = `
ALTER TABLE workspace ADD COLUMN pat TEXT;
`;

// Migration #20 — per-workspace agent system-prompt overrides. A JSON map { <agent-prompt-key>: text }
// layered over the global defaults (app_kv, key 'agent_prompts'); effective prompt = override ?? global
// ?? '' (see agentPrompts.ts). Nullable: existing workspaces inherit the globals and behave as today.
export const MIGRATION_20_SQL = `
ALTER TABLE workspace ADD COLUMN prompt_overrides TEXT;
`;

// Migration #21 — directed task dependencies. A row (task_id, depends_on_task_id) means the
// first task cannot be claimed until the second task is done. The graph and lifecycle rules are
// enforced by the core operation; the table itself provides endpoint integrity, uniqueness,
// self-link defense in depth, and automatic cleanup when either task is deleted.
export const MIGRATION_21_SQL = `
CREATE TABLE IF NOT EXISTS task_dependency (
  task_id            INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS idx_task_dependency_reverse ON task_dependency(depends_on_task_id);
`;
