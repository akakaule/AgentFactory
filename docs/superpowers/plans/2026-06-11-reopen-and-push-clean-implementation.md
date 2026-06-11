# Reopen + push-and-clean — Implementation Plan

**Date:** 2026-06-11
**Spec:** [2026-06-11-reopen-and-push-clean-design.md](../specs/2026-06-11-reopen-and-push-clean-design.md)
**Status:** Implemented (2026-06-11)

Three phases, dependency-ordered (`core → web → mcp/docs`). TDD per task: failing test
first, implement, package suite green, full `npm test` at the end. No new ops, routes,
tools, columns, or dependencies.

---

## Phase 1 — core: reopen transition

- **Tests first** (both currently assert the opposite — flip them):
  - `test/transitions.test.ts`: move `['done','queued','human']` from the rejected table
    to `VALID`; add `isValidTransition('done','queued','agent') === false`.
  - `test/updateStatus.test.ts`: drop `['done','queued','human']` from the rejected
    `it.each`; add an allowed-edge test — done task with stale claim metadata reopens to
    `queued`, claim fields cleared (choke-point), `status_change` activity row written;
    add agent-actor rejection.
- **Files:** `src/transitions.ts` — one rule:
  `{ from: 'done', to: 'queued', by: 'human' } // reopen (e.g. CI failed on the PR)`.

**Phase gate:** core suite green.

---

## Phase 2 — web: Reopen button (server needs no changes)

- **Server test** (`test/server/tasks.test.ts`): drive a task to done via core
  (`claimNextTask` → `submitResult` → approve over HTTP), then
  `POST /:key/status { status: 'queued' }` → 200 with cleared claim fields.
- **Client:** `components/DetailPanel.tsx` — `status === 'done'` block in `af-d-tags`:
  **Reopen** button → `api.setStatus(task.key, 'queued')`, title-hint for the CI-failure
  use case. Mirrors the Release claim button.
- **Client tests** (`test/client/DetailPanel.test.tsx`): done fixture shows Reopen and
  clicking calls `setStatus(key, 'queued')`; backlog/in_review fixtures show no Reopen.

**Phase gate:** web suite green.

---

## Phase 3 — mcp convention + docs

- **Test first** (`test/registry.test.ts`): extend the worktree-convention test —
  `get_next_task` description matches branch-reuse (worktree add from an existing
  `task/<key>` branch), `submit_result` description matches `git push -u origin` and
  `git worktree remove`.
- **Files:** `src/tools/getNextTask.ts`, `src/tools/submitResult.ts` — description text
  only; `packages/mcp/README.md` worktree-convention section (finish protocol +
  re-claim + reopen pointer); root `README.md` — PR/CI loop paragraph.
- Spec/plan status → Implemented.

**Final gate:** full `npm test` green; `npm run build` clean.

---

## Risks / watch-outs

- Other tests may assert `done` is terminal — sweep for `done.*queued` assertions
  (`transitions.test.ts` and `updateStatus.test.ts` found; invariants.test.ts clean).
- Description rewording must keep `registry.test.ts`'s existing regexes matching
  (`git worktree add`, `<repoPath>/.worktrees/`).
- Estimated touch: ~3 source files + ~4 test files + 4 docs across 3 packages.
