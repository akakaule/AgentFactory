# Task Intelligence skips the spec stage for simple tasks

Status: built 2026-10-25 (branch `feat/intake-skip-spec`). Builds on the intake design
(`2026-09-20-task-intake-intelligence-design.md`) and the pending hold
(`2026-10-23-intake-pending-hold-design.md`).

## Problem

Every code task created on the board starts at the spec (`description`) stage: an agent rewrites the
intent into a spec and acceptance criteria, an AI review checks it, and only then does implementation
run. For a one-line fix that round trip costs two agent sessions and several minutes for nothing.
Task Intelligence already assesses queued spec-stage tasks for readiness (outcome clear, scope
bounded), complexity and risk, so it has what it needs to decide that a task is simple.

## Decision

- **Automatic, opt-in.** A new `skipSpec` setting (off by default) lets intake move a qualifying task
  straight to implementation. It is the first routing decision intake makes; verdicts otherwise stay
  advisory.
- **What counts as simple** — all editable in Task Intelligence settings: complexity at most
  `skipSpecMaxComplexity` (`trivial` | `small`, default `small`), risk at most `skipSpecMaxRisk`
  (default `low`), readiness at least `skipSpecMinReadiness` (default `0.8`).
- **Acceptance criteria come from the worker.** A skipped task still carries the placeholder
  `To be defined by the description stage.` The implementation worker writes 2–5 numbered criteria
  before coding, submits them as `acceptanceCriteria` with its result, and claims against those ids
  (MCP protocol v9). Core accepts the field on an implementation submit only while the placeholder is
  still there.
- **Fail open.** If no assessment arrives within `maxHoldMinutes`, or a worker has already started,
  the task keeps the normal spec stage.

## Mechanism

1. **Hold.** With `skipSpec` on, a queued spec-stage task in an opted-in workspace gets the pending
   hold implementation tasks already get (`intakeHoldFor`): unclaimable until its current revision is
   assessed, for at most `maxHoldMinutes` from its latest queue entry. The dispatcher and
   `claimNextTask` already honour the hold; the intake supervisor assesses held tasks first, with no
   settle wait.
2. **Decision.** `skipSpecDecision(assessment, settings)` (core `intake.ts`) checks the thresholds and
   returns the reason text (`small, low risk, ready 92%`).
3. **Move.** `recordIntakeAssessment` (core `ops/intake.ts`), in the same transaction that stores a
   new assessment, moves a qualifying task — still `queued`, still at the spec stage, with no live
   dispatcher/worker execution — to `implementation`, and appends a `queued → queued` status change
   by `agent`: `Task Intelligence: simple task (…); stage description → implementation`. The body
   matches the approval convention, so the status trail shows the stage advance.
4. **No re-hold.** Moving the stage changes the intake revision, which would normally re-hold the task
   at implementation until a fresh assessment. The hold skips a task whose latest queue entry is the
   skip note: that assessment was its intake review. A later re-assessment still happens and stays
   advisory.
5. **Criteria.** `get_next_task` sees the placeholder and builds the protocol with `defineCriteria`
   (no claim on the placeholder `AC1`); the setup asks for 2–5 criteria, the finish step for
   `acceptanceCriteria` plus one claim per criterion. `submitResult` writes them with `applyEdit` and
   validates claims against them. The reviewer and the review brief re-read the task, so they use the
   worker's criteria.

## Accepted limitations

- The skip is only as good as the assessment: a task rated simple that is not gets no spec review.
  The human still approves the implementation review before anything ships.
- A worker on an older protocol (a stale interactive MCP session) is not asked for criteria; its
  submit then leaves the placeholder, and the review has no criteria to check. Restart MCP sessions
  with the deploy.
- Fixing a stored settings document that predates new fields: `normalizeIntakeSettings` now merges the
  defaults before validating, so adding fields never resets stored settings to off.
