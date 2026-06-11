# AgentFactory — Delete tasks

**Date:** 2026-06-11
**Status:** Implemented (2026-06-11)
**Grows from:** [2026-06-09 task board design](2026-06-09-agent-loop-task-board-design.md) —
the lifecycle covers create through done (and now reopen), but nothing ever leaves the
board.

## Problem

Stale experiments, duplicates, and abandoned ideas accumulate forever; the only way to
remove a task is hand-editing the SQLite file. A board that can only grow stops being a
queue and starts being a landfill.

Adjacent gap discovered while designing: `getVersion` is `MAX(updated_at/created_at)`
across tables. Deletion never *raises* a max, so deleting any task that isn't the newest
row would not bump the SSE version — other open boards would silently keep showing a
dead task. The version string must also reflect row count.

## Goals

- A human can delete a task from the board; its activity and links go with it.
- A live worker is never yanked mid-flight: `in_progress` tasks cannot be deleted —
  release the claim first (the existing rescue), then delete.
- Deletion propagates to other open boards via SSE like every other mutation.
- Zero schema change, no new error machinery.

## Non-Goals (deferred)

- Archive / soft delete / undo — gone is gone; this is a single-user local tool.
- An MCP delete tool — deletion is human-only, like task creation.
- Bulk delete, board multi-select.
- Workspace deletion (still doesn't exist; unchanged).

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Semantics | **Hard delete** | `activity`/`link` already declare `ON DELETE CASCADE` and every connection runs `foreign_keys = ON` — one DELETE, no schema change, no archived-state chrome in queries/UI. |
| Deletable statuses | All **except `in_progress`** | Deleting under a live worker turns its next `submit_result`/`add_comment` into a confusing NotFound mid-flight. Release the claim first (`in_progress → queued`), then delete — consistent with the human-rescue discipline. Attempt → `InvalidTransitionError` (existing 409 mapping). |
| Who | Human only — `DELETE /api/tasks/:key` (204), no MCP tool | Same authority model as creation: the agent consumes and progresses work items; the human curates the board. |
| SSE correctness | `getVersion` → `"<maxTs>#<task count>"` | Deletes change the count; creates/updates change the max. The string is opaque and only compared for inequality, so the format change is invisible to consumers. |
| Confirm UX | Two-step inline confirm in the drawer: **Delete task** → red **Confirm delete?** in place; resets when the panel switches tasks | Destructive and irreversible, so one mis-click must not be enough — but native dialogs break the dark UI and component tests. |
| Activity record | None (it cascades away anyway) | A deletion log for deleted tasks has nowhere to live by definition; out of scope with archive/undo. |

## Surfaces

- **core:** `deleteTask(key)` op — NotFound on unknown key, InvalidTransition on
  `in_progress`, else `DELETE FROM task WHERE id = ?` (cascade cleans the rest);
  `getVersion` count suffix.
- **web server:** `DELETE /api/tasks/:key` → 204; existing `mapError` covers 404/409
  with JSON bodies.
- **web client:** `api.deleteTask`; DetailPanel danger row at the bottom of the drawer
  (hidden for `in_progress`), two-step confirm, closes the drawer and refreshes the
  board on success.

## Acceptance criteria (feature-level)

1. Deleting a task removes it and all its activity/link rows; GET returns 404 afterward.
2. Deleting an `in_progress` task is rejected with 409 and changes nothing; after
   Release claim it succeeds.
3. A second open board sees the deletion via SSE within one poll interval — including
   when the deleted task is not the most recently touched row.
4. The drawer shows Delete task on every status except `in_progress`; the first click
   arms, only the second click deletes; switching tasks disarms.
5. No schema change, no MCP changes; full suite green.
