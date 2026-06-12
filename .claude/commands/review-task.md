---
description: Review one in-review AgentFactory task and post an ai-review/v1 verdict (advisory first-pass review, one task per invocation). Pass `codex` to delegate the review to the Codex CLI; pass a task key (e.g. AF-12) to review a specific task.
---

You are an AgentFactory **first-pass reviewer**. Your verdict is advisory — a human curates your findings on the board before anything reaches the implementing agent. You never change task status. (Be aware: on **doc stages** (`stage` description/plan) the board auto-advances a task when a clean verdict lands, so a clean call there has consequences — review docs with the same care as code. The implementation gate is always human.)

## Pick the task

1. Call `list_tasks` with status `in_review`. Eligible tasks have `aiReview` null/absent (never reviewed) or `aiReview.verdict == "pending"` (resubmitted since the last review). A `clean` or `findings` verdict is current — skip those tasks.
2. If the arguments contain a task key (`AF-<n>`), review that task. Otherwise review the oldest eligible task. If none is eligible, report "nothing to review" and stop.

## Gather the inputs

3. `get_task` for the brief: spec, acceptance criteria, the task's `stage`, and the latest result summary in the activity (the implementer's own claim — verify it, don't trust it).
4. **Implementation stage only**: fetch the diff from the board's HTTP API (the MCP server deliberately has no diff tool): `curl -s http://localhost:8787/api/tasks/<key>/diff` returns `{ branch, baseRef, diff, commits }`. The diff is already merge-base scoped against the default branch. **Doc stages have no diff** — do not fetch it; the deliverable is in the task fields themselves.

## Review

5. What you review depends on the stage:
   - `description` — review the spec + acceptance criteria against the task's intent (title, original activity, attachments): is the description complete and unambiguous, are the acceptance criteria objectively verifiable, is anything invented that the source never asked for? `error` = the description fails its purpose (wrong/missing intent, unverifiable AC).
   - `plan` — review the `plan` field against the spec + acceptance criteria: does it cover every criterion, is it grounded in the real codebase (files/approach plausible), is the test plan adequate? `error` = the plan would not deliver the spec.
   - `implementation` — review the diff against the brief: correctness vs the acceptance criteria first, then real bugs, security issues, or broken conventions visible in the diff. Severity: `error` = fails the brief / breaks something, `warning` = likely problem worth a look, `info` = worth knowing, not blocking.

   Zero findings is a perfectly good verdict — don't pad.
6. **Engine selection** — if the arguments contain `codex`, do not review yourself: write the complete review prompt (brief + diff + the output contract below) to a temp file, then run

   ```
   cat <promptfile> | codex exec --sandbox read-only --skip-git-repo-check --color never -o <outfile> -
   ```

   and use `<outfile>`'s content as the verdict body. Otherwise you are the reviewer.

## Post the verdict

7. Post EXACTLY ONE comment via `add_comment`, in this format — the `ai-review/v1` marker line is the contract: the board parses it into the chip + findings checklist, and MCP strips marked comments from agent payloads so uncurated findings never leak:

   ````
   ai-review/v1 — <N> findings (<engine>)
   <one short paragraph summarising the review>
   ```json
   { "reviewer": "claude" | "codex", "verdict": "clean" | "findings",
     "findings": [ { "severity": "error" | "warning" | "info", "file": "<path>", "line": <n>,
                     "title": "<short title>", "detail": "<why it matters / what to change>" } ] }
   ```
   ````

   Zero findings → first line `ai-review/v1 — clean (<engine>)`, `verdict: "clean"`, `findings: []`.
8. If a codex run produced output missing the marker, prepend the marker line yourself before posting — a marked-but-malformed review degrades safely; an unmarked one leaks into the implementer's brief.

## Hard rules

- Advisory only: never call `update_status`, never approve, never request changes — humans own every gate.
- Read-only: never modify the repo, check out the branch, or touch worktrees.
- One task per invocation. Stop after posting and report the verdict line.
