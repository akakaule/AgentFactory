# AgentFactory — Image attachments (paste into the spec, hand to the agent)

**Date:** 2026-06-11
**Status:** Implemented (2026-06-11)
**Grows from:** [2026-06-09 task board design](2026-06-09-agent-loop-task-board-design.md) —
the spec is the agent's brief, but it has been text-only.

## Problem

Describing a UI bug, a design reference, or a whiteboard sketch in prose is lossy. The
human should be able to **Ctrl+V a screenshot while writing the task** (terminal-style
paste), and the agent should receive the actual image when it claims the work — not a
description of it.

## Goals

- Paste images into the task form (create + backlog edit); thumbnails in the form and in
  the detail drawer; click for full size.
- The claimed/fetched MCP payload carries the images as **`image` content blocks**, so a
  Claude-based runtime passes the pixels to the model.
- One-file story preserved: bytes live in the shared SQLite as blobs and cascade with
  task deletion.

## Non-Goals (deferred)

- Images on comments / request-changes feedback (spec-level only in v1).
- File picker or drag-drop — paste only, per the requested terminal-like flow.
- Storing originals — images are downscaled client-side before upload.
- Non-image attachments (PDFs etc.); inline placement markers in the spec text.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Storage | **Migration #5** `attachment` (`task_id` FK CASCADE, filename, mime, `bytes BLOB`, created_at) | Blobs keep the shared-SQLite one-file model; `node:sqlite` round-trips `Uint8Array`; deletion cascades with the task. |
| Size discipline | Client downscales to ≤ **1568 px** long edge (the model's effective resolution) before upload; server/core hard-reject > **4 MB** decoded | Bigger pixels are wasted on the model and bloat the DB; the cap turns abuse into a clean 400. |
| Mutation rule | Add/remove **backlog-only** (same rule as `updateTask`); attachment mutations **bump task.updated_at** | The spec is frozen once queued — the agent's brief must not change mid-flight. The updated_at bump makes SSE/version/board reflect attachment edits for free. |
| Wire format | `POST /api/tasks/:key/attachments` with JSON `{ filename, mime, dataBase64 }` → 201 metadata; `GET /api/attachments/:id` → raw bytes (immutable cache); `DELETE /api/attachments/:id` → 204 | JSON keeps the existing client/zod conventions (no multipart); ids are append-only so the GET is safely immutable-cacheable. |
| Payload shape | `TaskDetail.attachments: [{ id, taskId, filename, mime, size }]` — metadata only | Lists/details stay light; bytes go over the binary route and the MCP image blocks. |
| Agent hand-over | `get_next_task` / `get_task` append one `{ type: 'image', data, mimeType }` block per attachment after the JSON text block | MCP SDK ≥ 1.x tool results support image content; the JSON's `attachments` metadata lets the agent correlate filenames to blocks. |
| Mime allowlist | `image/png`, `image/jpeg`, `image/webp`, `image/gif` | What clipboards and models actually handle. |

## Acceptance criteria

1. Pasting a screenshot into the task form shows a removable thumbnail; creating the task
   persists it; the drawer shows the thumbnail and full size opens from the binary route.
2. The MCP payload for a task with attachments contains image content blocks whose bytes
   round-trip exactly; tasks without attachments are unchanged.
3. Attachment add/remove is rejected (409) outside backlog; bad mime or > 4 MB → 400;
   unknown ids → 404; deleting a task removes its attachment bytes (GET → 404).
4. Attachment mutations bump the task's `updatedAt` (board/SSE reflect them).
5. Migration #5 applies fresh and in-place from v4; full suite green; no new deps.
