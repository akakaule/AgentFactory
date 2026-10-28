# Task Intelligence skips the spec stage for simple tasks

## Context
Every new code task starts at the spec (`description`) stage: an agent rewrites the intent into a spec + acceptance criteria, an AI review checks it, then implementation runs. For very simple tasks that round-trip is pure overhead. Task Intelligence (the intake supervisor + Jev) already assesses queued spec-stage tasks for readiness (outcome clear, scope bounded), complexity and risk — so it can decide. Decisions made with the user:
- **Automatic**: a qualifying task moves straight to implementation (opt-in toggle in Task Intelligence settings; fails open to the normal spec stage).
- **"Simple"** = complexity trivial or small, risk low, readiness ≥ 80 % — all three editable.
- **Acceptance criteria**: a skipped task still has the placeholder "To be defined by the description stage."; the implementation worker writes 2–5 criteria and submits them with its result (MCP PROTOCOL_VERSION 8 → 9).

Today's design keeps intake strictly advisory; this is the first routing decision it makes, so it is off by default and only acts on tasks no agent has started.

## Design

### 1. Settings — `packages/core/src/intakeSettings.ts`, `types.ts` (`IntakeSettings`)
New fields: `skipSpec: boolean` (default `false`), `skipSpecMaxComplexity: 'trivial' | 'small'` (default `'small'`), `skipSpecMaxRisk: Risk` (default `'low'`), `skipSpecMinReadiness: number` 0..1 (default `0.8`).
**Fix on the way:** `normalizeIntakeSettings` parses the stored doc with a `.strict()` all-required schema and no defaults merge, so a stored doc written before this change would read as **off**. Merge `defaultIntakeSettings` before parsing (as `parseIntakeSettingsUpdate` already does); test it.

### 2. Decision — `packages/core/src/intake.ts`
Pure `skipSpecDecision(a, settings) → { reason: string } | null`: assessed, `a.stage === 'description'`, complexity rank ≤ max, risk rank ≤ max, `readiness.probability ≥ min`. Reason text like `small, low risk, ready 92%`.

### 3. Promotion — `packages/core/src/ops/intake.ts` `recordIntakeAssessment`
After appending the assessment (not on the idempotent early return), inside the same transaction: if `settings.skipSpec`, intake enabled for the workspace, `row.kind === 'code'`, `row.status === 'queued'`, `row.stage === 'description'`, no live execution on the task (dispatcher may have reserved one in the fail-open case), and `skipSpecDecision` passes → `setStage(db, id, 'implementation', ts)` and append a `status_change` (`queued → queued`, actor `agent`) with body `Task Intelligence: simple task (small, low risk, ready 92%); stage description → implementation`. That body matches `StatusTrail`'s stage regex and the approval convention (`approval.ts:108`). No `assertTransition` (status unchanged). Supervisor and HTTP surface need no change — the promotion rides the existing `recordIntakeAssessment` call.

### 4. Holds — `packages/core/src/repo/tasks.ts` (`intakeHoldFor`, `intakeHoldsByRows`, `intakeHeldTaskIds`)
- With `skipSpec` on, **queued description-stage tasks are held too** (same `maxHoldMinutes` window from the latest queued row, same release on a current/unavailable assessment), so the dispatcher can't claim the spec stage before intake decides. Dispatcher (`task.intakeHold`) and `claimNextTask` (`intakeHeldTaskIds`) already honour the hold; the intake supervisor already assesses held tasks first with no settle wait.
- A just-skipped task's revision changes (stage is hashed), which would re-hold it at implementation until a re-assessment. Exempt it: when the latest `to_status='queued'` row (already queried by `queuedAtByTaskIds`) is the skip note, no hold — the skip *was* the intake review. (A later re-assessment still happens; it stays advisory.)

### 5. Criteria from the worker
- `packages/core/src/acceptanceCriteria.ts`: export `PLACEHOLDER_ACCEPTANCE_CRITERIA`; use it in `ops/createTask.ts:27`.
- `ops/submitResult.ts`: implementation submit accepts optional `acceptanceCriteria` **only while the row still has the placeholder** (else ValidationError); claims are checked against `acceptanceCriteria ?? row.acceptance_criteria`; write via `applyEdit(db, id, { acceptanceCriteria }, ts)` inside the transaction before `setStatus`. HTTP already passes the field through (`agentOps.ts:119`, `httpCore.ts:128`, `validate.ts:75`).
- `packages/mcp/src/protocol.ts`: PROTOCOL_VERSION 9; `ProtocolInput.defineCriteria`; when set, the implementation finish text tells the worker the task skipped the spec stage and to pass `acceptanceCriteria` (2–5 numbered `AC1…` lines, written before coding) and claim against those ids. `tools/getNextTask.ts`: placeholder → `defineCriteria: true`, empty criteria list (no claim on the placeholder `AC1`). `tools/submitResult.ts`: description text mentions the optional field.
- Reviewer and review brief re-read the task, so the worker's criteria flow through unchanged.

### 6. Board
- `packages/web/client/src/components/IntakeSettingsPanel.tsx`: "Skip spec for simple tasks" switch (existing `af-intake-switch` pattern); when on, max complexity (Trivial/Small segmented), max risk (select), min readiness (% input). Add the fields to `dirty`.
- `StatusTrail.tsx`: no change needed — the skip note enters the implementation row's Queued node, the same shape as an approval advance.

### 7. Docs
Design doc `docs/spec/2026-10-25-intake-skip-spec-design.md`, this plan as `docs/plan/2026-10-25-intake-skip-spec-implementation.md`; one paragraph in CLAUDE.md (Lifecycle) and the intake README if it lists settings.

## Tests (RED first)
- `core/test/intakeSettings*`: legacy stored doc without the new keys keeps its mode/workspaces; strict PUT validation of the new fields.
- `core/test/intake.test.ts` / new `intakeSkipSpec.test.ts`: qualifying assessment on a queued description task → stage implementation + skip note; each failing criterion (medium complexity, medium risk, readiness 0.7), toggle off, workspace not enabled, status backlog/in_progress, live execution, implementation-stage assessment → no change; idempotent re-record doesn't double-promote.
- `core/test/intakeHold.test.ts`: description task held with skipSpec on, not held with it off, released by assessment, fails open after `maxHoldMinutes`; skipped task not re-held at implementation.
- `core/test/submitResult*`: implementation submit with AC on a placeholder task writes AC and validates claims against them; AC on a real-criteria task → ValidationError.
- `mcp/test/protocol.test.ts`, `tools.test.ts`: version 9; `defineCriteria` text; placeholder task lists no criteria.
- `web/test/client`: settings panel saves the new fields.
- `dispatcher/test/intakeHold.test.ts`: a held description task is skipped.

## Verification
- Fresh worktree off `main` (`npm ci --cache .npm-cache`, `npm run build`, `npm test`).
- Live (after merge → rebuild → restart :8787, MCP sessions, dispatcher, reviewer, intake — protocol v9): enable "Skip spec" for one workspace, create a one-line task ("Fix typo X in README"), queue it → board shows "Waiting for intake", then the stage jumps to implementation with the Task Intelligence note; the worker's submit carries AC1…; the review cites them. A medium task still goes through the spec stage.

## Delivery
Branch `feat/intake-skip-spec` in `.worktrees/intake-skip-spec`; Conventional Commits; merge to main + push when green (user's standing preference this session).
