# Plan: cancel a task from any status

## Context

There's no way to drop a task without deleting it.

- **Delete** is permanent and is refused while the task is in progress.
- **Archive** only works on done tasks.
- **Release claim** puts the task back in the queue, where it gets claimed again.

A worker, review or visualization that is already running keeps spending tokens on a task nobody wants any more.

**Goal:** a human can always cancel a task, from any status.

**Decisions you made:**
- A new terminal status, `cancelled`, reachable from all seven statuses. It keeps the full history, stays out of the done metrics, can be reopened, and can be archived.
- Agent sessions working on the task are killed on the supervisor's next tick.
- An open PR on a delivering task is left alone. The watcher just stops tracking it.
- Cancelled tasks don't get a board column. You find them in the List view, and in Archive once archived.

**Defaults I chose (say if you want any changed):**
- A cancelled prerequisite **keeps blocking** its dependents. Nothing starts on its own because of a cancel; you remove the dependency edge yourself.
- Cancelling doesn't write anything back to Azure DevOps. The work item stays as it is, just as the PR does.
- `cancelled → queued` is not counted as a "reopen" in metrics.
- The Done column's "Archive all" stays done-only. Cancelled tasks are archived one at a time.
- Cancel settles the current execution and attempt as `cancelled`, which refunds the retry attempt. A cancel is not a failure.

**Migration slot:** AF-148 (in review, branch `feature/AF-148-bind-submissions-reviews-and-approvals-t`) already uses **#29**. This change takes **#30** and is built **on top of the AF-148 branch**, then merged after it, to avoid a slot collision. If AF-148 changes again, I rebase onto it. Live DB `user_version` is 28.

## Design

### Core (`packages/core`)
- **`src/types.ts`:** add `'cancelled'` to `Status`.
- **`src/migrate.ts`:** add `STATUS_LIST_30` and append migration #30 as `{ fkOff: true, run: db => widenCheck(db, 'task', STATUS_LIST_18, STATUS_LIST_30) }`. This reuses the `widenCheck` helper and the foreign-keys-off path that migration #18 used. Bump the tests that assert `user_version` (29 → 30).
- **`src/transitions.ts`:** add human edges `X → cancelled` for all seven statuses, `cancelled → queued` (reopen), and `cancelled → in_review` (reopen a pr-review task). The pr-review edge is kind-gated in `updateStatus.ts`: add `cancelled` to the existing straight-to-review guard next to `done`. Agents get no `cancelled` edges.
- **`src/ops/updateStatus.ts`:**
  - On `→ cancelled`: settle the live execution of any phase, using `settleRetry(retry_id, 'cancelled')` when it has an attempt and `settleExecution` when it doesn't. Also call `endSession` and clear the claim fields. With the execution settled, the worker's MCP writes (`submit_result`, `report_progress`, `task_git`) and the reviewer's verdict post are refused by the existing execution fence.
  - On `cancelled → queued`: delete the leftover `task_delivery` row (extend the existing `delivering`/`done` condition) and `advanceRetryBudget` (extend the `blocked`/`done` condition) so the reopened task starts fresh.
- **`src/repo/tasks.ts`:** `setStatus` clears `claimed_by`/`claimed_at` for `cancelled` as well as `queued`. Failure triage (~:202) skips cancelled tasks, as it does done ones.
- **`src/ops/archiveTask.ts`:** `archiveTask` accepts `done` or `cancelled`; update the comments that say "archived rows are always done".
- **`src/ops/retry.ts:37`:** a dispatcher reservation returns null for `cancelled` as well as `done`.
- **Already safe, no change, tests added:**
  - claim selection is `queued`-only;
  - delivery reconciliation has a status allowlist that excludes `cancelled`, so a merged PR can't bring a cancelled task back;
  - the watcher's poll filter is the same;
  - `importTask` deduplicates across all statuses, so ADO won't re-import a cancelled item;
  - `metrics.ts` doesn't count time while a task is cancelled.

### MCP + web server
- `packages/mcp/src/schemas.ts`: add `cancelled` to `StatusEnum`, and exclude it from `AgentStatusEnum` (as `delivering` is). In `tools/updateStatus.ts`, add a friendly guard ("task was cancelled by a human — stop working") next to the existing `delivering` guard.
- `packages/web/server/schemas.ts` `StatusEnum` and the inline enum at `routes/agentOps.ts:34`: add `cancelled`. The human `POST /:key/status` route needs nothing else, and `InvalidTransitionError` is already mapped to 409.

