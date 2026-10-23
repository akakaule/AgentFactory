# Intake pending hold: assess the written spec before it is built

Status: built 2026-10-23 on `feat/intake-pending-hold`. It extends the Task Intelligence design
(`2026-09-20-task-intake-intelligence-design.md`, §9 "Stage 4").

## Problem

The spec stage writes a task's spec and acceptance criteria. Task Intelligence (intake) never scored
that written spec before an implementation worker started on it:

- intake ignores `in_review` tasks;
- a clean AI review auto-advances the task to implementation and re-queues it (`applyApproval`);
- the new revision must then settle for 60 s before intake looks at it, while the dispatcher polls
  every 15 s, so the worker claims it first;
- nothing at claim time looks at intake.

AF-148 shows the cost. Intake flagged its acceptance criteria as not verifiable (readiness 0.31), and
the task was built anyway. Every review finding then hung on one sprawling AC1.

## Decision

Build the **pending** branch of Stage 4 only. A held task waits for an assessment, then proceeds,
whatever the verdict.

A task is held when all of these hold:
- intake is enabled for its workspace;
- it is `queued` at the `implementation` stage;
- intake for its current revision is missing or stale;
- it was queued less than `maxHoldMinutes` ago (an existing setting, default 10).

Releasing the hold:
- a `current` assessment, or an `unavailable` one (provider failed), releases it. This fails open;
- once the time runs out, the task becomes claimable anyway.

Who it affects:
- **Spec → implementation:** the revision includes the stage, so this case is always held until the
  written spec is assessed.
- **Send-back and delivery-bounce re-queues:** these keep an unchanged revision, which is still
  `current`, so they are not re-held. This matches §9.
- **Workspaces not opted into intake:** unaffected.

**Not built:** holding on an `attention_required` verdict, i.e. Stage 4's enforcement. It stays
unapproved and gated on §13's calibration exit criterion. Neither Stage 4 precondition applies to the
pending hold:
- a forged assessment can only *release* a hold early, which is the same as today;
- the calibration criterion concerns blocking on a verdict, which this does not do.

## Mechanism

- **Core.** Core derives `Task.intakeHold = { until } | null` from the activity log, like the rest of
  intake state. `intakeHeldTaskIds` feeds `claimNextTask`:
  - unpinned selection excludes held ids;
  - a pinned claim returns null;
  - a reserved-execution claim throws `InvalidTransitionError`.
  - The hold is computed in JS and passed to the claim SQL as an id exclusion, so **no migration** is
    needed. The `task_intake` table §8 planned waits for verdict enforcement.
- **Dispatcher.** It skips held tasks the way it skips unmet dependencies: no reservation, no attempt
  spent, and one log line per task.
- **Intake supervisor.** Held tasks skip `settleSeconds` and go first, so a hold normally lasts one
  intake poll.
- **Board.** A held card shows a "Waiting for intake" chip with the hold deadline.
- **Analytics.** No hold-expired note is written. `intake-claim/v1` already records
  `assessmentRevision: null` when a claim happens without a current assessment.
