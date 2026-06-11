# Image attachments — Implementation Plan

**Date:** 2026-06-11
**Spec:** [2026-06-11-image-attachments-design.md](../specs/2026-06-11-image-attachments-design.md)
**Status:** Implemented (2026-06-11)

Five phases (`core → web server → mcp → client → e2e/docs`). TDD per task; rebuild core
before web suites; no new dependencies.

## Phase 1 — core

- Migration #5 (`schema.ts`/`migrate.ts`); bump the six `user_version: 4` assertions to 5.
- `repo/attachments.ts`: `insertAttachment`, `attachmentsMeta` (LENGTH(bytes) AS size),
  `attachmentWithBytes`, `deleteAttachmentRow`.
- `ops/addAttachment.ts` (backlog-only, mime allowlist, ≤ 4 MB decoded, bumps
  updated_at), `ops/deleteAttachment.ts` (backlog-only via parent, bumps updated_at),
  `ops/getAttachment.ts`; `validate.ts` schema; `types.ts` `Attachment` +
  `TaskDetail.attachments`; `index.ts` bindings.
- Tests (`test/attachments.test.ts` + migration drill): fresh/in-place/no-op migration;
  byte round-trip; guards (mime, size, non-backlog 409-shape errors, NotFound);
  cascade via `deleteTask`; metadata on detail; version change on add/remove.

## Phase 2 — web server

- `routes/tasks.ts` `POST /:key/attachments` → 201 metadata; `routes/attachments.ts`
  (new) `GET /:id` (raw bytes, Content-Type, immutable cache) + `DELETE /:id` → 204;
  mount in `app.ts`; `schemas.ts` body.
- Tests: POST→GET byte-exact round-trip; DELETE→GET 404; 409 non-backlog; 400 bad mime;
  404 unknown task/attachment.

## Phase 3 — mcp

- `tools/getTask.ts` + `tools/getNextTask.ts`: append `{ type: 'image', data, mimeType }`
  per `detail.attachments` via `core.getAttachment`; mention images in both descriptions.
- Tests: attached task → `content[0]` JSON + image block with round-tripped data;
  unattached task unchanged; registry pins the description note.

## Phase 4 — client

- `src/image.ts`: `fitWithin` (pure) + `downscalePastedImage` (createImageBitmap/canvas;
  jsdom-mocked in component tests).
- `TaskForm.tsx`: onPaste → pending thumbs + ✕; edit mode lists existing with ✕
  (deletions collected); `onSubmit(fields, images, removedIds)`.
- `App.tsx` (create → addAttachment per image), `DetailPanel.tsx` (edit flow + thumbnail
  strip under Spec), `api.ts` (`addAttachment`, `deleteAttachment`, `attachmentUrl`),
  `board.css` (`.af-atts`, `.af-att`).
- Tests: fitWithin units; TaskForm paste/remove/submit contract; App create flow posts
  attachments; DetailPanel strip renders `/api/attachments/:id`; fixtures gain
  `attachments: []`.

## Phase 5 — e2e + docs

- e2e over HTTP: create → attach → detail metadata → byte-exact GET → delete task →
  attachment 404.
- Root README "Images in specs" paragraph; spec/plan → Implemented.
- Final gate: root `npm test` + `npm run build`.

## Risks / watch-outs

- `TaskDetail` widens again — sweep client fixtures in Phase 4 (same drill as metrics).
- jsdom has no canvas/createImageBitmap — keep `downscalePastedImage` un-unit-tested,
  test `fitWithin` + mock the module in component tests.
- Base64 in JSON bodies: a 4 MB image ≈ 5.4 MB body — no Hono/node-server cap in play,
  but assert the 400 path for oversized payloads at the core boundary.
