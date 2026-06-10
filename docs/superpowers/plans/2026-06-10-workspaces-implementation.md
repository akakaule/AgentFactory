# Workspaces — Implementation Plan

**Date:** 2026-06-10
**Spec:** [2026-06-10-workspaces-design.md](../specs/2026-06-10-workspaces-design.md)
**Status:** Proposed — awaiting approval

Five phases, dependency-ordered (`core → mcp → web server → web client → docs/e2e`).
Every behavioral task is TDD: write the failing test, watch it fail, implement, watch it
pass. Run the touched package's suite after each task; full `npm test` at each phase end.

---

## Phase 1 — core

### 1.1 Migration #2: workspace table + task.workspace_id

- **Files:** `packages/core/src/schema.ts` (add `MIGRATION_2_SQL` alongside the frozen
  `SCHEMA_SQL`), `packages/core/src/migrate.ts` (append to `MIGRATIONS`).
- **Tests first** (`packages/core/test/migrate.test.ts` or new `workspace.test.ts`):
  - fresh DB → `user_version = 2`, `workspace` table exists, one row
    `{name:'default', repo_path:'.'}` with `id = 1`;
  - simulate a v1 DB (run only migration #1, insert a task, then `runMigrations`) →
    task has `workspace_id = 1`;
  - re-running `runMigrations` is a no-op (idempotency via `user_version`).
- **Note:** seed insert uses `nowIso()` from the migration function (migrations are JS
  functions, not raw SQL — timestamp is fine).

### 1.2 Workspace repo + ops: `createWorkspace`, `listWorkspaces`

- **Files:** new `packages/core/src/repo/workspaces.ts`, new
  `packages/core/src/ops/createWorkspace.ts` + `ops/listWorkspaces.ts`,
  `validate.ts` (slug schema `[a-z0-9][a-z0-9-]*`, non-empty `repoPath`),
  `types.ts` (`Workspace`), `index.ts` (exports + `createCore` wiring).
- **Tests:** create → returned shape + listed; duplicate name → `ValidationError`;
  invalid slug (`'My Repo'`, `''`, uppercase) → `ValidationError`.

### 1.3 `createTask` takes `workspace` (slug, default `'default'`)

- **Files:** `types.ts` (`CreateTaskInput.workspace?`, `Task.workspace`),
  `validate.ts`, `ops/createTask.ts` (resolve slug → id inside the transaction; unknown
  slug → `NotFoundError`), `repo/tasks.ts` (JOIN workspace name into row mapping —
  `toTask`, `listRows`, `findByKey`, `findRowByKey` callers).
- **Tests:** default lands in `default`; explicit workspace honored; unknown slug rejected;
  every existing payload now carries `workspace: 'default'` (assert in one representative
  existing test; do not rewrite the suite).

### 1.4 Scoped claiming + filtered listing

- **Files:** `ops/claimNextTask.ts`, `repo/tasks.ts` (`nextQueued(workspaceId?)`),
  `ops/listTasks.ts`, `index.ts` (signatures `claimNextTask(workspace?)`,
  `listTasks({status?, workspace?})`).
- **Tests:** queue A1, B1, A2 (A/B workspaces) → claim(`A`) = A1 then A2, never B1;
  claim() with no filter = global FIFO (A1); claim(`A`) with nothing queued in A →
  `null` even though B has work; claim/list with unknown slug → `NotFoundError`.

### 1.5 `TaskDetail.repoPath` + `getVersion` includes workspaces

- **Files:** `types.ts`, the detail assemblers (`ops/getTask.ts`, `ops/claimNextTask.ts`,
  and the shared detail builder the ops use), `version.ts` (add
  `MAX(created_at) FROM workspace` to the union).
- **Tests:** claimed/fetched detail carries `repoPath` (`'.'` for default); creating a
  workspace bumps `getVersion()`.

**Phase gate:** `npx vitest run packages/core` green, then full `npm test` green
(mcp + web consume core types — fix any compile fallout *here*, not later).

---

## Phase 2 — mcp

### 2.1 `get_next_task` / `list_tasks` workspace param + env fallback

- **Files:** `packages/mcp/src/tools/getNextTask.ts` (inputSchema
  `{ workspace?: string }`), `tools/listTasks.ts`, `src/types.ts`/`server.ts` (thread an
  options object `{ defaultWorkspace?: string }` read from `AGENTFACTORY_WORKSPACE` in
  `index.ts` — keep `process.env` reads at the entry point, not in tools, for testability).
- **Resolution rule:** explicit param > env default > undefined (global).
- **Tests** (`packages/mcp/test/tools.test.ts` + harness): scoped claim returns only that
  workspace's tasks; env default applies when param omitted; param overrides env; unknown
  slug surfaces as a tool error (existing `toToolError` path).

### 2.2 Descriptions + README

- **Files:** `tools/getNextTask.ts` + `tools/submitResult.ts` descriptions (worktree now
  anchored at `<repoPath>/.worktrees/<key>`; `'.'` = agent cwd), `packages/mcp/README.md`
  (workspace section: pinning env, worker-per-workspace config example, roaming mode).
- **Tests:** extend the existing registry description test (`registry.test.ts`) to assert
  the description mentions the workspace repo path.

**Phase gate:** mcp suite green.

---

## Phase 3 — web server

### 3.1 Workspace routes + task route wiring

- **Files:** new `packages/web/server/routes/workspaces.ts` (`GET /`, `POST /`),
  `server/app.ts` (mount `/api/workspaces`), `server/schemas.ts` (workspace body zod:
  slug regex + non-empty repoPath; `listQuery` gains `workspace`; `createBody` gains
  optional `workspace`), `server/routes/tasks.ts` (pass-through), `server/errors.ts`
  (verify `ValidationError`/`NotFoundError` already map to 400/404 — expected no-op).
- **Tests first** (`packages/web/test/server/workspaces.test.ts` + extend
  `tasks.test.ts`): CRUD happy path; duplicate/invalid slug → 400; create task with
  workspace → appears under `?workspace=` filter and not under the other; unknown
  workspace filter → 404.

**Phase gate:** web server tests green.

---

## Phase 4 — web client

### 4.1 API client + types

- **Files:** `client/src/types.ts` (mirror `Workspace`, `Task.workspace`,
  `TaskDetail.repoPath`), `client/src/api.ts` (`fetchWorkspaces`, `createWorkspace`,
  task create/list accept workspace).

### 4.2 Task form picker + board filter + badges

- **Files:** `components/TaskForm.tsx` (dropdown; hidden when only one workspace),
  `App.tsx`/`useTasks.ts` (filter state → `?workspace=`), `views/BoardView.tsx` +
  `views/GroupedList.tsx`/`TaskRow.tsx` (badge when ≥ 2 workspaces),
  `components/DetailPanel.tsx` (workspace + repoPath line), plus a minimal workspace
  create affordance (small section or modal — follow existing component idiom).
- **Tests** (Testing Library, mirroring existing component tests): form submits chosen
  workspace; filter narrows rendered tasks; badge hidden at 1 workspace / shown at 2;
  workspace create form posts and refreshes the list.

**Phase gate:** client tests green; manual smoke via `npm run web:dev:server` + `web:dev`.

---

## Phase 5 — e2e + docs

### 5.1 Multi-workspace e2e loop

- **Files:** extend `packages/web/test/server/e2e.loop.test.ts` (or sibling
  `e2e.workspaces.test.ts`): two workspaces, tasks in each, two simulated scoped workers
  over the shared DB → no cross-claims, both reach `done`; spec acceptance criterion #6.

### 5.2 Docs

- **Files:** root `README.md` (workspace quick-start), `docs/agent-flow.html`
  (workspace badge in the story: step 1 mentions picking a workspace, step 3 claims with
  the workspace filter and creates the worktree under `repoPath`), spec/plan status flips
  to "Implemented".

**Final gate:** full `npm test` green; `npm run build` clean; manual two-workspace
walkthrough in the browser.

---

## Risks / watch-outs

- **`repo/tasks.ts` JOIN fan-out (task 1.3)** is the widest-reaching edit — every task
  payload shape changes. Doing it early in core and fixing all compile errors at the
  Phase 1 gate keeps the blast radius contained.
- **SQLite `ALTER TABLE ... NOT NULL`** requires the `DEFAULT 1`; correctness rests on the
  seeded row being `id = 1` (guaranteed: first insert into a fresh table in the same
  transaction). The migration test asserts it explicitly.
- **Client `types.ts` drift:** types are mirrored, not imported, in the client — update
  both or the client silently lags (existing repo convention; keep it).
- Estimated touch: ~12 source files + ~8 test files across 3 packages; no dependency
  additions.
