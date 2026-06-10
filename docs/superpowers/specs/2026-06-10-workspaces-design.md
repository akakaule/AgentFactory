# AgentFactory — Workspaces (multi-repo task board)

**Date:** 2026-06-10
**Status:** Proposed — awaiting approval
**Grows from:** [2026-06-09 task board design](2026-06-09-agent-loop-task-board-design.md), which deferred "Projects or multiple boards (v1 is one flat board)". This is that growth, motivated by a concrete execution problem rather than board organization.

## Problem

A task has no notion of which git repository it targets. The only place a repo can be
named today is free text in `spec`, and `claimNextTask` is a single global FIFO
(`SELECT * FROM task WHERE status='queued' ORDER BY seq ASC LIMIT 1`). Consequences
when tasks for different repos coexist:

- A worker launched for repo A claims whatever is oldest — possibly a repo-B task. The
  claim happens **before** the agent reads the spec, and there is no un-claim transition;
  the only escape is `blocked` + human rescue.
- An agent runtime's filesystem access is scoped to one repo (cwd, permissions). A
  wrong-repo claim either fails or silently violates that scoping.
- The worktree convention ("create a worktree in the repository you will modify") has no
  authoritative answer to *which repository that is*.

The only clean multi-repo arrangement today is one DB + web server + worker per repo —
workable, but there is no unified board, which defeats the tool's purpose.

## Goals

- A task belongs to exactly one **workspace**; a workspace names a git repository (or any
  working directory) where its tasks are executed.
- An agent worker can claim work **scoped to a workspace**, so a worker launched for repo A
  can never claim repo-B work.
- The claimed task carries the workspace's repo path, making the worktree convention
  concrete and machine-readable.
