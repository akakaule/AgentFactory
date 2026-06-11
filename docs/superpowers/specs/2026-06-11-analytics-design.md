# AgentFactory — Analytics & metrics (claude-design handoff)

**Date:** 2026-06-11
**Status:** Approved (2026-06-11)
**Grows from:** the analytics design brief handed to claude-design (`site/analytics-brief.md`,
draft in `site/analytics-mockup.html`) and the returned design bundle (chat "Agent Task
Board", files `AgentFactory Board.html` + `analytics.jsx` + `board-data.jsx` +
`board-app.jsx`). The visual design is **fixed by the handoff** — this spec records how its
data model maps onto the real system and the few deliberate adaptations.

## Problem

The board coordinates the loop but can't measure it: no answer to "how long do tasks
take", "how often does review bounce", "what does an accepted task cost", or "which worker
is struggling". All the raw material exists (activity log, git, the workers themselves) —
nothing reads it.

## Goals

- **Analytics view** — third top-level view (Board · List · Analytics), workspace +
  7d/30d/All filterable: 6 KPIs, where-time-goes, throughput, review round-trips,
  tokens-by-model with explicit coverage, workers table, intentional empty state.
- **Drawer Metrics section** — per-task stage timeline + chips with first-class n/a states.
- **List view** — the handoff's flat table replaces the grouped list.
- **Token capture** — workers can report usage (best-effort at submit over MCP; exact
  post-run via HTTP for loop wrappers). Unreported ≠ zero, ever.

## Non-Goals

- The design's demo artifacts: Run-agent-loop simulator, header ticker, tweaks panel —
  the board never runs agents.
- Time-to-merge / PR-host metrics; agent self-assessment scores; analytics export.
- Worker registry table — attribution rides the activity log (see below).
- Server-side aggregation — single-user data volumes; the server ships per-task rows,
  the client aggregates (exactly like the design's `computeAnalytics`).

## Data architecture

Per-task metric row (wire + drawer shape):
`{ key, workspace, status, doneAt, queueMin, workMin, reviewMin, blockedMin, rounds, reopened, worker, model, tokensIn, tokensOut, costUsd }`

| Field group | Source | Notes |
|---|---|---|
| Stage durations | Walk `status_change` activity in id order; accumulate time-in-status into queued/work/review/blocked buckets | Open segment of a non-done task accrues to *now*; backlog time excluded (cycle = sum of the four stages, per design). |
| rounds / reopened | Count `feedback` rows / any `done → queued` transition | Already recorded for every task ever. |
| worker | `task.claimed_by` ?? `"(unlabeled)"` | Survives done/in_review/blocked; every done task was agent-claimed by construction. |
| Releases per worker | **Attribution fix:** `claimNextTask` now writes the worker label into the claim activity row body (was empty); a human `in_progress → queued` release is attributed to the nearest preceding claim row's body | Old rows have empty bodies → "(unlabeled)". Forward-only, no new table. |
| tokens / model / cost | **Migration #4** `task_metric` (`task_id` FK CASCADE, `model`, `tokens_in`, `tokens_out`, `cost_usd`, `reported_by`, `created_at`) | Aggregate per task: SUM tokens/cost across reports (each review round adds usage), model = latest. No rows → null → designed n/a. |
| files / +/− / commits | Existing diff machinery; diff endpoint gains `commits` (`git rev-list --count base..branch`) | Rendered in the Changes section, not duplicated in Metrics (see adaptations). |

## Capture paths

1. `submit_result` gains optional `metrics { model?, tokensIn?, tokensOut?, costUsd? }` —
   best-effort self-report; interactive agents may omit or estimate.
2. `POST /api/tasks/:key/metrics` — for loop wrappers that know exact usage from the
   `claude -p --output-format json` envelope *after* the run.

## Design adaptations (everything else is pixel-per-handoff)

| Handoff | Implementation | Why |
|---|---|---|
| Drawer order Links → Metrics → Details | Result → Changes → **Metrics** → Links → Details | Our drawer has the Changes (diff) section the prototype lacks; Metrics sits with the other derived info. |
| Metrics chips include diffstat + commits | Those stay in the Changes stat line ("3 files · +120 −45 · 4 commits") | One diff fetch, no duplicated numbers two sections apart. |
| `claims` per worker = done + in-progress + releases | Same formula server-derived | Historical per-claim attribution doesn't exist; formula matches the design. |
| Search box hidden on Analytics | Same | |
| Drawer "No metrics yet — this task hasn't been worked." | Same, keyed on `claimed_at == null` | |

## Acceptance criteria

1. Analytics view renders all six panels from live data, filtered by workspace + range,
   with the empty state when no done tasks match.
2. Cost/token surfaces show n/a + "k of n reported" whenever coverage is partial; a task
   with no `task_metric` rows never renders zeros.
3. A `submit_result` carrying metrics and a `POST /:key/metrics` both land in the
   analytics within one SSE tick.
4. Drawer Metrics: timeline + legend from real stage durations; reported vs dashed-n/a
   chip states; unworked tasks show the no-metrics line.
5. List view is the flat table (lifecycle sort, workspace column only when >1 workspace);
   GroupedList is gone.
6. Migration #4 applies fresh and in-place from v3; full suite green; no new deps.
