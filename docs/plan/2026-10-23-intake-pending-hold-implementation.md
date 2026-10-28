# Intake pending hold: assess the written spec before implementation starts

## Context

In AF-148's flow, Task Intelligence (intake) flagged in September that the acceptance criteria were "not
verifiable" (readiness 0.31). The task skipped the spec stage, the flag was overridden, and every review
finding then hung on one sprawling AC1.

The user wants a spec written by the description stage to be checked for readiness **before**
implementation starts. Today it never is:

- intake ignores tasks in `in_review`;
- a clean AI review auto-advances the task to implementation and re-queues it (`applyApproval`,
  core/src/ops/approval.ts:102);
- the new revision then has to settle for 60 s before intake looks at it, while the dispatcher polls
  every 15 s, so the worker claims it first;
- nothing at claim time looks at intake.

The user chose **"hold, then proceed"**. This is exactly the *pending* branch of the original intake
spec's Stage 4 (docs/spec/2026-09-20-task-intake-intelligence-design.md §9):

- **Pending hold:** a queued task with no current assessment is held for at most `maxHoldMinutes`
  (an existing setting, default 10, currently unused), then fails open.
- **Out of scope:** holding on an `attention_required` verdict. This stays advisory.

Why Stage 4's preconditions don't block this subset:

- **Trust:** a forged assessment can only *release* a hold early, which is the same as today.
- **Calibration:** the exit criterion concerns blocking on a verdict, which this doesn't do.

## The rule (one function in core, used everywhere)

A task is **held by intake** when all of these hold:

- intake is enabled for its workspace (`intakeEnabledFor`, mode `advisory`);
- `status === 'queued'` and `stage === 'implementation'`;
- intake for the **current** revision is missing or `stale`. A `current` or `unavailable` (provider
  failed) assessment releases the hold, so the task fails open;
- it was queued less than `maxHoldMinutes` ago. "Queued at" is the latest `status_change` activity into
  `queued`.

`heldUntil = queuedAt + maxHoldMinutes`.

Effects of this rule:

- **Spec → implementation:** the revision includes the stage, so it is always stale here and the task
  is held until the written spec is assessed. This is the requested behaviour.
- **Send-back, delivery bounce, plain re-queue:** the spec is unchanged, so the assessment stays
  `current` and nothing is held. This matches the original spec ("re-queues are not re-held").
- **Workspace not opted in / intake off:** nothing changes.
- **Intake supervisor down:** work is delayed by at most `maxHoldMinutes`.

## Changes

New branch `feat/intake-pending-hold` off `origin/main`, in its own worktree; independent of
`feat/agent-model-settings` and `fix/token-gate-refuses-service-tokens`. No migration: the held set is
computed in JS and passed to the claim SQL as an id exclusion. This avoids the `task_intake` table the
original Stage 4 note planned, and avoids a migration slot while AF-148 holds #29.

1. **core: hold derivation**, `packages/core/src/repo/tasks.ts`
   - `intakeHoldFor(row, summary, settings, queuedAt, now)` holds the rule above.
   - `queuedAtByTaskIds(db, ids)` is one query over `activity` (latest status_change → queued).
   - `intakeHeldTaskIds(db, now, workspaceId?)` lists queued implementation rows in enabled
     workspaces, then applies the rule. It reuses `intakeByTaskIds` / `storedIntakeSettings`.
   - New derived field `Task.intakeHold?: { until: string } | null` (core/src/types.ts), set in
     `listRows` and `toDetail` beside `intake`.
2. **core: claim gate**
   - `oldestQueuedRow(..., excludeIds?)` adds `task.id NOT IN (…)`.
   - In `claimNextTask` (core/src/ops/claimNextTask.ts):
     - unpinned selection excludes `intakeHeldTaskIds(db, now)`;
     - a pinned (`taskKey`) claim of a held task returns null;
     - a reserved-execution claim of a held task throws `InvalidTransitionError('held by intake …')`,
       the same shape as the existing "not claimable".
   - The MCP `get_next_task` and `/work-task` paths share this core code, so the rule is the same for
     every claimant.
3. **dispatcher**, `packages/dispatcher/src/dispatcher.ts` `pollWorkspace`
   - `if (task.intakeHold) continue;` next to the `unmetDependencyCount` skip: no reservation, no attempt
     burned, no "claimed nothing" loop.
   - It logs once per task key ("waiting for intake assessment until …").
   - Over HTTP the field rides `listTasks` unchanged.
4. **intake supervisor**, `packages/intake/src/supervisor.ts:32`
   - A held task skips the `settleSeconds` window, and held tasks sort first. The hold then normally
     lasts one intake poll, not ≥ 60 s.
5. **web client**
   - `IntakeChip` shows "Waiting for intake" (title "Held until hh:mm while Task Intelligence assesses
     the written spec") when `task.intakeHold` is set.
6. **Docs**
   - Short design note `docs/spec/2026-10-23-intake-pending-hold-design.md`, referencing intake spec §9
     and stating that the verdict hold stays unapproved.
   - This plan in `docs/plan/`.
   - The intake spec's Stage 4 section gets a line noting that the pending hold shipped.

Not doing: a "hold expired" activity note. `intake-claim/v1` already records `assessmentRevision: null`
when a claim happens without a current assessment, so analytics can see expiries.

## Tests (TDD, failing first)

- **core** `test/intakeHold.test.ts`:
  - held when an implementation task is queued with a missing or stale assessment;
  - released by a `current` or `unavailable` assessment;
  - expires after `maxHoldMinutes`;
  - not held when intake is off or the workspace isn't opted in;
  - not held at the description stage;
  - not re-held on a send-back re-queue with an unchanged spec.
- **core claim:**
  - `claimNextTask` skips a held task and claims the next one;
  - a pinned claim returns null;
  - a reserved claim throws;
  - end-to-end: description submit → clean ai-review auto-advance → claim null → `recordIntakeAssessment`
    → claim succeeds.
- **dispatcher:** a held task is not spawned and no budget is reserved; it is spawned on the tick after
  the assessment lands.
- **intake supervisor:** a held task is assessed without waiting `settleSeconds`.
- **client:** chip text for a held task.
- **web:** the HttpCore contract still passes (the field rides `listTasks`).

## Verification

- `npm ci --cache .npm-cache` in the worktree, then `npm run build`, then `npm test`: all green.
- Manual check on an isolated demo DB (never the working board):
  - opt a workspace into intake, create a description task, submit a spec, post a clean ai-review;
  - see the queued card show "Waiting for intake" and `claimNextTask` return null;
  - record an assessment, then the claim succeeds.
- Deploy: rebuild, then restart :8787, the MCP sessions, the dispatcher and intake.

## Risk

- **Merge conflicts:** AF-148 (in review) also touches `claimNextTask` / repo/tasks.ts. Whichever merges
  second rebases.
- **Delay ceiling:** with intake enabled, an implementation task that misses its assessment waits up to
  10 min (configurable `maxHoldMinutes`, 1–1440).
