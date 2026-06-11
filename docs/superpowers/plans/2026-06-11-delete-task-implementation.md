# Delete tasks — Implementation Plan

**Date:** 2026-06-11
**Spec:** [2026-06-11-delete-task-design.md](../specs/2026-06-11-delete-task-design.md)
**Status:** Implemented (2026-06-11)

Three phases (`core → web → closeout`). TDD per task: failing test first, implement,
package suite green, full `npm test` at the end. No schema change, no MCP changes, no
dependencies.

---

## Phase 1 — core: `deleteTask` + version fix

- **Tests first:**
  - `test/deleteTask.test.ts` (new): delete a backlog task with comments + links → task
    row, activity rows, link rows all gone (query the db directly); deletable from
    queued / in_review / blocked / done; `in_progress` → `InvalidTransitionError` and
    nothing changed; unknown key → `NotFoundError`.
  - `test/version.test.ts` (extend): deleting a task that is **not** the newest row
    changes the version (RED against the MAX-only implementation); existing assertions
    adapted to the `#count` suffix.
- **Files:** `src/repo/tasks.ts` (`deleteRowById`), `src/ops/deleteTask.ts` (new),
  `src/index.ts` (export + `deleteTask(key)` binding), `src/version.ts`
  (`"<maxTs>#<count>"`).

**Phase gate:** core suite green; `npm -w packages/core run build` (web tests resolve
core's dist).

---

## Phase 2 — web: route + drawer UI

- **Server test** (`test/server/tasks.test.ts`): DELETE → 204 and subsequent GET → 404;
  DELETE on in_progress → 409 with JSON `{ message }`; DELETE unknown → 404.
- **Server:** `routes/tasks.ts` — `r.delete('/:key', …)` → `core.deleteTask` → 204.
- **Client tests** (`test/client/DetailPanel.test.tsx`): `deleteTask` joins the api
  mock; done fixture shows **Delete task**; first click arms (no api call), second click
  calls `api.deleteTask` then `onClose` + `onChanged`; in_progress fixture hides it.
- **Client:** `api.ts` (`deleteTask`, 204-safe via existing `req`), `DetailPanel.tsx`
  (danger row after CommentBox, `confirmingDelete` state reset on task switch),
  `board.css` (`.af-danger`, `.af-danger.armed` — tokens only).

**Phase gate:** full web suite green + `typecheck:client`.

---

## Phase 3 — closeout

- Root `README.md`: short "Deleting tasks" paragraph (drawer, release first, gone is
  gone). Spec/plan status → Implemented.

**Final gate:** full `npm test` green; `npm run build` clean.

---

## Risks / watch-outs

- `version.test.ts` may assert the exact pre-suffix format — adapt in the same commit.
- Stale-dist flake: rebuild core before the web suite (hit on the reopen feature).
- DetailPanel deletes must `onClose()` *after* `onChanged()` so the board refetch isn't
  racing a drawer pointing at a 404 task.
