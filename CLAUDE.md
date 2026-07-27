# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

AgentFactory is a single-user local task board that serves as the **persistent state store + UI for an external agent loop**. The board never runs an agent itself — separate headless supervisors (`dispatcher`, `reviewer`) spawn `claude -p`/`codex` sessions that talk to the board over MCP, and a third supervisor (`watcher`) verifies delivery (PR merged + pipeline green) over plain REST. The board owns lifecycle rules, state, and review; the agents do the work.

## Commands

Requires **Node >= 26** (uses the built-in `node:sqlite`). All commands run from the repo root.

```bash
npm install
npm run build            # tsc -b across all packages + web client (Vite)
npm test                 # vitest run (whole workspace)
npm run test:watch
```

Run a single package's tests / a single file / by name:

```bash
npx vitest run packages/core/test/transitions.test.ts
npx vitest run -t "releases a stranded claim"
```

Running the services (each is its own process; point them all at the same DB):

```bash
npm run web:dev:server   # Hono API + SSE on :8787 (tsx, no build)
npm run web:dev          # Vite client on :5173, proxies /api + /events to :8787
npm run mcp:dev          # stdio MCP server (tsx)
npm run dispatcher -- dispatcher.config.json   # headless worker supervisor (build first)
npm run reviewer   -- reviewer.config.json     # headless AI-review supervisor (build first)
npm run watcher    -- watcher.config.json      # PR/pipeline delivery watcher (build first; needs GITHUB_TOKEN / AZDO_PAT)
npm run supervisors      # dispatcher + reviewer + watcher together (concurrently; build first)
npm run supervisors:dev  # same trio via tsx (no build)
```

The combined `supervisors`/`supervisors:dev` scripts spawn the three supervisors as separate child processes (colour-tagged output, one Ctrl-C stops all three; a crash in one leaves the others running). The watcher still needs `GITHUB_TOKEN` / `AZDO_PAT` set in the shell that launches them. The web server (:8787) is deliberately not part of the trio — it has its own lifecycle.

`*:dev` scripts run TypeScript directly via `tsx` (no build step). The non-dev scripts (`web`, `mcp`, `dispatcher`, `reviewer`, `watcher`, `supervisors`) run `dist/` and need `npm run build` first. **Long-lived processes (MCP sessions, the :8787 server) cache the build they started with** — rebuild `dist` *and* restart them after merging core/protocol changes, or new fields/tools go silently missing.

## Architecture

Six packages (`packages/*`), npm workspaces, TypeScript project references (`tsc -b`). Strict TS with `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`.

- **`core`** — the only package that touches the DB. `node:sqlite` (WAL) + all lifecycle rules. Everything else is an adapter over `createCore(db)` / `openCore(path)` (`src/index.ts`), which binds each op to a single DB handle. Business logic lives in `src/ops/*` (one file per operation), raw SQL in `src/repo/*`.
- **`mcp`** — stdio MCP server exposing board ops to agent loops (`src/tools/*`: `get_next_task`, `submit_result`, `report_progress`, etc.). Wraps core ops in the MCP protocol shape (`src/protocol.ts`).
- **`web`** — `server/` is a Hono API + SSE (`buildApp` in `server/app.ts`, routes in `server/routes/*`); `client/` is React/Vite. The client polls a cheap version string and refetches on change.
- **`dispatcher`** — polls the DB for `queued` tasks, spawns **one fresh `claude -p` session per task**, releases crashed/timed-out claims back to the queue. Config: `dispatcher.config.json`.
- **`reviewer`** — polls `in_review` tasks, spawns **one fresh codex/claude session per task** to post an advisory `ai-review/v1` verdict. Config: `reviewer.config.json`.
- **`watcher`** — polls `delivering` tasks and verifies delivery on the git host (GitHub/Azure DevOps REST — no LLM, no spawn): PR merged + checks green ⇒ `done`; CI failed / PR closed unmerged ⇒ back to `queued` with a `failure/v1` comment. Config: `watcher.config.json` (auth via `GITHUB_TOKEN` / `AZDO_PAT` env).

### Lifecycle is the core invariant

