# Inline diff comments — Implementation Plan

**Date:** 2026-06-12
**Spec:** [2026-06-12-inline-diff-comments-design.md](../specs/2026-06-12-inline-diff-comments-design.md)
**Status:** Implemented (2026-06-12)

Four phases, dependency-ordered (`store/serialize → diff viewer → review action → panel
wiring`). TDD per unit: failing test first, implement, package suite green, full `npm test`
before submit. Everything lives in `packages/web/client`; no new dependencies, no
server/core/mcp/schema changes.

---

## Phase 1 — draft store + serialization (`client/src/diffComments.ts`, new)

- `DiffComment` = `{ file: string; line: number; text: string }`.
- `serializeFeedback(comments, freeText)` — pure. Non-empty drafts → `file:line - "text"`,
  joined by `\n` in insertion order, then trimmed free text appended. No drafts → free text
  unchanged; both empty → `''`.
- `useDiffComments()` hook → `{ comments, upsert(file,line,text), remove(file,line), clear() }`.
  `upsert` replaces in place (preserves order); empty text removes; `useCallback` for stable
  refs.
- **Tests** (`test/client/diffComments.test.ts`, new): serialize (drafts only / free only /
  both / empties dropped / order); hook upsert→edit-in-place→remove→clear via `renderHook`.

**Gate:** new tests green; `tsc` clean.

## Phase 2 — clickable lines + inline editor (`client/src/components/DiffView.tsx`)

- Add optional `commentStore?: DiffCommentStore | undefined` prop. When present, lines with a
  new-line number become `role="button"` (`aria-label="Comment on <file> line <n>"`), open a
  one-at-a-time inline editor (`LineComment`, local) below the line; committed drafts render as
  a marked line + comment row with Edit / Remove.
- Anchor file = `newPath || oldPath`; line = `newNo` (added/context lines only — collision-free,
  spec-faithful). Deletion/meta lines render unchanged.
- When the prop is absent, rendering is byte-for-byte unchanged.
- **Tests** (extend `test/client/DiffView.test.tsx`): click line → editor; type + Comment →
  marker/text via the store; Remove clears; no `commentStore` → no buttons (unchanged).

**Gate:** DiffView tests green.

## Phase 3 — feedback serialization at submit (`client/src/components/ReviewActions.tsx`)

- Add optional `comments?: DiffComment[]` (default `[]`). `handleRequestChanges` builds
  `serializeFeedback(comments, feedback)`; submit only when non-empty.
- **Tests** (extend `test/client/ReviewActions.test.tsx`): no drafts → existing behavior
  intact (free text passed verbatim, empty blocked); with drafts → combined `file:line` body;
  drafts-only with empty textarea still submits.

**Gate:** ReviewActions tests green.

## Phase 4 — panel wiring (`Changes.tsx`, `DiffModal.tsx`, `DetailPanel.tsx`, `board.css`)

- Thread `commentStore?` through `Changes → DiffModal → DiffView`.
- `DetailPanel`: `const comments = useDiffComments()`; pass to `Changes` only when
  `in_review`; pass `comments.comments` to `ReviewActions`; `clear()` on approve and on
  request-changes.
- `board.css`: `.commentable` (hover/cursor), `.has-comment` (marker accent),
  `.af-diff-comment` (draft row), `.af-diff-cbox` (editor) — reuse existing tokens.
- **Tests** (extend `test/client/DetailPanel.test.tsx`): in_review still renders ReviewActions;
  approve path calls `api.approve` (drafts discarded). Existing Changes/DetailPanel tests must
  stay green (optional prop, default off).

**Gate:** full `npm test` + `npm run build` green from the worktree root.

---

## Risks / notes

- **`exactOptionalPropertyTypes`:** optional store prop typed `… | undefined` so the
  conditional `in_review ? store : undefined` pass typechecks.
- **Collision avoided:** anchoring on `newNo` only (not `newNo ?? oldNo`) keeps anchors unique
  within a file, so a deleted line and an added line that share a number never collide.
- **No new deps:** `renderHook` ships with the already-present `@testing-library/react` v16.
