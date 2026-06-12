# AgentFactory — Automated First-Pass Review Tier (AF-13)

**Date:** 2026-06-12
**Status:** Implemented (round 2 — curated feedback)
**Authoritative design:** [2026-06-12-agent-review-tier-design.md](./2026-06-12-agent-review-tier-design.md)
**Builds on:** [2026-06-09-agent-loop-task-board-design.md](./2026-06-09-agent-loop-task-board-design.md)

## Summary

The only review of an agent's result used to be the human gate on `in_review`. This adds an
**automated first-pass review tier** that runs *before* the human looks: an external loop
fetches the diff of an `in_review` task, runs an LLM review (Claude *or* Codex), and posts its
findings back as a comment. The board then (1) surfaces that verdict on the card + drawer,
(2) renders the findings as a **checklist the human curates**, (3) composes the *selected*
findings plus the human's own notes into one attributed feedback body on **Request changes**,
(4) strips the raw review out of the agent-facing payload, and (5) treats *approving past open
findings* as a recorded **override**, surfaced as a quality KPI.

Prior art: GitHub Copilot's agent self-review before opening a PR; Cloudflare's blocking AI
review with a ~0.6% human override rate (blog.cloudflare.com/ai-code-review). The override rate
is Cloudflare's quality KPI: how often a human approves past the bot.

## Hard constraint: the board never runs agents

The board is a state store + UI. It does **not** spawn the reviewer. The reviewer is an
**external loop** (sibling to `Run-AgentFactoryLoop.ps1` in the ado-bridge repo, `-Reviewer
claude|codex` selecting the engine). It:

1. Polls the board for `in_review` tasks (`GET /api/tasks?status=in_review`).
2. Fetches each task's brief (`GET /api/tasks/:key`) and diff (`GET /api/tasks/:key/diff`).
3. Runs the reviewer over the diff.
4. Posts findings back through the **existing comment API** — no new endpoint, no schema change.

This repo only gains the **board-side surfaces**. The board remains agent-free.

## The `ai-review/v1` marker convention (the contract with the loop)

An **AI-review comment** is any `comment`-type activity whose body, ignoring leading
whitespace, **begins with the marker `ai-review/v1`** (case-insensitive, word-bounded so
`ai-review/v10` does not match). Detection is by marker only — **actor-independent**, so the
reviewer may post via the HTTP route (`actor: human`) or the MCP `add_comment` tool
(`actor: agent`); both are recognised.

One comment per review round: a marker line + a short human-readable summary + a fenced JSON
block (the parser also accepts a bare `{…}` object for resilience):

````
ai-review/v1 — 2 findings (codex)
Two issues worth a look before this lands.
```json
{
  "reviewer": "codex",
  "verdict": "findings",
  "findings": [
    { "severity": "warning", "file": "src/x.ts", "line": 42, "title": "Unbounded retry loop", "detail": "no max attempts" },
    { "severity": "info", "title": "Missing test for the empty case" }
  ]
}
```
````

Field shape (v1):

| Field | Type | Meaning |
|-------|------|---------|
| `reviewer` | string | the engine label (`codex`, `claude`, …); used in feedback attribution |
| `verdict` | `"clean"` \| `"findings"` | the reviewer's recommendation (advisory) |
| `findings` | `Finding[]` | the open findings; **count = `findings.length`** |

`Finding = { title: string, severity?: "info"|"warning"|"error", file?: string, line?: number, detail?: string }`

- A finding with no `title` is dropped (not renderable); unknown severities normalise to none.
- **Malformed degrades to a plain comment for rendering**: a marker comment whose JSON is absent,
  unparseable, or lacks a `findings` array carries **no chip and no checklist** — it just shows as
  text in the activity feed. (It is still hidden from the agent — see *Agent-facing payload*.)

## Board-side surfaces

### 1. Verdict chip (card + drawer)

A derived, read-only field `aiReview: AiReviewSummary | null` rides the task DTO (summary *and*
detail), from the **latest** ai-review comment vs. the **latest result**:

- `null` — no ai-review comment (no chip).
- `verdict: 'clean'` (0 findings) — green **"AI review: clean"**.
- `verdict: 'findings'` (N>0) — amber **"AI review: N findings"**.
- `verdict: 'pending'` — grey **"AI review: pending"**: a `result` activity is newer than the
  latest review (a resubmission is awaiting re-review).

Purely derived at read time from the `activity` table — no column, no migration.

### 2. Findings checklist + curation composer (drawer)

For an `in_review` task whose review carries findings, the drawer renders them as a **checklist**
(checked by default). **Request changes** opens a composer: the checked findings, each attributed
`[reviewer-<name>] …`, plus a free-text field for the human's own note attributed `[human] …`,
are composed into **one body** posted to the existing `POST /:key/request-changes`. Unchecked
findings never enter the feedback. With no AI review present, the composer is a plain note box
(the round-1 behaviour) and the note rides unattributed.

### 3. Break-glass approve (recorded override)

The board never *blocks* the human. When the **current** review has open findings
(`verdict: 'findings'`), Approve arms a one-step confirm and the approval is logged as an
`override: approved over N open AI findings` comment (actor human). Clean, pending, or absent
reviews keep Approve a single click. Pending = no current verdict ⇒ no override.

### 4. Agent-facing payload strip

MCP `get_next_task` / `get_task` **strip every `ai-review/v1` comment** from the activity they
return (keyed on marker presence, so a malformed review can't slip through). Uncurated findings
must not leak into the implementing agent's brief — only the human-curated `feedback` activity
rides the re-claim, unchanged. The board UI keeps the comments; the strip is MCP-only.

### 5. Override-rate KPI

An approval whose **current** AI review had open findings is an override — derivable from the
activity log (`findingsAtApproval`): walk the status history; a `result` supersedes the prior
review (pending), an ai-review comment sets the current count, and the value standing at the
final `→ done` is snapshotted.

Analytics gains an **AI override rate** KPI:

- **denominator `d`** = done tasks with a *current* AI review at approval,
- **numerator `n`** = those approved with findings > 0,
- **rate** = `n / d`.

Per the n/m annotation discipline: a done task with **no current review present is excluded**
from both n and d (no review ever, *or* pending at approval — never counted as a clean zero).
When `d == 0` the KPI shows **n/a** ("no AI reviews").

## Data model

**No schema change.** Everything derives from the existing `activity` table:

- `aiReview` (DTO field) — latest `ai-review/v1` comment vs. latest `result`.
- `aiReviewFindings` (analytics row) — findings standing at the final `→ done` (null when pending/absent).
- the override audit note — an ordinary `comment` activity appended on approve.

## Testing

- **core** — `isAiReviewMarker` / `parseAiReviewComment` (v2 marker, fenced + bare JSON, reviewer,
  finding normalisation, malformed → null); `summarizeAiReview` (clean/findings/pending);
  `findingsAtApproval` (snapshot, reopen-then-clean, pending → null); derived `aiReview` on
  `getTask`/`listTasks`; `reviewApprove` override logging; analytics `aiReviewFindings`.
- **mcp** — `get_task`/`get_next_task` strip ai-review comments, keep plain comments + curated feedback.
- **web client** — chip (clean/findings/pending); `ReviewActions` checklist + break-glass + composer;
  `composeFeedback` attribution; override-rate KPI math (excluded when no review / pending, n/a at d=0).
- Full suite green; `npm run build` green; **no new dependencies**, **no migration**.

## Out of scope (lives in the external repo)

The reviewer loop script itself (poll → brief+diff → claude/codex → post). This spec is its contract.
