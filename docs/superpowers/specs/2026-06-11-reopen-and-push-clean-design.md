# AgentFactory — Reopen + push-and-clean worker convention (closing the PR loop)

**Date:** 2026-06-11
**Status:** Approved (2026-06-11)
**Grows from:** [2026-06-11 diff view](2026-06-11-diff-view-design.md), which made review
possible on the board, and [2026-06-11 claim recovery](2026-06-11-claim-recovery-design.md),
whose "human rescue via one transition rule" pattern this reuses. Together they close the
loop *after* approval: branch → PR → CI → fix.

## Problem

Two gaps surface the moment approved work heads toward a PR:

1. **Worktrees and unpushed branches pile up.** The convention tells workers to create
   `<repoPath>/.worktrees/<key>` but never says when to push or remove anything. Approval
   happens in the web UI, where no agent is attached — so nothing ever cleans up, and the
   branch exists only on the dev machine until a human pushes it by hand.
2. **`done` is terminal, but CI disagrees.** PRs are made manually from `task/<key>`
   branches. When the PR build fails, the board has no move: the task is `done`, agents
   can't touch it, and the only fix path is a brand-new task that loses the activity
   thread *and* the branch↔PR association (a new branch needs a new PR).

## Goals

- A worker leaves nothing behind at submit time: work **pushed** to `origin`, worktree
  **removed**, the branch link recorded — encoded in the tool descriptions so every MCP
  runtime picks it up without extra prompting.
- A human can **reopen** a done task (`done → queued`), preserving full activity history,
  so a CI failure flows back to the same task — and pushes to the same branch
  auto-update the same PR.
- Agents cannot reopen (human judgment, like approve/release).
- Zero new ops/routes/tools/schema — same footprint discipline as claim recovery.

## Non-Goals (deferred)

- CI integration on the board (polling checks, webhooks) — a human (or an external
  babysitter script hitting the HTTP API) pastes the failure and reopens.
- PR creation/merging by workers — PRs stay manual.
- Local/remote branch deletion after merge — GitHub's delete-branch-on-merge owns it.
- Auto-reopen on push or any board-side git *writes* — the board stays read-only on repos
  (diff view precedent).

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| When to push & clean | At **`submit_result` time**, not approval | The worker still owns the task then; at approval no agent is attached. The diff view reads the *branch*, not the worktree, so nothing on the board needs the worktree after submit. Early push = remote backup + CI starts before review. |
| Finish protocol | commit all → `git push -u origin task/<key>` → `git worktree remove` + `prune` → `submit_result` with branch link | `worktree remove` refuses on dirty trees — a free "nothing uncommitted" check. |
| Re-claim with existing branch | `git worktree add <repoPath>/.worktrees/<key> task/<key>` (no `-b`) | Request-changes and reopen both re-queue a task whose branch exists; the current description only documents the `-b` create case, which fails on round 2. |
| Reopen mechanism | **New transition rule** `{ from: 'done', to: 'queued', by: 'human' }` — nothing else | `updateStatus` + `POST /:key/status` + activity logging + claim-clearing-on-queued (the `setStatus` choke point) all just work. MCP `update_status` acts as `agent`, so agents are locked out by the rule itself. |
| Where the failure context goes | Human comment on the task (log tail or run URL; `log`/`url` link kinds exist) before reopening | The next claimant reads spec + prior result + feedback + CI failure in one thread — feed-and-follow-up unchanged. |
| `resultSummary` on reopen | Kept (next `submit_result` overwrites) | It is accurate history of the last attempt; the activity log already tells the full story. |
| UI affordance | **Reopen** button on a done task's detail panel via existing `api.setStatus(key, 'queued')` | Mirrors Release claim: one button, no new client API. |
| Convention delivery | Tool descriptions (`get_next_task`, `submit_result`) + READMEs | Same channel as the worktree convention itself; `registry.test.ts` already asserts on this text, so the change is test-driven. |

## Transition change

```
{ from: 'done', to: 'queued', by: 'human' }   // reopen (e.g. CI failed on the PR)
```

The human rescue story stays symmetric: `in_review → queued` (request changes),
`blocked → queued` (re-queue), `in_progress → queued` (release a dead claim), and now
`done → queued` (reopen). Every path into `queued` clears claim metadata at the single
`setStatus` choke point — including this one, for free.

## The full PR loop (documentation, not code)

1. Worker finishes: push `task/AF-7`, remove worktree, `submit_result` (branch link).
2. Human reviews the diff on the board → approve → `done` → opens the PR manually.
3. CI fails → human comments the failure on AF-7 → **Reopen**.
4. Worker re-claims (full thread in the payload), recreates the worktree from the
   existing branch, fixes, pushes — the PR updates itself — cleans up, resubmits.
5. Human re-reviews, approves; merge; GitHub deletes the remote branch.

## Acceptance criteria (feature-level)

1. A human can move a done task to queued through the existing status endpoint; claim
   metadata is cleared; an agent attempting the same transition is rejected.
2. After reopen, the next claim carries the full prior activity (result, feedback,
   CI-failure comment) — the loop survives a failed PR build.
3. The done task's detail panel shows **Reopen**; other statuses don't.
4. `get_next_task` instructs branch-reuse on re-claim; `submit_result` instructs
   push + worktree removal before submitting — both asserted by registry tests.
5. No new ops/routes/tools/columns; full suite green.
