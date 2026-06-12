# AgentFactory — Claim-time protocol + submit-time guardrails (trust, but verify)

**Date:** 2026-06-12
**Status:** Implemented (2026-06-12)
**Grows from:** [2026-06-11 reopen + push-and-clean](2026-06-11-reopen-and-push-clean-design.md)
(the finish protocol this design enforces) and [2026-06-11 feature-branch naming](2026-06-11-feature-branch-naming.md)
(the rule the server now computes itself). Motivated by the 2026-06-12 incident: AF-8/9/10/12
all landed on old-style `task/<key>` branches, unpushed, because the worker session had
loaded its tool descriptions before the protocol changed — and `submit_result` accepted
every one of them.

## Problem

The entire worker convention — branch naming, push-at-submit, worktree cleanup — lives in
static MCP tool descriptions. Two failure modes, both observed:

1. **Descriptions freeze at session connect.** A long-lived worker keeps the rules it was
   born with, across source changes *and* dist rebuilds (the registered server runs
   `node dist/index.js`, which lagged source by 7.5 hours that day). There is no channel
   that delivers updated rules to a running worker.
2. **Nothing verifies the protocol ran.** The server cannot tell a pushed branch from a
   local-only one. The human discovers missing pushes by accident, days later, by asking
   "has this been pushed?"

## Goals

- The protocol a worker must follow arrives as **data in the claim payload**, computed
  fresh by the server on every claim — immune to session, description, and build staleness.
- The **server names the branch**, not the agent — naming drift becomes impossible, and a
  reclaim reuses the persisted name even if the title was edited in between.
- `submit_result` **verifies before accepting**: branch on origin, fully pushed, worktree
  removed. Convention becomes contract; the three observed failure modes become tool errors.
- All checks are git *reads* — the board/server-never-writes-repos precedent from the
  diff view holds.

## Non-Goals (deferred)

- Server-side pushing or fixing (it instructs and verifies, never mutates repos).
- PR creation and CI status (separate designs).
- Removing convention text from tool descriptions entirely — they stay as orientation,
  but defer to the payload as the source of truth.
- Diff view switching from link labels to `task.branch` (enabled by this design, not done in it).

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Branch naming owner | Core computes `feature/<key>-<kebab-title>` at **first claim** and persists it to a new nullable `task.branch` column; kebab util lives in core, exported and unit-tested | One deterministic implementation instead of N agents re-deriving from prose; persisting makes reclaims stable under title edits and gives guardrails an exact ref to check |
| Protocol delivery | `get_next_task` result gains a `protocol` object: `version`, `branch`, `worktree` path, `setup` commands (create-with`-b` vs reuse form — server picks: `task.branch` already set ⇒ reclaim ⇒ reuse), `finish` steps (commit → `push -u origin` → `worktree remove` + `prune` → `submit_result` with branch link) | Claim-time data cannot go stale; create-vs-reuse is no longer guessed by the agent |
| Branch start point | Unspecified (HEAD of the main checkout), as today | `push -u` sets the correct upstream regardless; dictating `origin/<default>` would require resolving the default branch at claim time for marginal gain |
| Verification point | `submit_result` tool handler in **packages/mcp** (async), before core's status flip; core stays sync/pure-DB | Tool handlers are already async; mirrors the web package's `git.ts` edge pattern — git never enters core |
| Checks | (1) `git ls-remote --heads origin <branch>` returns the ref, (2) its SHA equals local `git rev-parse <branch>`, (3) `git worktree list --porcelain` has no `.worktrees/<key>` entry | Pushed, *fully* pushed, cleaned — exactly the three observed failure modes |
| On failure | Tool error; task stays `in_progress`; message lists the exact commands to run | The agent self-remediates in the same session and resubmits |
| Degradation | repoPath relative/missing on the server, or git absent ⇒ skip all checks; no `origin` remote ⇒ skip push checks, keep worktree check; `task.branch` null (claimed before this feature) ⇒ skip | Enforce where checkable; never brick a workspace or in-flight task on deploy |
| Remote unreachable | `ls-remote` fails with a remote configured ⇒ **fail closed** ("remote unreachable — retry submit") | Fail-open would silently re-create the incident during transient outages; the push itself needed the same network moments earlier |
| Git runner | Small `runGit` helper in packages/mcp modeled on `web/server/git.ts` (execFile, no shell, `--end-of-options`, SAFE_REF guard) | Branch names are server-generated here, but the same injection discipline costs nothing; extraction into a shared package deferred until a third consumer exists |
| Schema | One nullable TEXT column + migration; `TaskDetail.branch` exposed | Minimal footprint; web UI may adopt it later |
| Descriptions | Rewritten to defer: "follow the `protocol` block in the claim payload"; `registry.test.ts` regexes updated to assert the deferral | Descriptions stop being a source of truth they cannot reliably be |

## Payload sketch

```jsonc
{
  "task": { /* TaskDetail, unchanged */ },
  "protocol": {
    "version": 2,
    "branch": "feature/AF-15-claim-time-protocol-and-guardrails",
    "worktree": "<repoPath>/.worktrees/AF-15",
    "setup": [
      "git worktree add <repoPath>/.worktrees/AF-15 -b feature/AF-15-… "
      // reclaim variant: "git worktree add <repoPath>/.worktrees/AF-15 feature/AF-15-…"
    ],
    "finish": [
      "commit all work in the worktree",
      "git push -u origin feature/AF-15-…",
      "git worktree remove <repoPath>/.worktrees/AF-15 && git worktree prune",
      "submit_result with a branch link (+ metrics if known)"
    ]
  }
}
```

## Acceptance criteria (feature-level)

1. A claim returns the `protocol` block with a server-computed `feature/<key>-<kebab>`
   branch; the name is persisted; a reclaim (request-changes or reopen) returns the **same**
   branch with the reuse-form setup, even after a title edit.
2. `submit_result` rejects an unpushed branch, a remote SHA behind local, or a surviving
   worktree — each with an actionable message — and accepts after remediation.
3. Tasks claimed before the feature (null `branch`) and non-checkable workspaces submit
   unimpeded; skipped checks are logged to stderr.
4. A repo with no `origin` remote: worktree check enforced, push checks skipped.
5. Kebab util unit-tested; registry tests assert descriptions defer to the payload;
   full suite green.
