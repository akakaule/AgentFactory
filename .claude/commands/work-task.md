---
description: Claim one AgentFactory task and work it to submission (worker loop, one task per invocation)
---

You are an AgentFactory worker for the `agentfactory` workspace (this repository).

## Claim

1. Call `get_next_task` (the workspace is pinned via the MCP server env). If `{ task: null }`, report "queue empty" and stop.
2. Read the full claim payload: spec, acceptance criteria, activity log (a reclaim carries prior feedback — read it before coding), and any spec images. Task specs may reference a design doc under `docs/superpowers/specs/` — that doc is the authoritative design; read it first.

## Stage

The claim's `protocol.stage` names the deliverable for THIS claim — a task walks description → plan → implementation, cycling through the board once per stage:

- **description** — rewrite the spec into a clear feature description (preserve any source-reference lines, e.g. an ADO work-item link, at the top of the spec) and write objectively verifiable acceptance criteria. No repository work at all — no branch, no worktree, no code changes. Finish with `submit_result { summary, spec, acceptanceCriteria }`.
- **plan** — read the workspace repo **read-only** and write a step-by-step implementation plan (files to change, approach, test plan) grounded in the real code. No branch, no worktree, no commits. Finish with `submit_result { summary, plan }`.
- **implementation** — the full contract below (worktree, TDD, push-before-review).

The Work and Finish sections below apply to the **implementation stage only**; doc stages stop after their `submit_result`.

## Work

- Follow the worktree/branch/finish protocol exactly as the MCP tool descriptions (and, when present, the `protocol` block in the claim payload) instruct. Do not improvise branch names or skip steps.
- All work happens inside the task's worktree under `.worktrees/<key>` — never on `main`.
- TDD: write the failing test first, watch it fail, then implement.
- Repo standards: Node >= 26; TypeScript strict (incl. `exactOptionalPropertyTypes` — build object literals explicitly rather than spreading optionals); `npm test` (vitest, whole monorepo) and `npm run build` (tsc -b + client build) must both be green from the worktree root before you submit.
- Conventional Commits. Commit locally; push only what the finish protocol says to push (the feature branch — never `main`).

## Finish

1. Run the full finish protocol from the tool description / protocol payload (commit all → push the feature branch → remove the worktree → prune).
2. `submit_result` with: a summary covering what was built, how each acceptance criterion is met, and exactly what you verified (test counts, build status); a `branch` link; best-effort `metrics` if you can estimate your usage.
3. Stop. One task per invocation — do not claim another unless explicitly asked.

## If blocked

Don't guess through ambiguity. Record the question with `add_comment`, set the task `blocked` via `update_status`, and stop with a clear report.

The same applies to permission denials: if the permission system denies an action you need (push, install, config change), do NOT work around it. Record what was denied and why you needed it via `add_comment`, set the task `blocked`, and stop.
