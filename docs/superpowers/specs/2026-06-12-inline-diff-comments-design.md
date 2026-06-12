# AgentFactory — Inline diff comments that ride request-changes feedback

**Date:** 2026-06-12
**Status:** Implemented (2026-06-12)
**Grows from:** [2026-06-11 diff view](2026-06-11-diff-view-design.md) — that work made the
agent's changes *visible* on the board (per-file, line-level diff in a modal) and explicitly
deferred "commenting on diff lines; review comments stay in the activity thread." This closes
that gap. It also leans on the existing **request-changes feedback** path: feedback is already
an activity row that rides the next claim (see the agent-loop board design).

## Problem

Reviewing a diff and *acting* on it are split across two surfaces. The reviewer reads the diff
in the modal, then must scroll back to the detail panel, click **Request changes**, and
re-describe — in prose, from memory — *which* lines they meant ("the cap in app.ts around line
40-something"). The line context they were just looking at is lost in the hand-off. This is
Vibe Kanban's one genuine extension over this board's design: "review diffs and leave inline
comments — send feedback directly to the agent without leaving the UI"
(github.com/BloopAI/vibe-kanban).

## Goals

- A line in the diff modal can be **clicked to attach a draft comment**: a small editor
  anchored to that line (file + line number), with editable, removable text and a visible
  marker on commented lines.
- On **Request changes**, every draft is serialized as a `file:line`-prefixed line and
  **prepended** to the free-text feedback, in a stable format the agent can act on:

  ```
  src/app.ts:42 - "this cap should be configurable"
  README.md:7 - "typo"
  <free-text feedback from the existing textarea>
  ```

  The resulting feedback activity row contains those lines verbatim and reaches the next
  claimant in its claim payload — no new plumbing.
- Drafts are **client-only**: they live in component state, survive scrolling (and closing and
  re-opening the diff modal), and are discarded when the task panel closes, when the reviewer
  **Approves**, or once they have been folded into a request-changes submission.

## Non-Goals (deferred)

- Threaded discussion / replies. A draft is a single note on a line.
- Any persistence of comments outside the feedback body — no DB, MCP, or schema changes. If
  the reviewer never clicks Request changes, the drafts evaporate.
- Commenting outside review. The affordance only appears for an `in_review` task; other
  statuses render the diff exactly as before.
- Commenting on the *file* or *hunk* level, multi-line ranges, or suggestion blocks.

## Design

### Where the state lives

`DetailPanel` already renders both the `Changes` section (which owns the `DiffModal` →
`DiffView`) and `ReviewActions` as siblings. The draft store is lifted to `DetailPanel` so the
modal can write drafts and the review actions can read them. A small hook, `useDiffComments`,
holds `DiffComment[]` (`{ file, line, text }`) with `upsert` / `remove` / `clear`. Because the
state lives in `DetailPanel`, it naturally resets when the panel unmounts ("closing the task")
but persists across modal open/close and scrolling.

The store is threaded down as an **optional** prop (`Changes → DiffModal → DiffView`) and is
passed **only when `task.status === 'in_review'`**. When absent, every component renders
exactly as it does today — that is how "no commenting outside review" and "ReviewActions
unchanged when there are no drafts" are both satisfied for free.

### Anchoring a comment to a line

The parser (`client/src/diff.ts`) already computes `oldNo` / `newNo` per line. A comment
anchors to the file's post-change path (`newPath || oldPath`, so renames still point at a real
path) and the line's **new-line number** (`newNo`). Only lines that carry a new-line number —
added and context lines — are commentable; pure-deletion and meta lines are not. Anchoring on
`newNo` (rather than `newNo ?? oldNo`) is both faithful to the spec wording and collision-free:
within one file each `newNo` is unique, whereas a deleted line's `oldNo` could otherwise clash
with an added line's `newNo`. Clicking a commentable line opens an inline editor below it.
Lines that already carry a draft show the comment text plus Edit / Remove, and the line itself
is marked. One comment per line; editing replaces in place (insertion order preserved).

### Serialization

`serializeFeedback(comments, freeText)` is a pure function:

- Each non-empty draft → `${file}:${line} - "${text}"`, joined by newlines, in insertion order.
- The trimmed free-text feedback is appended after the draft block.
- Empty drafts are dropped; with no drafts the function returns the free text unchanged (so
  `ReviewActions` behaves identically when nothing was annotated).

`ReviewActions` builds the combined body with this function and submits when it is non-empty —
so a reviewer may submit drafts alone, free text alone, or both, but not nothing.

### Discarding

- **Approve** clears the store (and the task leaves review anyway).
- **Request changes** clears the store after the combined feedback is handed off.
- Closing the panel unmounts the hook.

## Acceptance criteria → design mapping

1. *Click a line → draft (marker + editable + removable); survives scroll, not close* →
   clickable non-meta lines in `DiffView`, inline editor, `has-comment` marker; store in
   `DetailPanel` (survives modal/scroll, dies with the panel).
2. *Request changes serializes drafts as file:line lines prepended to feedback, verbatim, to
   the next claimant* → `serializeFeedback`; rides the existing `requestChanges` activity row.
3. *ReviewActions unchanged with no drafts* → `comments` defaults to empty; `serializeFeedback`
   is identity on free text; store passed only in review.
4. *Tests for anchor/serialize/discard; spec + plan; suite green; no new deps* → unit tests for
   the hook + pure function, component tests for `DiffView` and `ReviewActions`, this doc + the
   plan. Pure React/TS; zero new dependencies.
