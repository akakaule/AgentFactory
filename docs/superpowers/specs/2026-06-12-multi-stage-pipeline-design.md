# AgentFactory — Multi-stage task pipeline: description → plan → implementation

**Date:** 2026-06-12
**Status:** Approved
**Grows from:** the [agent review tier](2026-06-12-agent-review-tier-design.md) (ai-review/v1
verdicts + human curation) and the [claim protocol](2026-06-12-claim-protocol-and-submit-guardrails-design.md)
(server-computed per-claim protocol). The ado-bridge producer's `claude -p` design pass moves
onto the board as a first-class, reviewed stage.

## Problem

A task goes straight from `queued` to implementation. The design work — turning a raw idea or
ADO work item into a feature description and an implementation plan — happens off-board (the
bridge's headless `claude -p` call) or not at all, is never reviewed, and leaves no trail. The
desired workflow is: create task → agent writes the feature description → agent writes the
implementation plan → each reviewed (agent review, human approval or auto-approve) →
implementation → done.

## Design

### One task, three stages

A new `task.stage` column (`description | plan | implementation`) carries the pipeline position.
The board columns stay status-based: the task cycles through queued → in_progress → in_review
once per stage, with a stage chip on the card. Approving an in-review **doc stage** advances the
stage and re-queues (one `status_change` activity carries the note, e.g.
`auto-approved: clean AI review; stage description → plan`); approving the **implementation**
stage closes the task. `done` therefore always means *code approved*.

- Stage deliverables travel through `submit_result`: the description stage submits
  `{ summary, spec, acceptanceCriteria }` (rewriting the task's own fields), the plan stage
  `{ summary, plan }` (new nullable `task.plan` column), implementation stays
  `{ summary, links }` with the push-before-review guardrails. Wrong shapes are rejected with
  the stage and expected fields named.
- The claim protocol (v3) is stage-discriminated: doc stages get `setup: []`, no branch, no
  worktree, and finish steps describing the doc deliverable; the branch is named at the **first
  implementation-stage claim**, so the slug derives from the post-description title.
- Request-changes re-queues at the *same* stage with the curated feedback riding the activity,
  exactly as today.

### Auto-approve policy

A clean `ai-review/v1` verdict (zero findings, well-formed marker) landing on an in-review doc
stage advances it automatically — the hook lives in core's `addComment` (actor-independent: the
bridge posts via HTTP as human, the `/review-task` skill via MCP as agent) and shares its body
with the human approve path (`ops/approval.ts`). Findings, malformed markers, and the
implementation stage always escalate to the human gate. Reviewers stay advisory in mechanism
(they only post comments); the advance is board policy in core.

Guard rails: a raw status move `in_review → done` is rejected for doc stages (core +
board drag), `update_status` over MCP still cannot approve anything, and the override comment
(`override: approved over N open AI finding(s)`) is logged when a human approves a doc stage
over findings.

### Entry points

- **Board (TaskForm):** Workflow selector — *Full pipeline* (default, `stage: 'description'`,
  acceptance criteria optional: that stage writes them) or *Implementation only* (today's
  behavior).
- **ado-bridge:** creates a bare task (`AB#<id>: <title>`, spec = work-item link + raw
  description, `stage: 'description'`) and no longer runs its own design pass. Outbound
  reflection to the ADO `reviewState` fires only for implementation-stage `in_review`, so
  doc-stage review cycles never flip the work item.
- **API default** stays `stage: 'implementation'` for back-compat (existing tests/scripts and a
  stale bridge behave exactly as before); clients opt into the pipeline explicitly.

### Reviewer stage-awareness

`/review-task` (and ado-bridge's reviewer loop via `New-DocReviewPrompt`) reviews per stage:
description = spec + AC vs the task's intent (completeness, verifiable criteria, no invented
scope); plan = the `plan` field vs spec + AC (coverage, grounded in the real codebase, test
plan); implementation = the diff, as today. Doc stages fetch no diff. The reviewer contract
now states that a clean doc verdict auto-advances.

## Non-Goals (deferred)

- **Title rewrite at the description stage** — the title is the bridge's dedup key (`AB#<id>:`)
  and stays human-owned (backlog-only edits).
- **Backward stage moves** — reopen (`done → queued`) keeps `implementation`; there is no
  "redo the plan" path. Delete and recreate if the design is wrong.
- **ADO image attachments** — the bridge auto-queues past backlog, where attachments freeze;
  raw-description specs carry text only (pre-existing limitation, now noted).
- **Per-task auto-approve toggles / policy config** — the policy is fixed: docs auto-advance on
  clean, implementation is always human.
- **Stage-aware analytics** — KPIs (override rate, rounds, reopen) keep their existing
  definitions; `findingsAtApproval` snapshots only at `→ done`, so the override KPI remains
  implementation-only by construction.

## Follow-up

- README + site pages (`index.html`, `producer-flow.html`, `system-overview.html`) still
  describe the bridge-side design pass — update as a follow-up task.
