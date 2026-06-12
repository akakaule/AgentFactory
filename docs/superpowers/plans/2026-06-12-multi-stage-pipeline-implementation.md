# Multi-stage pipeline — implementation plan (as built)

**Date:** 2026-06-12
**Design:** [multi-stage pipeline](../specs/2026-06-12-multi-stage-pipeline-design.md)
**Status:** Implemented on `feat/multi-stage-pipeline` (AgentFactory + ado-bridge)

## Slices (one commit each)

1. **core: schema + claim** — migration #7 (`task.stage` TEXT NOT NULL DEFAULT
   `'implementation'` CHECK-constrained, `task.plan` TEXT), `Stage`/`STAGE_ORDER` types,
   conditional acceptance-criteria validation (`superRefine`: required unless stage
   `description`, placeholder default), repo mappers + `setStage`/`setPlan`,
   `claimNextTask` names/persists the branch only at implementation-stage claims.
2. **core: submit + approval** — `ops/approval.ts` `applyApproval` (shared, runs inside an
   open transaction — `transaction()` cannot nest): doc stage → advance + re-queue,
   implementation → done (human-only assert); `reviewApprove` delegates to it; `submitResult`
   enforces the per-stage payload matrix and persists spec/AC via `applyEdit` or the plan via
   `setPlan`; `addComment` auto-approve hook (parses the incoming body with
   `parseAiReviewComment`, advances on zero findings when in_review at a doc stage);
   `updateStatus` blocks `in_review → done` for doc stages.
3. **mcp: protocol v3** — stage-discriminated `Protocol`/`ProtocolInput` (single-literal
   discriminants for narrowing), `getNextTask` always builds doc protocols (no branch),
   `submitResult` tool gains `spec`/`acceptanceCriteria`/`plan` inputs and skips
   `checkSubmission` for doc stages; tool descriptions document the per-stage contract.
4. **web server** — `createBody` gains optional `stage`, AC optional (core re-validates →
   400); routes unchanged. `e2e.pipeline.test.ts` walks the full lifecycle over two WAL
   connections, including the findings-escalation and request-changes rounds.
5. **client** — `STAGE_LABELS`/`STAGE_COLORS`, stage chips (card + drawer), Plan section,
   stage-aware approve labels, TaskForm Workflow selector (pipeline default), branch chip
   gated to implementation, `canDrop` blocks doc-stage drags to Done.
6. **dispatcher + skills** — `buildWorkerPrompt` branches on `protocol.stage` (still a single
   quote-free line); `.claude/commands/work-task.md` Stage section;
   `.claude/commands/review-task.md` doc-stage review rules + auto-advance warning.
7. **ado-bridge** — bare-task intake at stage `description` (DesignGen.ps1 deleted,
   `Convert-HtmlToText` → Common.ps1, `claudeModel`/`claudeTimeoutSec` removed from config),
   `New-AfTask -Stage`, outbound `in_review → reviewState` gated to implementation stage,
   `New-DocReviewPrompt` + stage branch in `Run-ReviewerLoop.ps1`, command mirrors synced.

## Key invariants

- Auto-approve triggers on the **incoming comment body** (newest activity by construction),
  never on the derived verdict — a stale review can't advance anything.
- The advance activity is a `status_change in_review → queued` with actor `agent` and the note
  in `body`; analytics are unaffected (rounds = feedback rows, stranded releases scan
  `in_progress → queued`, claim labels ride `queued → in_progress` rows only).
- Doc-stage claims leave `branch` NULL → branch slug derives from the final title;
  `checkSubmission` never runs for doc stages.
- Legacy rows backfill to `implementation` and behave exactly as before; the HTTP/core default
  stays `implementation` — TaskForm and ado-bridge opt in explicitly with `description`.

## Verification

- `npm test` (whole monorepo) and `npm run build` green; ado-bridge
  `tests/Test-ReviewPrompt.ps1` + `Test-InboundWiql.ps1` green; all five touched .ps1 files
  parse clean.
- Manual e2e (after rebuild + restarting :8787 and reconnecting MCP — stale dist drops new
  fields silently): create description-stage task → queue → MCP claim (doc protocol, no
  branch) → submit `{spec, AC}` → post clean ai-review via `POST /comment` → auto-advance to
  queued@plan → claim → submit `{plan}` → clean review → queued@implementation → claim (branch
  named) → implement/push → findings review does NOT advance → human approve → done.
