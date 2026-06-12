# AgentFactory — Agent review tier: curated feedback before the human gate

**Date:** 2026-06-12
**Status:** Proposed
**Grows from:** the AF-13 backlog sketch (advisory ai-review comments + override KPI), extended
with a requirement that sketch lacked: **per-finding curation** — feedback on an in-review task
accumulates from *both* an agent reviewer and the human, and the human chooses which findings
ride back to the implementing agent. Builds on [diff view](2026-06-11-diff-view-design.md)
(`GET /api/tasks/:key/diff` is the reviewer's input) and
[claim protocol + guardrails](2026-06-12-claim-protocol-and-submit-guardrails-design.md)
(the branch is guaranteed pushed, so review can run the moment a task lands in review).

## Problem

The human gate is the throughput bottleneck. Every in-review task gets the same cold-start
human attention regardless of risk, and the human's feedback is the only feedback. Meanwhile
an agent reviewer (Claude *or* Codex) could examine the diff the moment it lands — but raw
agent findings vary in quality, so handing them straight back to the implementing agent would
launder noise into rework. The missing piece is a **curation step**: agent review proposes,
the human disposes.

## Goals

- A task entering `in_review` gets an automated review pass — findings posted to the task
  *before* the human looks, so the human gate starts from a verdict, not from zero.
- The reviewer is **pluggable**: `claude -p` or the Codex CLI, selected per loop instance.
- Feedback accumulates from two sources — agent findings and human notes — and the human
  **selects which items** compose the feedback that rides the re-queue. Unselected findings
  remain history, but never reach the implementing agent's brief.
- Approving over open findings is recorded as an **override** and surfaced in analytics
  (the Cloudflare-style quality KPI from the AF-13 sketch).
- The board still never runs agents and never writes to a repo.

## Non-Goals (deferred)

- Auto-request-changes on findings — the human always decides what goes back. Advisory only.
- Blocking approval on findings — Approve stays one click (break-glass gate, logged as override).
- Inline diff-anchored comments (AF-14 — this design's findings carry file/line as text, AF-14
  can later anchor them).
- Review of unpushed work — guardrails already make that impossible.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Findings format | One comment per review round, body = `ai-review/v1` marker line + short human-readable summary + fenced JSON: `{ reviewer, verdict: clean\|findings, findings: [{ severity, file, line?, title, detail }] }` | Parseable by the UI, readable by humans in the activity feed, zero schema change — findings are derivable from activity, per the AF-13 discipline |
| Who runs the reviewer | External `Run-ReviewerLoop.ps1` in the ado-bridge repo, beside the producer/worker loops; `-Reviewer claude\|codex` picks the engine | The board never runs agents; loops are the established runner pattern; one flag makes the reviewer swappable |
| Review trigger + dedup | A task needs review when `status = in_review` AND its latest `result` activity is newer than its latest `ai-review` comment | Re-reviews every resubmission round; no claim state, no race damage (double review is wasted tokens, not corruption) |
| Reviewer input | `GET /api/tasks/:key` (spec + acceptance criteria + activity) + `GET /api/tasks/:key/diff` | Review against the *brief*, not just the diff; both endpoints exist and are read-only |
| Curation UX | The in-review drawer renders parsed findings as a checklist; **Request changes** opens a composer pre-seeded with the checked findings + a free-text field for the human's own feedback; submit posts one composed body to the existing `POST /:key/request-changes` | Human picks per finding; the existing feedback mechanism is unchanged — core, transitions, and the re-claim path don't know reviews exist |
| Feedback attribution | Composed body labels each item with its source: `[reviewer-codex] …` / `[human] …` | The implementing agent sees where each demand came from; analytics can split rework by source later |
| Agent-facing payload | MCP `get_next_task` / `get_task` strip `ai-review/v1` comments from the activity they return | "Human chooses what goes back" must hold — uncurated findings must not leak into the implementer's brief via the activity thread |
| Verdict surface | in_review card chip + drawer panel: `AI review: 2 findings` / `clean` / `pending`, derived from the latest ai-review comment vs latest result | Glanceable triage on the board; `pending` = result newer than last review |
| Override recording | Approving while the latest review has unaddressed findings appends the existing `comment` activity `override: approved over N open findings` (actor human) | Derivable, no schema; the activity log stays the audit trail |
| Analytics | Override-rate KPI: overrides ÷ approvals-with-review-present, n/m annotation; tasks with no review excluded, never counted as zero | AF-13's KPI discipline unchanged |
| Schema | No new tables or columns | Everything derives from activity + comments |

## The loop, with the review tier

1. Worker submits → guardrails verify → `in_review` (branch on origin, diff ready).
2. Reviewer loop notices (result newer than last review) → fetches brief + diff →
   runs Claude or Codex → posts one `ai-review/v1` comment.
3. Board shows the verdict chip; the human opens the drawer to a findings checklist
   that they can extend with their own notes.
4. Human picks: **Approve** (open findings ⇒ override logged) or **Request changes**
   with the curated, attributed feedback composition.
5. Re-claim carries the curated feedback (and not the raw review) — same branch,
   round 2; resubmission triggers a fresh review.

## Acceptance criteria (feature-level)

1. A documented `ai-review/v1` marker convention; an external loop can post findings via the
   existing comment API; the reviewer engine is selectable (claude/codex) per loop instance.
2. The in_review card and drawer surface the verdict (findings count / clean / pending);
   findings render as a checklist in the drawer.
3. Request changes composes selected findings + human free-text into one attributed feedback
   body via the existing endpoint; unselected findings do not appear in the feedback.
4. MCP claim/get_task payloads exclude ai-review comments; the curated feedback activity is
   included as today.
5. Approving with open findings logs an override; analytics shows an Override-rate KPI with
   the n/m annotation discipline.
6. No schema change; no new deps; the board never runs agents; full suite green.