The task state machine is `packages/core/src/transitions.ts` — a small `TRANSITIONS` table keyed by `(from, to, by: 'human' | 'agent')`. Statuses: `backlog → queued → in_progress → in_review → delivering → done`, plus `blocked` and human-only edges (release a stranded claim, reopen a done task, force-complete/pull-back a delivering task). **Any new state edge goes here first**; ops call `assertTransition`. Agents can never delete or approve — those are human-only. Approving an implementation review routes to `delivering` when the workspace origin is a recognizable git host (`src/remote.ts`); the watcher owns `delivering → done/queued` (the only agent-actor path into `done`, and the MCP `update_status` tool refuses to touch delivering tasks — only the watcher's direct core access uses those edges).

### DB migrations

`packages/core/src/schema.ts` holds `SCHEMA_SQL` + numbered `MIGRATION_N_SQL` constants; `src/migrate.ts` applies them in order, gated on `PRAGMA user_version`. To change the schema: **append** a new `MIGRATION_N_SQL` and a new entry in the `MIGRATIONS` array — never edit an existing migration. Seed inserts (workspace #1, system user #1) use a fixed `1970` epoch `created_at` so they stay out of `getVersion()`'s change signal.

### The version / change-signal mechanism

`getVersion()` (`src/version.ts`) returns `"<max timestamp>#<task count>"` derived from max `updated_at`/`created_at` across task/activity/workspace/task_metric. The web client and MCP `getVersion` use it for cheap change detection. If you add a mutable table whose changes should trigger UI refresh, fold it into this query.

### Attribution & derived data

Most analytics/metrics/AI-review state is **derived from the activity log** (`src/repo/activity.ts`, `src/metrics.ts`, `src/ops/analyticsRows.ts`), not stored as denormalized columns — so it works retroactively. AI-review verdicts ride in comments parsed via the `ai-review/v1` marker convention (`src/aiReview.ts`); MCP payloads strip ai-review comments so uncurated findings never reach the implementing agent.

### Workspaces & worktrees

Tasks belong to a **workspace** (a named git repo path). A fresh DB has a single `default` workspace (`repoPath: "."`). Agents create a per-task worktree at `<repoPath>/.worktrees/<key>`. The convention for a task's branch is `feature/<key>-<kebab-title>` (`src/branch.ts`); the finish protocol pushes that branch to `origin` **before** `submit_result`, and the diff view computes against the merge-base with the default branch (`src/git.ts: branchDiff`/`resolveBaseRef`).

### Board mode: supervisors over HTTP (#46)

Each supervisor config takes **exactly one of** `db` (local SQLite, the historical mode) or `board` (the #45 agent-ops surface over authenticated HTTP) — the XOR lives in `packages/core/src/boardConfig.ts`, consumed by each package's `config.ts`. Board mode lets a supervisor run on any machine pointed at the board's URL, and ends N-writers-on-one-SQLite-file when used against localhost.

```jsonc
// dispatcher.config.json (board mode)
{
  "board": {
    "url": "http://boardhost:8787",
    "tokenEnv": "AF_DISPATCHER_TOKEN",   // or "token": "..." inline; default env: AGENTFACTORY_TOKEN
    "workerTokenEnv": "AF_WORKER_TOKEN"  // PLAIN service token injected into workers' MCP env
  },
  "repoPathOverrides": { "myworkspace": "C:\\clones\\myworkspace" }
}
```

- **Tokens** (`packages/web/server/mintToken.ts`): dispatcher + watcher need `npm run token -- --supervisor` (releaseClaim / delivery ops / PAT read are supervisor-gated); reviewer and the dispatcher's `workerToken` take a plain service token. Every supervisor `whoami`s at startup and fails fast on a wrong-capability token.
- **`repoPathOverrides`** maps a workspace to THIS machine's clone (absolute paths; asserted at startup). The dispatcher spawns workers there and forwards it to worker MCP servers as `AGENTFACTORY_REPO_PATH` (applies to the pinned workspace only); the reviewer diffs and the watcher resolves origins against it. Remote clones must use the **same HTTPS origin URL** as the board's clone — `resolveGitAuth`'s extraheader is computed board-side from the board's origin, and a mismatched origin silently falls back to ambient git credentials.
- **Worker MCP env**: the dispatcher writes all backend keys deterministically (`AGENTFACTORY_BOARD_URL`/`AGENTFACTORY_TOKEN` in board mode, `AGENTFACTORY_DB` in db mode, the unused ones as `''` — the MCP entry treats blank as unset, so inherited shell exports can't flip a worker's backend).
- **OTel**: point `otel.endpoint` at the board's `/v1/logs` so remote workers' token usage lands on the board.
- The reviewer's diff/fetch and the worker's push use the machine's **ambient git credentials** when no workspace PAT resolves — a remote machine needs its own credential for private origins.
- Board mode never runs migrations (`openCore` does; `createHttpCore` can't) — the board machine owns schema. The committed root configs stay db-mode.

## Testing notes

Vitest 2.x with a **workspace file** (`vitest.workspace.ts`) — each package has its own `vitest.config.ts` so the `node:sqlite` shim (core/mcp/web) and the jsdom env (web client) apply per project. Core/mcp/web configs resolve `node:sqlite` to a virtual module re-exporting the native builtin via CJS `require` (Vite misclassifies the prefixed builtin) — production code imports `node:sqlite` directly. Tests open in-memory/temp DBs via `test/helpers.ts`.

## Conventions

- Errors: core throws typed errors (`NotFoundError`, `InvalidTransitionError`, `ValidationError`, `GitError`); the web layer maps them to HTTP via `server/errors.ts`. Map new error types there rather than throwing HTTP from ops.
- Git: untrusted refs (agent-submitted link labels) are validated against `SAFE_REF` before reaching `git` — keep that guard on any new ref-handling path.
- Follow Conventional Commits and the PR-based flow. Commit locally; do not push or open PRs without an explicit ask.