- Existing single-repo setups keep working with zero configuration (a seeded `default`
  workspace preserves today's behavior exactly).

## Non-Goals (deferred)

- Per-workspace key prefixes (`WEB-12` vs `AF-12`) — keys stay global `AF-n`; touching
  keygen/uniqueness is churn with no execution value.
- Workspace deletion / archival — tasks reference workspaces; removal needs archival
  semantics. Not needed for v1.
- Per-workspace default branch, pause/resume, or board-level separation (the board stays
  one board with a filter, not N boards).
- Multi-machine concerns. Single user, local, as before.
- The `in_progress` crash-recovery gap (no human transition out of `in_progress`) — real,
  adjacent, and **separate**; workspace scoping reduces wrong-claims but does not fix
  stranded claims. Tracked as its own future change.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Representation | **First-class `workspace` entity** (table), not a text column on task | Path lives in one place; renames/moves are one-row edits; UI gets a real picker; validation is structural. A `repo_path` column per task duplicates state and makes the dropdown a `DISTINCT` scan. |
| Workspace identity at API boundaries | **Slug name** (`^[a-z0-9][a-z0-9-]*$`, max 64 chars), unique | Human-typeable in env vars / loop prompts / MCP params; ids stay internal. |
| `repo_path` semantics | Absolute path recommended; **`'.'` means "the agent's cwd"** | `'.'` is the back-compat value for the seeded `default` workspace — exactly today's behavior, where the agent works wherever it was launched. The board never touches the path itself (it's data, not config); only agents resolve it. No fs-existence validation server-side. |
| Backfill | Migration seeds `default` workspace (`repo_path '.'`), all existing tasks get `workspace_id` of that row; column is `NOT NULL` | Every task always has a workspace; no nullable special case threaded through queries and UI. |
| FK enforcement for `task.workspace_id` | **App-level — no `REFERENCES` clause on the added column** | With `foreign_keys = ON` (set in `openDb`), SQLite rejects `ALTER TABLE ... ADD COLUMN` combining `REFERENCES` with a non-NULL default, and the pragma is a no-op inside the migration's transaction. `createTask` resolves slug → id in-transaction (unknown slug → `NotFoundError`) and workspace deletion is a non-goal, so no dangling-id path exists. |
| Claim scoping | `claimNextTask(workspace?)`: with a slug → FIFO **within** that workspace; without → global FIFO (today's behavior) | Scoped workers and a "roaming" worker both stay expressible. |
| Unknown workspace on claim/filter | **Throw `NotFoundError`** | A typo'd worker config should fail loudly, not idle forever on an empty-looking queue. |
| MCP worker pinning | Optional env **`AGENTFACTORY_WORKSPACE`** on the MCP server = default for `get_next_task`/`list_tasks` when the param is omitted; explicit param overrides | Deploy-time intent lives in the worker's MCP config next to `AGENTFACTORY_DB`; the agent cannot forget to scope itself. Override stays possible because the env is a default, not an ACL — this is a single-user tool. |
| Task payload shape | `Task` gains `workspace: string` (slug); `TaskDetail` additionally gains `repoPath: string` | List rows need the badge/filter value; only the full detail (what the agent reads at claim) needs the path. |
| Task creation | `CreateTaskInput.workspace?: string`, defaulting to `'default'` | Web UI always sends one; the default keeps API back-compat and tests simple. |
| Task workspace immutable after creation | Yes (no `workspace` in `UpdateTaskInput`) | Moving a task between repos mid-flight invalidates worktrees/branches/links. Recreate instead. Revisit if it ever hurts. |

## Data model

Migration **#2** (the `PRAGMA user_version` mechanism in `migrate.ts` is built for this;
migration #1 / `SCHEMA_SQL` stays frozen):

```sql
CREATE TABLE workspace (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,      -- slug: ^[a-z0-9][a-z0-9-]*$, max 64 chars
  repo_path  TEXT NOT NULL,             -- absolute path, or '.' = agent cwd
  created_at TEXT NOT NULL
);
INSERT INTO workspace(name, repo_path, created_at) VALUES ('default', '.', :now);
ALTER TABLE task ADD COLUMN workspace_id INTEGER NOT NULL DEFAULT 1;  -- no REFERENCES, see below
CREATE INDEX idx_task_workspace ON task(workspace_id, status, seq);
```

- The seeded row is the first insert into a fresh table inside the same transaction, so
  `id = 1` is guaranteed; `DEFAULT 1` exists **only** as the backfill mechanism for
  pre-existing rows. `createTask` always sets `workspace_id` explicitly from this point on.
- The added column deliberately has **no `REFERENCES workspace(id)` clause**: `openDb`
  sets `PRAGMA foreign_keys = ON`, and SQLite rejects `ALTER TABLE ... ADD COLUMN`
  combining a `REFERENCES` clause with a non-NULL default ("Cannot add a REFERENCES
  column with non-NULL default value" — verified against `node:sqlite`). Toggling the
  pragma off is not an option either: it is a no-op inside a transaction, and
  `runMigrations` wraps each migration in `BEGIN IMMEDIATE`. Referential integrity is
  app-level instead — `createTask` resolves slug → id inside its transaction, and
  workspace deletion is a non-goal, so a dangling `workspace_id` has no code path.
- `getVersion()` (the SSE change-detection probe) adds `workspace.created_at` to its
  `MAX(...)` union so workspace creation refreshes connected clients.

## Core API surface

```ts
interface Workspace { id: number; name: string; repoPath: string; createdAt: string; }

interface Task { /* existing */ workspace: string; }          // slug, via JOIN
interface TaskDetail extends Task { /* existing */ repoPath: string; }

interface CreateTaskInput { title; spec; acceptanceCriteria; workspace?: string; } // default 'default'

createCore(db) gains:
  createWorkspace(input: { name: string; repoPath: string }): Workspace   // dup name → ValidationError
  listWorkspaces(): Workspace[]
  listTasks(opts: { status?: Status; workspace?: string })
  claimNextTask(workspace?: string)
```

## MCP surface

- `get_next_task` input gains `{ workspace?: string }`; falls back to
  `AGENTFACTORY_WORKSPACE` env; absent both → global claim. Payload now includes
  `workspace` and `repoPath`.
- `list_tasks` gains the same optional `workspace` filter (same env fallback).
- Tool descriptions updated: the worktree is created **under the task's workspace repo** —
  `<repoPath>/.worktrees/<task-key>` (branch `task/<task-key>`); when `repoPath` is `'.'`,
  that resolves against the agent's cwd (today's behavior).
- **No workspace-creation tool.** Like task creation, workspace creation is human-only.

Worker config example (worker-per-workspace):

```json
{
  "mcpServers": {
    "agentfactory": {
      "command": "node",
      "args": ["c:\\Git\\AgentFactory\\packages\\mcp\\dist\\index.js"],
      "env": {
        "AGENTFACTORY_DB": "c:\\Git\\AgentFactory\\agentfactory.db",
        "AGENTFACTORY_WORKSPACE": "shopfloor"
      }
    }
  }
}
```

## Web surface

- **Server:** `GET /api/workspaces`, `POST /api/workspaces` (zod: slug regex, non-empty
  `repoPath`); `GET /api/tasks?workspace=<slug>` filter; `POST /api/tasks` passes
  `workspace` through. SSE mechanism unchanged (version-probe refetch covers it).
- **Client:**
  - Task form: workspace dropdown (defaults to `default`; remembers last choice in
    component state — no persistence ceremony).
  - Board/list: workspace filter control ("All" + one per workspace) and a workspace badge
    on rows/cards — badge and filter hidden while only one workspace exists, so the v1
    single-repo experience is visually unchanged.
  - Detail panel: workspace name + repo path.
  - Minimal "Workspaces" management affordance (list + create form; no edit/delete in v1).

## Execution topologies enabled

1. **Worker-per-workspace (recommended default):** each agent loop launches in its repo
   with `AGENTFACTORY_WORKSPACE` pinned in its MCP config. Clean permission boundary;
   parallel workers across repos are safe (claim is atomic; work is isolated per worktree).
2. **One roaming worker:** no pin; claims globally, reads `repoPath` off the claimed task
   and works there. Requires the session to have filesystem access to every workspace
   (`--add-dir` or equivalent). Acceptable single-user mode; not the recommended posture.

## Acceptance criteria (feature-level)

1. Fresh DB: migration yields `user_version = 2`, a `default` workspace, and unchanged
   behavior for all existing flows (full test suite green; existing tests may need
   minimal payload-shape touch-ups for the new `workspace` field, but no behavioral
   rewrites).
2. Existing v1 DB: opening it migrates in place; all pre-existing tasks belong to
   `default`; nothing else changes.
3. Two workspaces with queued tasks: a worker claiming with `workspace: A` only ever
   receives A's tasks, in FIFO order; a claim with an unknown slug fails loudly.
4. A claimed task's detail (MCP payload) carries `workspace` and `repoPath`.
5. Web UI can create a workspace, create a task in it, filter the board by it, and the
   badge appears only when ≥ 2 workspaces exist.
6. The e2e feed-and-follow-up test extended: two workspaces, two scoped "workers", no
   cross-claims, both loops complete to `done`.
