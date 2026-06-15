# Reviewer supervisor — implementation plan

**Date:** 2026-06-15
**Status:** Implemented
**Design:** [2026-06-15 reviewer supervisor](../specs/2026-06-15-reviewer-supervisor-design.md)

A new `packages/reviewer` Node supervisor that mirrors the dispatcher but watches the
`in_review` stage: poll → pick tasks needing review → run an AI review (codex/claude) → post
an `ai-review/v1` verdict. Advisory only; the board's `add_comment` hook does the advancing.

## Steps (as built)

1. **Extract the diff util into core.** Move `branchDiff`/`resolveBaseRef`/`GitError`/
   `BranchDiff` from `packages/web/server/git.ts` into `packages/core/src/git.ts`, export from
   core's index, and make `packages/web/server/git.ts` a thin re-export (web routes/tests
   unchanged). Imports only node built-ins + core errors, so it is reusable Core-side.

2. **Scaffold `packages/reviewer`.** `package.json` (`@agentfactory/reviewer`, deps: core +
   zod — no MCP), `tsconfig.json` (ref core), `src/config.ts` (zod schema + `loadConfig`),
   `src/types.ts` (`ReviewerCore` surface, `SpawnRequest` with `stdin`, `ReviewerDeps`).
   Root wiring: `package.json` workspaces + `reviewer`/`reviewer:dev` scripts, root
   `tsconfig.json` project ref, `vitest.workspace.ts`, `.gitignore` (`reviewer.config.json`),
   `reviewer.config.example.json`.

3. **`engine.ts` + `review.ts`.** `resolveEngineCommand` (`AGENTFACTORY_{CODEX,CLAUDE}_BIN`
   override → PATH lookup → platform shim) + `buildEngineArgs` (codex `exec` read-only with
   `--output-last-message`; claude `-p` text single-turn). Per-stage prompts ported from the
   ado-bridge `lib/Review.ps1` (implementation diff / description / plan), each ending in the
   strict `ai-review/v1` contract; `truncateDiff`; `ensureMarker`.

4. **`reviewer.ts` supervisor + `index.ts` wiring.** Poll per workspace, dedup on
   `aiReview` (`absent || pending`), spawn one engine per task with the prompt on STDIN
   (cwd = `logs/`), reap → read verdict (codex file / claude stdout) → `ensureMarker` →
   `addComment(actor:'agent')`. Timeout/crash/empty → burn an attempt, skip-list at
   `maxAttempts`, post nothing. `index.ts` wires the real spawn (writes STDIN, Windows
   `.cmd` path), `openCore`, `branchDiff` as `computeDiff`, log dir, SIGINT/SIGTERM.

5. **Tests + verify.** Mirror `packages/dispatcher/test` (faked spawn + real in-memory
   `openCore`): poll/dedup (incl. pending), codex-stdin & claude-stdout paths, clean-doc
   auto-advance vs implementation human-gate, marker-prepend, empty/timeout → no-comment +
   skip-list; plus unit tests for `config`/`engine`/`review`.

## Reuse (not rebuilt)

- `core.listTasks`/`getTask`/`addComment`; the derived `task.aiReview.verdict` dedup signal.
- The board's auto-advance hook (`ops/addComment.ts` → `applyApproval`) — fires on the
  agent-posted clean doc-stage verdict; implementation escalates to the human gate.
- Dispatcher scaffolding (config loading, deps injection, poll/spawn/reap/log, command
  resolution, graceful shutdown) — mirrored as a sibling, not yet a shared abstraction.
- Review prompts + the `ai-review/v1` body format — ported from ado-bridge `lib/Review.ps1`.

## Verification (actual)

- `tsc -b` (whole monorepo) clean.
- 35 reviewer unit tests pass (config / engine / prompts / supervisor).
- Full suite green (694 tests). The web git-fixture test that occasionally times out under
  full-suite parallel load is pre-existing Windows temp-dir contention — it passes in isolation
  and on retry; the extracted git code is a verbatim move.

## Out of scope / notes

- Advisory only — never approves or requests changes.
- Engine = pure reviewer (headless, neutral cwd, read-only, no MCP, no checkout).
- Branches off `main`; no migration (uses pre-existing core + the extracted diff util).
- Deferred: stamping OTel `task.key` on review sessions for per-task review-token attribution
  (the env hook is the same one the dispatcher uses — see `docs/token-telemetry.md`); and a
  shared dispatcher/reviewer supervisor abstraction.
