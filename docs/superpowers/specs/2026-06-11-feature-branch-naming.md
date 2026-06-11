# AgentFactory — Feature-branch naming (`feature/<key>-<kebab-title>`)

**Date:** 2026-06-11
**Status:** Implemented (2026-06-11)
**Amends:** [2026-06-11 reopen + push-and-clean](2026-06-11-reopen-and-push-clean-design.md) —
the finish protocol already pushes the branch to `origin` before submit; this changes only
**what the branch is called**, for PR-host-friendly naming (e.g. Azure DevOps branch folders).

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Branch name | `feature/<task-key>-<kebab-title>` (e.g. `feature/AF-12-barcode-scanner-intake-form`) | Readable in the PR host's branch picker *and* unique/deterministic — two similar titles can't collide, and a re-claim (feedback/reopen) derives the same name from the claimed payload. |
| Slug rule | title lowercased → runs of non-alphanumerics → `-` → trim edge dashes → truncate to 40 chars (no trailing dash); empty slug → `feature/<key>` | Simple enough to state in a tool description so any MCP runtime derives the identical name. Titles are immutable after backlog, so the name is stable for the task's life. |
| Worktree path | `.worktrees/<task-key>` (unchanged) | Internal and key-stable; no reason to carry the slug. |
| Where encoded | MCP tool descriptions (`get_next_task`, `submit_result`), READMEs, and the board card's branch chip via a shared client helper (`client/src/branch.ts: taskBranch`) | Same channel as the rest of the worktree convention. The chip was the one hardcoded `task/<key>` in product code. |
| Existing branches | Untouched — the diff view, links, and analytics are branch-name-agnostic (they read the submitted `branch` link label) | Old `task/<key>` branches keep reviewing fine; only newly claimed work uses the new names. |

## Non-Goals

- Renaming existing remote branches or migrating old links.
- Board-side enforcement — the convention lives in instructions; the board accepts any
  label a worker submits (validated only by the diff endpoint's ref allowlist, which
  `feature/...` passes).
