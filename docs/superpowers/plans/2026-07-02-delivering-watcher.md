# `delivering` state + PR/CI watcher supervisor (+ remote-execution design)

## Context

Today a task is `done` the moment a human approves the review — the board never learns whether the PR actually merged or the pipeline passed. The user wants "fully completed" to mean **PR merged AND pipeline green**, verified automatically. Decisions made with the user:

- **New `delivering` status** between `in_review` and `done`: human approve → `delivering`; a new **watcher supervisor** (pure REST poller, no LLM) auto-completes to `done` on merged+green, or bounces back to `queued` with a failure comment on CI-failure/PR-closed.
- **GitHub + Azure DevOps** providers from day one, behind one interface, detected from the workspace's `origin` URL.
- **Remote execution (Azure Container Apps Sandboxes)** is a *design section only* in this plan — nothing built now may block it; implementation is a follow-up.

Existing hooks this builds on: `link` kind `'pr'` (schema), `task.branch` (migration #6), `done → queued` reopen edge ("e.g. CI failed on the PR"), `failure/v1` marker comments, `supervisor_heartbeat`, and the unmerged `feat/auto-open-github-pr` branch (finish protocol opens a GitHub PR and attaches a `pr` link, PROTOCOL_VERSION 5→6). Nothing anywhere checks CI today — that part is greenfield. ado-bridge's `Invoke-PrCompletionPass` / `Build-AdoPrSearchPath` (`c:\git\ado-bridge\lib\AdoApi.ps1`) is the ADO PR-search reference to port.

## Prerequisites / rollout order (do first)

1. **Merge `feat/pr-review-tasks`** (holds migration #17, `task.kind`). Our migration is a full `task`-table rebuild that must enumerate every column — landing after #17 means the rebuild safely includes `kind`. Slot for this feature: **#18** (announce in PR; next branch takes #19).
2. **Merge `feat/auto-open-github-pr`** (agents attach authoritative `pr` links at finish). Watcher falls back to search-by-branch, but GitHub reliability is much better with the link. Rebuild dist + restart MCP/:8787 after these merges (repo convention).
3. Branch for this feature: **`feat/delivering-watcher`**.

## Part 1 — Migration #18 (`packages/core/src/schema.ts` + `migrate.ts`)

The status CHECK lives inside `CREATE TABLE task` (schema.ts:8-9); SQLite can't ALTER a CHECK → **table rebuild**. Critical hazard: `openDb` sets `PRAGMA foreign_keys=ON`, and 7 child tables cascade on task delete — `DROP TABLE task` with FK on would wipe all history.

- **`migrate.ts`: add an FK-off migration mode.** Widen the `MIGRATIONS` entry type to `((db)=>void) | { fkOff: true; run: (db)=>void }`. For fkOff entries: `PRAGMA foreign_keys = OFF` (outside the transaction — it's a no-op inside), run the rebuild in one transaction, run `PRAGMA foreign_key_check` before commit (throw if non-empty), restore `foreign_keys = ON` in a finally.
- **Rebuild `task`** with status CHECK widened to include `'delivering'`: `CREATE TABLE task_new (…all 21 columns incl. kind…)` → `INSERT INTO task_new (explicit column list) SELECT … FROM task` → `DROP TABLE task` → `RENAME` → recreate the four `idx_task_*` indexes (dropped with the table). No triggers/views exist.
- **Rebuild `supervisor_heartbeat`** widening `kind` CHECK to `('dispatcher','reviewer','watcher')` (same pattern, no children).
- **New `task_delivery` table** (current-state, like `agent_session` — PR/CI state is external+mutable, not a board event, so persisting beats derive-from-activity here):
  ```sql
  CREATE TABLE IF NOT EXISTS task_delivery (
    task_id  INTEGER PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('github','azdo')),
    branch   TEXT NOT NULL,
    pr_url TEXT, pr_id TEXT,
    pr_state     TEXT NOT NULL DEFAULT 'unknown' CHECK (pr_state IN ('unknown','not_found','open','merged','closed')),
    checks_state TEXT NOT NULL DEFAULT 'unknown' CHECK (checks_state IN ('unknown','none','pending','passing','failing')),
    detail TEXT, checked_at TEXT, state_changed_at TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  ```
  **Not** folded into `getVersion()`; instead ops `touch(task)` only when observed state *changes* (per-poll `checked_at` never thrashes the version signal).
- **Self-guarding** (slot-collision precedent #14): skip task rebuild if `sqlite_master.sql` for `task` already contains `'delivering'`; skip heartbeat rebuild if it contains `'watcher'`; `IF NOT EXISTS` on `task_delivery`.

## Part 2 — Core changes (`packages/core`)

- **`src/types.ts`**: `Status` += `'delivering'`; `SupervisorKind` += `'watcher'`; new `DeliveryProvider`, `DeliverySummary`; `Task.delivery: DeliverySummary | null` (batched into `listRows`/`toDetail` like `aiReview`).
- **`src/transitions.ts`** — five new edges:
  ```
  in_review  → delivering  by human   (approve routes here)
  delivering → done        by agent   (watcher: merged + green)
  delivering → queued      by agent   (watcher: CI failed / PR closed)
  delivering → done        by human   (force-complete: no CI / watcher down)
  delivering → queued      by human   (manual pull-back)
  ```
- **`src/remote.ts` (new)** — the *only* local-git touch, isolated for later remote deployment:
  - `parseRemoteUrl(url): RemoteRef | null` — pure classifier: GitHub https/ssh/scp forms; ADO `dev.azure.com/{org}/{proj}/_git/{repo}`, `{org}.visualstudio.com`, `git@ssh.dev.azure.com:v3/...`.
  - `resolveOriginUrl(repoPath): string | null` — `git remote get-url origin`, try/catch → null. Future remote mode swaps this for a `workspace.origin_url` column without touching callers.
- **Approval routing** (`ops/reviewApprove.ts` + `ops/approval.ts`): at approve time, if `stage==='implementation' && branch !== null && kind==='code'` and `parseRemoteUrl(resolveOrigin(repoPath))` recognizes a provider → `setStatus('delivering')` + seed `task_delivery` (`beginDelivery`, INSERT OR REPLACE so re-approval resets state); otherwise **straight to `done` exactly as today** (doc stages, legacy no-branch tasks, unrecognizable remotes, pr-review kind). Resolver injected as a param with `resolveOriginUrl` default (testable). `applyApproval` gains a trailing optional `delivery` param — the `addComment` doc-stage auto-approve callsite stays untouched.
- **`ops/delivery.ts` + `repo/delivery.ts` (new)**:
  - `recordDeliveryCheck(key, observed)` — update row + `checked_at`; bump `state_changed_at` + `touch(task)` only on change; no-op unless status is `delivering`.
  - `completeDelivery(key, note)` — transaction: `assertTransition(…,'done','agent')`, setStatus, activity note ("PR #42 merged; checks green"). Idempotent: second call throws `InvalidTransitionError` (watcher catches).
  - `failDelivery(key, {reason:'ci_failed'|'pr_closed', detail, body})` — **one transaction**: failure comment + `assertTransition(…,'queued','agent')` + setStatus (comment and requeue must not tear).
  - Bind all into `createCore` (watcher consumes `Core` like the dispatcher does).
- **Failure comments: reuse `failure/v1`** (not a new marker) — gets FailureBanner/Chip rendering, analytics, and claim-payload passthrough (next agent session reads why it bounced) for free. Additive changes in `src/failure.ts`: reasons += `'ci_failed','pr_closed'`; make `attempt/maxAttempts` optional in `buildFailureComment`. Body includes PR URL, failing check names + run URLs, and "fix the failures and push to the SAME branch — do not open a new PR."

## Part 3 — Watcher package (`packages/watcher`, new)

Mirrors dispatcher shape minus all spawn/session machinery. Files: `src/index.ts` (DI: loadConfig, openCore, real fetch, signal handling), `src/config.ts` (zod), `src/watcher.ts` (Watcher class: start/stop/safeTick/tick), `src/types.ts` (`WatcherDeps`: core, fetchJson, resolveOrigin, env, now — all injected), `src/providers/{types,github,azdo,detect}.ts`.

- **Config** (`watcher.config.json` at repo root): `db`, `name='watcher'`, `workspaces[]`, `pollSeconds=60`, `postMergeChecks=false`, `maxBackoffSeconds=900`, `github:{tokenEnv:'GITHUB_TOKEN', apiBase}`, `azdo:{patEnv:'AZDO_PAT', apiVersion:'7.1'}`.
- **GitHub provider — REST with GITHUB_TOKEN** (not `gh`: long-lived poller wants rate-limit headers, no per-poll process spawn, no `gh auth` host dependency): PR via `pr` link's `/pull/N` → `GET /repos/{o}/{r}/pulls/{n}`; fallback search `GET /repos/{o}/{r}/pulls?head={o}:{branch}&state=all&sort=updated`. Checks: `commits/{sha}/check-runs` + `commits/{sha}/status` combined (any failure/timed_out/cancelled/action_required → failing; queued/in_progress → pending; none → `none`).
- **ADO provider** (port of ado-bridge shape): `_apis/git/repositories/{repo}/pullrequests?searchCriteria.sourceRefName=refs/heads/{branch}&searchCriteria.status=all&$top=5&api-version=7.1` (completed→merged, abandoned→closed, active→open); checks via `pullRequests/{id}/statuses`. Auth: `Basic base64(":"+PAT)`, scope **Code (Read)** only.
- **"Pipeline green" default = pre-merge PR checks** (merged AND head checks not red; `none` counts as green so check-less repos flow). `postMergeChecks: true` additionally waits for green check-runs on the merge commit.
- **Tick**: heartbeat (`kind:'watcher'`) → list `delivering` tasks in configured workspaces → per task: skip if backing off → `provider.check(...)` → `recordDeliveryCheck` → merged+green ⇒ `completeDelivery`; closed-unmerged ⇒ `failDelivery('pr_closed')`; checks failing ⇒ `failDelivery('ci_failed')`; open+pending ⇒ record only. Per-task exponential backoff on errors; global pause on GitHub `x-ratelimit-remaining < 5` / 429. Races with humans resolve via `InvalidTransitionError` catch. Self-heal: a `delivering` task with no `task_delivery` row (raw drag) gets seeded via the resolver, or warned once if unrecognizable.

## Part 4 — Web + MCP + wiring

- **Server**: `server/schemas.ts` `StatusEnum` += `'delivering'` (human overrides via existing `POST /:key/status`; list filter). No new routes — `delivery` rides `Task`/`TaskDetail`.
- **Client** (the compiler forces most of these via `Record<Status,…>`):
  - `src/status.ts`: `LIFECYCLE_ORDER` insert after `in_review`; label `Delivering`; color teal `#2DD4BF`. Full board column between In Review and Done.
  - `views/BoardView.tsx`: `HUMAN_MOVES.delivering = ['queued','done']` (drag = override edges; approve owns `in_review→delivering`).
  - `views/ListView.tsx`: `STATUS_PRIORITY` slot for delivering.
  - New `components/DeliveryChip.tsx` (PR state · checks state, linked to PR) on TaskCard + DetailPanel; DetailPanel adds "Mark done" / "Re-queue" mini-buttons + "last checked …".
  - `components/ReviewActions.tsx`: approve label becomes `Approve → deliver` when `stage==='implementation' && branch != null`.
- **MCP**: `mcp/src/schemas.ts` `StatusEnum` += `'delivering'`; `update_status` uses a move-enum **without** delivering + runtime guard ("this task is in delivery — the watcher owns it"). `get_next_task` (queued-only) and `submit_result` (in_progress-only) need no change.
- **Root wiring**: workspaces += `packages/watcher`; scripts `watcher` / `watcher:dev`; tsconfig reference; `vitest.workspace.ts` entry; `watcher.config.json`; README/CLAUDE.md service list.

## Part 5 — Tests

- `core/test/transitions.test.ts`: five new valid edges + invalid (`in_review→delivering` by agent, `delivering→in_review`, …).
- `core/test/remote.test.ts` (new): URL-classifier fixtures (both hosts, all forms, non-matching → null).
- `core/test/reviewApprove.test.ts`: routing matrix — GitHub origin→delivering+seeded row; no branch→done; unrecognizable origin→done; doc stages unchanged; re-approve resets delivery row. Add `'delivering'` to invalid-status `it.each` lists in submitResult/reviewRequestChanges/archiveTask tests.
- `core/test/delivery.test.ts` (new): version bumps only on state change; completeDelivery idempotency; failDelivery posts exactly one parseable `failure/v1` comment and requeues.
- `core/test/migrate.test.ts`: rebuild preserves children (activity/links/attachments intact, `foreign_key_check` empty, indexes recreated), `'delivering'` accepted, `'watcher'` heartbeat accepted, re-run is a no-op.
- `watcher/test/*`: tick matrix with mocked deps (merged+green→done; failing→queued+one comment; pending→record only; provider throw→backoff; rate-limit pause; self-heal), provider fixture-JSON parsers.
- `web`/`mcp` tests: status filter + overrides, board column render, update_status guard.

## Part 6 — Remote execution on Azure Container Apps Sandboxes (DESIGN ONLY — no code this branch)

Goal: run implementation-stage agent sessions off-box (ACA Sandboxes: microVM isolation, OCI images, sub-second start, suspend/resume, exec/file APIs on the `management.azuredevcompute.io` data plane, egress policies; preview, Entra-only, SDKs "coming soon").

What today pins execution locally, and the designed seams (aligns with `docs/expansion-roadmap.md` Phase 6–7):

1. **Claim/submit is stdio-MCP + direct SQLite** — the blocker. Design: `createHttpCore(baseUrl, token)` implementing the same `Core` interface over authenticated REST, handed to the **unchanged** MCP `buildServer` (tools never touch the DB directly → drop-in). Requires new web routes for the agent ops (claim/submit/comment/progress) authenticated with existing `api_token` service tokens (`is_service`, already on main). Claim atomicity stays server-side.
2. **Dispatcher spawn is `cwd = workspace.repoPath`** — already fully abstracted behind `deps.spawn` (`packages/dispatcher/src/types.ts`). Design: an alternative spawn implementation that (a) creates/resumes an ACA sandbox from a prebaked image (git + node + claude CLI), (b) execs the same argv with `AGENTFACTORY_*` env pointing MCP at the HTTP core, (c) clones the repo via the provider URL inside the sandbox (worktrees become plain clones — the protocol's worktree steps generalize to a `checkout` step computed per execution profile), (d) egress policy allowlisting the git host + api.anthropic.com + the board URL.
3. **`checkSubmission` / diff stay runner-side**: sandbox pushes the branch to origin before submit (same AF-15 contract); board's diff view already computes from origin refs via merge-base.
4. **This branch keeps the door open** by: isolating origin-URL resolution in `core/src/remote.ts` (swap for a `workspace.origin_url` column later), and the watcher being pure DB+REST (no local git) — it runs anywhere the DB (later: HTTP core) is reachable.

Sequencing (matches GitHub issues #31/#41/#42): auth/claim-token hardening → HTTP core surface → ACA spawn profile. Not before ACA Sandboxes exits Entra-gated preview or the SDK stabilizes.

## Verification

1. `npm run build && npm test` — full workspace green.
2. Migration proof: copy the live `agentfactory.db` to scratch, open with new core → `PRAGMA user_version` = 18, `foreign_key_check` empty, task/activity counts unchanged, `UPDATE task SET status='delivering' WHERE id=<test>` accepted.
3. End-to-end (GitHub): queue a trivial task in a GitHub-origin workspace → dispatcher runs it → PR opened at finish → approve on the board → task lands in **Delivering** with `PR open · checks running` → CI passes + merge the PR → watcher flips it to **done** with the "PR merged; checks green" activity entry.
4. Failure path: approve a task whose PR has a red check → watcher bounces it to **queued** with a `failure/v1 ci_failed` comment listing the failing runs → dispatcher re-claims → the claim payload contains the failure comment.
5. Overrides: with the watcher stopped, "Mark done" and "Re-queue" buttons work from the DetailPanel; watcher heartbeat shows in the supervisor strip when running.
6. ADO: point a workspace at an ADO-origin repo, approve → verify PR search + build-validation statuses drive the same transitions.
7. Restart discipline: rebuild dist and restart :8787, dispatcher, reviewer, MCP sessions after merge (stale processes predate the new CHECK/status).
