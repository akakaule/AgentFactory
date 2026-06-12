# Design brief — AgentFactory Analytics

**Handoff to:** claude-design
**Draft mockup:** [analytics-mockup.html](analytics-mockup.html) (fake data; layout/hierarchy only — visual design is yours)
**Date:** 2026-06-11

## What AgentFactory is (context)

A single-user, local, dark-themed task board that coordinates AI coding agents: a human
writes and queues tasks, external agents claim them over MCP, work in git worktrees, and
submit results for human review (approve / request changes / reopen). The board never runs
agents — it is the state store, review surface, and now: the measurement surface.

The existing UI is a Kanban board + list view with a 460px right detail drawer. The visual
language is established and must be matched — see "Design system" below.

## The feature

Two surfaces, one data story:

1. **Analytics view** — a third top-level view alongside Board and List (same header, the
   view toggle gains a third position). Answers: *how is my agent loop performing?*
   Filterable by workspace and time range (7d / 30d / all).
2. **Per-task Metrics section** — a compact strip in the existing task detail drawer,
   between the Changes section and the Details grid. Answers: *what did this task cost?*

## The metrics (and where they come from — affects what the UI may promise)

| Tier | Metrics | Source | Always available? |
|------|---------|--------|-------------------|
| Derived | queue wait, work time, review wait, blocked time, cycle time, review round-trips, first-pass approval rate, reopen rate, stranded-claim releases, throughput per day/workspace/worker | activity log timestamps (already recorded) | **Yes — for every task ever** |
| Git-derived | files changed, +/− lines, commit count on the task branch | read-only git vs the recorded branch | Yes while the branch exists |
| Worker-reported | tokens in/out, model, cost, turns | agents self-report at submit, or a loop wrapper posts exact usage afterward | **No — best-effort.** Interactive workers often won't report. |

**Design consequence:** token/cost data is partial by nature. The UI must treat "no
metrics reported" as a first-class state (show *n/a*, annotate coverage like "12 of 14
tasks reported"), never render it as zero, and never let cost KPIs imply completeness.

## Content of the draft (what to keep, conceptually)

- **KPI row:** tasks done (with delta vs previous period), median cycle time, median work
  time, first-pass approval %, reopen rate, cost per accepted task.
- **"Where time goes":** median duration per stage (queue / work / review wait / blocked),
  colored with the existing status hues. This is the headline insight panel — in practice
  it shows the human review wait dominating, not the agents.
- **Throughput:** done-per-day bars over the selected range.
- **Review round-trips distribution:** first-pass / 1 round / 2+ rounds — the
  agent-quality signal.
- **Tokens by model:** horizontal bars + explicit coverage caveat.
- **Workers table:** claims, done, first-pass %, median work time, stranded releases,
  tokens, cost. Unlabeled workers appear as "(unlabeled)".
- **Drawer Metrics strip:** stage timeline bar (status hues) + chips: review rounds,
  diffstat (+green/−red), commits, tokens in/out, cost · model.

## Design system (must match the existing board)

- Tokens (from `packages/web/client/src/index.css`, reproduced in the mockup's `:root`):
  bg `#0F172A`, wells `#0B1222`, panels `#18233A`, cards `#1E293B`, hairlines `#2C3A55`,
  ink `#E8EDF6` / `#97A5BE` / `#64748B`, accent blue `#3B82F6`/`#60A5FA`, working amber
  `#F59E0B`, success green `#4ADE80`, plus the six status hues (`--st-*`).
- Fonts: **Space Grotesk** (headings, KPIs, section labels), **IBM Plex Sans** (body),
  **IBM Plex Mono** (numbers, keys, timestamps, worker labels).
- Patterns to reuse: `.af-sl` uppercase section labels, pill badges with colored dots,
  12px-radius cards on hairline borders, the drawer at 460px.
- Charts are **pure CSS** (bars only) — no chart library will be added. Design within
  that constraint: bar lists, stacked/segmented bars, big numbers. No donuts/lines unless
  they can be plain CSS.

## Constraints & non-goals

- No new runtime dependencies; no chart libraries; plain CSS in the existing files.
- Single user — no auth, no sharing/export in v1.
- No time-to-merge or PR-host metrics (PR integration is a project non-goal).
- No agent "self-assessment" scores.
- Live updates ride the existing SSE refresh; no bespoke polling UI needed.
- Empty states matter: a fresh board (0 tasks) must look intentional, not broken.

## Deliverable requested from claude-design

A refined high-fidelity HTML mockup (same self-contained single-file format) of both
surfaces — the analytics view and the drawer Metrics strip — consistent with the existing
board's visual language, including the empty state and the partial-token-coverage state.
Keep the file free of external assets except the Google Fonts already used.
