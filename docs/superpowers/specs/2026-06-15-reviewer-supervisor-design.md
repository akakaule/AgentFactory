# AgentFactory — Reviewer: a dispatcher-style loop for the in_review stage

**Date:** 2026-06-15
**Status:** Implemented
**Grows from:** [2026-06-12 AI review tier](2026-06-12-ai-review-tier.md) (whose `ai-review/v1`
convention and auto-advance hook this drives) and [2026-06-12 dispatcher](2026-06-12-dispatcher-one-session-per-task-design.md)
(whose poll → spawn → reap supervisor shape this mirrors for the review stage).

## Problem

The dispatcher turns the `queued` backlog into throughput, but the `in_review` stage has no
in-repo equivalent. Automated first-pass review lived only **outside** this repo as a
PowerShell loop (`Run-ReviewerLoop.ps1`) in the ado-bridge repo. So a local, dispatcher-only
setup produced `in_review` tasks with no AI verdict unless a human also ran the external loop.
We want an in-repo supervisor that watches `in_review`, runs an AI review, and posts the
verdict — the natural sibling of the dispatcher.

## Goals

- in_review → verdict with no human in the loop: a supervisor watches the stage and spawns a
  **fresh headless engine session per task** that still needs a review.
- **Engine configurable, default Codex** — an independent second opinion on the (typically
  Claude) dispatcher's work; Claude also supported.
- Reuse the existing review tier end to end: post an `ai-review/v1` verdict via `add_comment`
  and let the board's hook do the rest (clean doc-stage → auto-advance; findings /
  implementation → human gate). The reviewer stays **advisory** — it never approves or
  changes status.
- Mirror the dispatcher's operational shape (config, poll, attempt cap, timeouts, logs).

## Non-Goals (deferred)

- Approving / requesting changes from the bot — implementation approval stays the human gate
  (the curated-findings design is unchanged).
- A shared supervisor abstraction with the dispatcher — mirror the pattern now; extract later.
- A reviewer UI on the board (the verdict chip + findings checklist already exist).
- Re-running the engine inside the target repo / with MCP — review reads the diff text, not
  the working tree, so it needs no checkout and no per-repo allowlist.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Home | New `packages/reviewer`, bin `agentfactory-reviewer` | Own lifecycle + config; Core-direct like the dispatcher, no web server needed |
| What to review | Poll `listTasks(status=in_review)` per workspace; keep tasks where `aiReview` is absent or `verdict === 'pending'` | The derived `aiReview` verdict is the dedup signal — never re-review settled work, re-review when a new result supersedes the last review |
| Who posts | The reviewer posts the verdict via `core.addComment(actor:'agent')`; it never approves | The board's existing `add_comment` hook auto-advances a clean **doc** stage and escalates findings / implementation — so the reviewer only has to post |
| Engine | `engine: 'codex' \| 'claude'`, **default codex**, optional `model` | Codex is an independent second opinion on Claude's work; one config flag swaps it |
| Engine invocation | codex: `exec --sandbox read-only --skip-git-repo-check --color never --output-last-message <file> [-m model] -`; claude: `-p --output-format text --max-turns 1 [--model model]` | Headless, read-only, single-turn; the verdict is codex's captured final message / claude's stdout |
| Prompt delivery | On **STDIN**, not argv | Diffs are large/arbitrary; the dispatcher's argv-prompt trick doesn't fit. `SpawnRequest` gains `stdin` |
| cwd | A neutral dir (`logs/`), never the repo | No repo `.claude/` context or MCP loads into the review session (mirrors the ado-bridge TEMP cwd) |
| Diff source | Reuse `branchDiff`/`resolveBaseRef`, extracted from `packages/web/server/git.ts` into `@agentfactory/core` (web re-exports); branch = last `branch`-kind link (as the board's diff view), else the named branch | One diff path for the board and the reviewer; the branch persists on origin post-submit |
| Doc stages | description/plan review the task's own `spec`/`acceptanceCriteria`/`plan`, no diff | Their deliverable is the fields, not code |
| Timeout / crash / empty | Kill past `reviewMinutes` (default 10); a failed review posts **nothing**, burns an attempt, skip-lists after `maxAttempts` (default 2) | Advisory — a failed review just leaves the task for a human, it never spams the board |
| Logs | `logs/<key>-review-<n>.log` (stdout+stderr); codex verdict at `logs/<key>-review-<n>.out` | Postmortems |
| Config | `reviewer.config.json`: `db`, `workspaces[]`, `engine`, `model?`, `pollSeconds` (60), `maxConcurrent` (1), `reviewMinutes` (10), `maxDiffChars` (120000), `maxAttempts` (2) | One file; restart to apply |

## Lifecycle sketch

1. Poll: `in_review` task in workspace `agentfactory` whose `aiReview` is absent/pending? →
   build the per-stage prompt (compute the diff for implementation) → spawn the engine with
   the prompt on STDIN.
2. Reap exit: read the verdict (codex output file / claude stdout); ensure the `ai-review/v1`
   marker; `add_comment(actor:'agent', body)`.
3. The board's hook fires: a clean **doc** stage auto-advances; **findings** and the
   **implementation** stage stay `in_review` for the human, now showing the verdict chip +
   findings checklist.
4. Failure path: timeout/crash/empty verdict → no comment, attempt++ → skip-list after
   `maxAttempts`, leaving the task for a human reviewer.

## Acceptance criteria (feature-level)

1. With the reviewer running and a task `in_review` (default codex), the task gains an
   `ai-review/v1` verdict with no human action; a clean **description/plan** verdict
   auto-advances the task to its next stage; an **implementation** verdict appears as the
   board chip + findings checklist and the task stays `in_review`.
2. A task that already carries a current `clean`/`findings` verdict is **not** re-reviewed; a
   task whose verdict is `pending` (a newer result superseded the review) **is**.
3. The prompt rides STDIN; the engine runs read-only in a neutral cwd; codex/claude args match
   the spec; an engine that omits the marker still yields a recognised verdict (marker prepended).
4. A review that times out / crashes / returns nothing posts no comment, burns an attempt, and
   is skip-listed after `maxAttempts` with a console warning.
5. Reviewer unit tests cover poll/dedup, both engines, the doc auto-advance vs implementation
   human-gate split, marker-prepend, and the failure/skip-list path with a faked subprocess;
   `tsc -b` clean and full suite green.
