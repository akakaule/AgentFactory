# Intake queue gate

**Status:** built 2026-10-28 on `feat/intake-queue-gate`.
**Builds on:** `2026-09-20-task-intake-intelligence-design.md` (advisory intake), `2026-10-25-intake-skip-spec-design.md`.

## Why

Task Intelligence flags a task when its readiness is below the threshold, when implementation work is rated architectural, or when its risk is at or above a level. Until now the flag was advisory. A person could queue a flagged backlog task after a one-click acknowledgment, so badly specified work reached the workers anyway. The board should be able to refuse to queue that work until its spec is fixed.

## Decision

Two new `intake_settings` fields (`app_kv`, no migration), edited in the Task Intelligence settings panel:

| Setting | Values | Default | Meaning |
|---|---|---|---|
| `queueGate` | `off` / `acknowledge` / `block` | `block` | What queueing a flagged task needs: nothing, an acknowledgment (the previous behaviour), or never possible while flagged. |
| `queueRequiresAssessment` | boolean | `false` | Also refuse a task with no current assessment: never assessed, edited since it was assessed, or the assessment failed. |

The flags themselves are unchanged (`evaluateIntakePolicy`). Their settings — `readinessNeedsAttention` + `readinessThreshold`, `architecturalNeedsAttention`, `riskAttentionLevel` — are now editable in the panel too.

`intakeQueueGate(summary, settings, workspace)` (`core/src/intake.ts`) is the single rule:

| Situation | Result |
|---|---|
| Gate off, or intake not enabled for the workspace | `allow` |
| Current assessment with no flags | `allow` |
| Current assessment with flags | `block`, or under `acknowledge`: `acknowledge` until an acknowledgment for this revision is recorded, then `allow` |
| No current assessment (null, stale or unavailable) | `block` with reason `not_assessed` when `queueRequiresAssessment` is on, otherwise `allow` |

Where it is enforced and shown:
- `queueWithIntakeAcknowledgment` is the path for backlog → queued and cancelled → queued, including the REST `/status` route and `importTask`. A block throws `InvalidTransitionError("Task Intelligence blocks queueing: …")`, which the REST layer returns as a 409.
- In block mode, `overrideIntake` refuses to acknowledge a backlog or cancelled task, so an acknowledgment can't look like it unblocks queueing.
- Backlog and cancelled code tasks carry a derived `queueGate` on list rows and detail. The card chip reads "Can't queue". The drawer disables Queue task / Reopen and explains why. The board drag refuses with the same message. The intake panel hides "Acknowledge and continue".

## Scope and trade-offs

- **Human queueing only.** The intake design rejected gating the transition generally, because producers auto-queue and can't wait for an assessment. This gate is narrower: `importTask` already leaves a refused task in backlog, so an ADO import that is blocked (only possible with `queueRequiresAssessment` on) waits for a person.
- **No claim gate.** Tasks already queued, and other routes into `queued` (bounces, releases, reopening a done task), are not gated. The Stage 4 claim gate stays deferred.
- **Behaviour change on deploy.** A stored settings document without the new fields reads as `block`, so flagged tasks in intake-enabled workspaces stop being queueable once the board restarts. Switch to "Acknowledge" in the panel to keep the old behaviour.