### Supervisors: kill on the next tick
- **Dispatcher (`packages/dispatcher/src/dispatcher.ts`):** extend `cancelCompletedSessions` (~:440). It already re-reads each running session's task every tick and kills the process tree on a merged delivery. Add `task?.status === 'cancelled'` with its own flag, `humanCancelled`, and the log line "task cancelled by a human; terminating worker". In `reapSettled`, a `humanCancelled` session settles its attempt as `cancelled`. It never goes through `releaseAndRetry` and never posts a `failure/v1` note, so a cancel doesn't use up retry budget.
- **Reviewer (`packages/reviewer/src/reviewer.ts`):** add a `cancelAbandonedSessions` tick step that runs after `touchLiveSessions` and calls `getTask(session.key)` for each live review, visualization and feedback-eval session. When the task is `cancelled`, mark the session `humanCancelled` and call `terminateProcessTree(..., 'SIGKILL')`. Also clear a pending consensus-round launch so the next round member doesn't start. `reapSettled` and `reapVisualization` short-circuit on `humanCancelled` to `settleRetry('cancelled')` before `burnAttempt` / `burnVizAttempt`, so there is no `review_failed` note and no skip-listing.
- **Watcher:** no code change. Its poll and `checkTask` guards already skip `cancelled`, and it never closes PRs. Add a test that a cancelled delivering task with an open PR is neither polled nor completed. One race is accepted and documented: a cancel landing between `getTask` and `openPr` in the same check can still open a PR. Its follow-up `recordDeliveryCheck` is skipped on the status mismatch.

### Web client (`packages/web/client/src`)
- **`status.ts`:** add `cancelled` to `STATUS_LABELS` ("Cancelled") and `STATUS_COLORS` (muted grey). It is **not** added to `LIFECYCLE_ORDER`, so there's no board column. Add a `--st-cancelled` variable in `index.css`.
- **`views/BoardView.tsx`:** in `HUMAN_MOVES`, add `cancelled` to every source and `cancelled: ['queued']`. Cancel stays out of drag and drop, because there's no column to drop onto. `canDropTask` is unchanged.
- **`views/ListView.tsx`:** `ORDER` gains `cancelled: 7`, after done.
- **`components/DetailPanel.tsx`:**
  - A **"Cancel task"** button, always shown while the status isn't `cancelled`, including in progress. It uses the two-click confirm pattern (`confirmingCancel`, `.af-mini.danger` + `.armed`) and calls `api.setStatus(key, 'cancelled')`.
  - When the task is cancelled and not archived, show **Reopen** (`queued`, or `in_review` for a pr-review task, mirroring done) and **Archive**.
  - Delete keeps its rule: it's hidden while in progress, and you can cancel first and then delete.
- **`views/ArchiveView.tsx`:** add a Status column so archived done and archived cancelled tasks look different.

### Docs
- Spec: `docs/spec/cancel-task.md`. Plan: `docs/plan/cancel-task.md`, a copy of this plan. Commit both with the change.
- `CLAUDE.md`: add the lifecycle and statuses line (`cancelled` is human-only, terminal and reopenable) and note that migration #30 is the head.

## Execution

1. `git worktree add .worktrees/cancel-task -b feat/cancel-task origin/feature/AF-148-bind-submissions-reviews-and-approvals-t`, then `npm ci --cache .npm-cache` and `npm run build` in that worktree.
2. TDD, in this order: core (migration, transitions, updateStatus settlement, archive) → MCP + server enums → dispatcher → reviewer → watcher test → client.
3. `npm run build && npm test` in the worktree, then one `/code-review`.
4. PR into `main` after AF-148 merges, with the base noted in the PR body.

Your current uncommitted analytics change on `main` (Token spend moved to the top) is left in the main checkout and isn't part of this branch.

## Verification

- **Core tests:**
  - every status → `cancelled` succeeds as human and fails as agent;
  - `cancelled → queued` clears the delivery row and gives a fresh budget;
  - pr-review reopens to `in_review`;
  - cancelling an `in_progress` task settles its execution and attempt as `cancelled`, so a later `submitResult`, `reportProgress` or `addComment` with that `executionId` gets a 409;
  - a merged delivery doesn't move a cancelled task to done;
  - archive and unarchive of a cancelled task;
  - migration #30 widens the CHECK, keeps rows and child tables, and passes `foreign_key_check` (modelled on the `widenCheck` test at `migrate.test.ts:199`).
- **Dispatcher tests** (template: `dispatcher.test.ts:459`): claim, human cancel, tick → `child.killed`; the attempt is settled `cancelled`; no `failure/v1` comment; budget not used up. Run it in both db mode and board mode (HTTP transport, template `:971`).
- **Reviewer tests:** cancel during a single review, during a consensus round (the next member isn't launched), and during a visualization → killed, settled `cancelled`, no `review_failed` note.
- **Watcher test:** a cancelled task that was delivering, with an open PR, is skipped and not completed.
- **Client tests:**
  - the Cancel button is present on every status including in progress, and the two-click confirm calls `setStatus('cancelled')`;
  - a cancelled task shows Reopen + Archive;
  - the Board has no cancelled column;
  - the List sorts cancelled last;
  - the Archive view shows Status.
- **End-to-end on an isolated board:** copy the DB to the scratchpad (`user_version` 28) and run the worktree's `web:dev:server` against it on another port. Check that migrations #29 → #30 apply, then cancel a task in each status through the UI and check the drawer and List view. Run the dispatcher against that copy with a queued throwaway task, cancel it while the worker runs, and check in the dispatcher log that the worker is killed within one tick.
- **Deploy (after merge):** rebuild, then restart :8787 + MCP + dispatcher, reviewer and watcher together. The migration and enum change mean older builds reject `cancelled`.
