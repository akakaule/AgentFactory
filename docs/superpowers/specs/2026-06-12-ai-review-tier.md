# AgentFactory — Automated First-Pass Review Tier (AF-13)

**Date:** 2026-06-12
**Status:** Approved design, ready for implementation
**Builds on:** [2026-06-09-agent-loop-task-board-design.md](./2026-06-09-agent-loop-task-board-design.md)

## Summary

Today the only review of an agent's result is the human gate on `in_review`. This adds an
**automated first-pass review tier** that runs *before* the human looks: an external loop
fetches the diff of an `in_review` task, runs an LLM review, and posts its findings back as a
comment. The board then surfaces that verdict on the card + drawer, and treats *approving a task
that still has open AI findings* as a recorded **override** — making the human gate a
break-glass decision rather than the only line of defence.

Prior art: GitHub Copilot's agent self-review before opening a PR; Cloudflare's blocking AI
review with a ~0.6% human override rate (blog.cloudflare.com/ai-code-review). Cloudflare's
quality KPI is the **override rate** — how often a human approves past the bot — which we add
alongside first-pass approval.

## Hard constraint: the board never runs agents

The board is a state store + UI. It does **not** spawn the reviewer. The reviewer is an
**external loop** (sibling to `ado-bridge` / `Run-AgentFactoryLoop.ps1`), living in the
`agentdemo` repo next to the other loops. It:

1. Polls the board for `in_review` tasks (`GET /api/tasks?status=in_review`).
2. Fetches each task's diff from `GET /api/tasks/:key/diff`.
3. Runs `claude -p` (or any reviewer) over the diff.
4. Posts findings back through the **existing comment API** — no new endpoint, no schema change.

This repo only gains the **board-side surfaces** that read those comments. The board remains
agent-free.

## The marker convention (the contract with the external loop)

An **AI-review comment** is any `comment`-type activity whose body, ignoring leading
whitespace, **begins with the marker `ai-review:`** (case-insensitive). Detection is by marker
only — it is **actor-independent**, so the reviewer may post via the HTTP comment route
(`actor: human`) or the MCP `add_comment` tool (`actor: agent`); both are recognised.

The structured verdict is carried as a single JSON object embedded anywhere in the body (the
substring from the first `{` to the last `}`):

```
ai-review: 2 findings — changes requested
{
  "version": 1,
  "verdict": "changes",
  "findings": [
    { "severity": "warning", "title": "Unbounded retry loop", "file": "src/x.ts", "line": 42 },
    { "severity": "info",    "title": "Missing test for the empty case" }
  ]
}
```

Field shape (v1):

| Field | Type | Meaning |
|-------|------|---------|
| `version` | number | marker version (1) |
| `verdict` | `"approve"` \| `"changes"` | the reviewer's recommendation (advisory) |
| `findings` | `Finding[]` | the open findings; **count = `findings.length`** |

`Finding = { severity?: "info"|"warning"|"error", title: string, detail?: string, file?: string, line?: number }`

**Findings count** is the single number the board cares about:

- `findings.length` when the JSON carries a `findings` array,
- else the JSON's `findings` field if it is a plain number,
- else a tolerant read of the first line: `/(\d+)\s+finding/i`,
- else **0** (marker present but no parseable count ⇒ treated as a *clean* advisory).

`0` findings = **clean**. The first line should stay human-readable (it renders verbatim in the
activity thread); the JSON is for the machine.

### Why a prefix + embedded JSON (and not pure JSON, or a pure prefix)

A pure-JSON body is unreadable in the activity thread; a pure prefix (`ai-review: 2 findings`)
can't carry structured findings for future drill-down. The prefix gives a human-readable
timeline line *and* marker detection in one `LIKE 'ai-review:%'` scan; the embedded JSON gives a
precise, forward-compatible count. The parser degrades gracefully if the JSON is malformed, so a
minimal `ai-review: clean` comment is still valid.

## Board-side surfaces

### 1. Findings chip (card + drawer)

A derived, read-only field `aiReview: { findings: number } | null` rides on the task DTO
(`Task` summary *and* `TaskDetail`), computed from the **latest** ai-review comment:

- `null` — no ai-review comment exists (no chip).
- `{ findings: 0 }` — clean → green chip **"AI review: clean"**.
- `{ findings: n }` — amber chip **"AI review: n findings"**.

It is **purely derived** at read time from the `activity` table — no new column, no migration.
The in_review **card** and the **drawer** both render the chip from this field.

### 2. Break-glass approve (recorded override)

The board never *blocks* the human. When the latest ai-review has open findings (> 0), the
drawer's **Approve** button arms a one-step confirm ("Approve despite N findings?") and a note
explains the click is recorded as an override. A clean or absent review keeps Approve a single
click. This is the break-glass UX, not a gate.

### 3. Override-rate KPI

An approval of a task whose ai-review-at-approval had open findings **is an override**. This is
**derivable from the activity log** with no schema change: walk the status history; the verdict
"at approval" is the findings count of the latest ai-review comment seen *before* the task's
final `→ done` transition.

Analytics gains an **AI override rate** KPI:

- **denominator `d`** = done tasks that had an AI review present at approval,
- **numerator `n`** = those approved with findings > 0,
- **rate** = `n / d`.

Per the n/m annotation discipline: a done task with **no AI review present is excluded** from
both numerator and denominator (never counted as a clean zero). When `d == 0` the KPI shows
**n/a** ("no AI reviews"), exactly as cost-per-task shows n/a under zero coverage.

## Data model

**No schema change.** Everything is derived from the existing `activity` table:

- `aiReview` (DTO field) — from the latest `ai-review:` comment.
- `aiReviewFindings` (analytics row field) — the findings standing at the final `→ done`.

## Testing

- **core** — `parseAiReview` (marker detection, JSON count, numeric `findings`, tolerant
  first-line fallback, clean, non-marker → null); `findingsAtApproval` (verdict snapshotted at
  the final done, survives a reopen); `aiReview` present on `Task`/`TaskDetail`; analytics row
  carries `aiReviewFindings`.
- **web client** — override-rate KPI math (excluded when no review, n/a at zero coverage);
  `AiReviewChip` rendering; the break-glass confirm in `ReviewActions`; AnalyticsView KPI card.
- Full suite (`npm test`) green; `npm run build` green; **no new dependencies**.

## Out of scope (lives in the external repo)

The reviewer loop script itself (poll → diff → `claude -p` → post). This spec is its contract.
