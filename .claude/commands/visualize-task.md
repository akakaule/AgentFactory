---
description: Generate a change-visualization for one AgentFactory task and attach it to the board (a self-contained HTML overview — Mermaid flow + file map — a human reviewer sees next to the description). Pass a task key (e.g. AF-12). Implementation stage only.
---

You produce a **change visualization** for one task and attach it to the board, so a human gets a
visual read of the diff next to the description. This is the `/visualize-change` treatment, sourced
from the board's diff instead of local git (so it works even after the task's worktree is pruned).
Read-only with respect to the repo; you never change task status.

## Pick the task

1. The arguments must contain a task key (`AF-<n>`); if not, say so and stop.
2. `get_task` for the brief: title, spec, acceptance criteria, and the latest result summary in the
   activity (the implementer's own claim — useful context for the flow).
3. **Implementation stage only.** If `stage` is not `implementation`, stop and report
   "visualization is implementation-only" — description/plan stages have no diff, and their
   deliverable (spec/plan text) is already shown in the panel.

## Gather the diff

4. Fetch the diff from the board's HTTP API (the same call `/review-task` uses; the MCP server has
   no diff tool): `curl -s http://localhost:8787/api/tasks/<key>/diff` returns
   `{ branch, baseRef, diff, commits }`. The diff is already merge-base scoped against the default
   branch. If it errors (e.g. no branch link yet), report that and stop.

## Build the visualization

5. Author a **single self-contained HTML file** in the **visualize-change format**. Follow the
   section order, diagram conventions, and dark styling in `~/.claude/skills/visualize-change/SKILL.md`
   — read it and apply it; don't reinvent the format. In short:
   - Title + one-line lede summarising the change.
   - A Mermaid `sequenceDiagram` (with `autonumber`) of the primary runtime flow the diff introduces
     — who calls whom, in order; label participants with role + file. Add a `flowchart` instead/also
     when the change is structural rather than a call sequence.
   - A **UI mockup** (hand-built HTML/CSS) only if the diff has a user-facing/visual change.
   - A new/modified file map grouped by area (backend / frontend / tests / infra) with `new`/`mod`
     badges; summarise repeated patterns once.
   - Inline CSS; Mermaid via `https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js` with
     `theme:'dark'`. Read key changed files only as needed to get the flow right — do not dump them.
   Write it to the session scratchpad directory, named `<key>-change.html`. **Do not open it** in a
   browser — it's going to the board, not a local viewer.

## Attach it to the board

6. POST the file to the board (raw `text/html` body, not JSON):

   ```
   curl -s -X POST -H "Content-Type: text/html" --data-binary @<scratchpad>/<key>-change.html \
     http://localhost:8787/api/tasks/<key>/visualization
   ```

   A success returns `{ "ok": true, "bytes": <n> }`. The board stores one visualization per task
   (this replaces any previous one) and bumps its version, so an open task drawer shows the
   **Change visualization** button live.

## Hard rules

- Read-only: never modify the repo, check out the branch, or touch worktrees. Your only side effect
  is the POST to the board.
- Never change task status, post an `ai-review/v1` verdict, or approve — this command only attaches
  a view. (Run `/review-task` separately for the verdict.)
- One task per invocation. Stop after the POST and report the task key + bytes attached.
