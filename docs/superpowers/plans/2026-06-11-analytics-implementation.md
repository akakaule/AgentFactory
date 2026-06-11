# Analytics & metrics — Implementation Plan

**Date:** 2026-06-11
**Spec:** [2026-06-11-analytics-design.md](../specs/2026-06-11-analytics-design.md)
**Status:** Approved (2026-06-11)

Seven phases, dependency-ordered (`core derivation → core capture → web server → mcp →
client lib → client UI → e2e/docs`). TDD per task; package suite green per phase; rebuild
core (`npm -w packages/core run build`) before web suites (stale-dist gotcha). No new
dependencies.

---

## Phase 1 — core: derivation + attribution

- **Files:** `src/metrics.ts` (new — `deriveTaskMetrics(task, activity, now)`: stage walk,
  rounds, reopened; pure), `ops/claimNextTask.ts` (claim activity body = worker label),
  `ops/analyticsRows.ts` (new — all-time rows + stranded releases with nearest-preceding-
  claim attribution), `ops/getTask.ts` + `types.ts` (`TaskDetail.metrics`), `index.ts`.
- **Tests:** `test/metrics.test.ts` (hand-built activity fixtures: simple done flow,
  multi-round, blocked detour, reopen, open in-progress segment, unworked task);
  `test/analyticsRows.test.ts` (rows over a driven loop incl. claim label in activity
  body, release attribution, "(unlabeled)" fallback); claim tests extended.
- **Fallout:** `TaskDetail` widens — sweep web client fixtures in Phase 6.

## Phase 2 — core: capture

- **Files:** `schema.ts`/`migrate.ts` (migration #4: `task_metric` + index),
  `ops/addTaskMetrics.ts` (new; ≥1 non-null field, unknown key → NotFound),
  aggregate join into `metrics.ts`/`analyticsRows`/`getTask`, `index.ts`, `validate.ts`.
- **Tests:** migration fresh→v4 + in-place v3→v4 + no-op re-run; aggregate sums across
  reports, latest model wins; delete cascades metric rows; `deleteTask.test.ts` extended.

## Phase 3 — web server

- **Files:** `routes/analytics.ts` (new, `GET /api/analytics` → `{ tasks, stranded }`),
  `app.ts` (mount), `routes/tasks.ts` (`POST /:key/metrics` → 201), `schemas.ts`,
  `server/git.ts` (`commitCount`), diff route returns `commits`.
- **Tests:** `test/server/analytics.test.ts` (rows reflect a driven loop + posted
  metrics; stranded entries); tasks tests (metrics 201 / 404 / 400-empty); diff tests
  assert `commits`.

## Phase 4 — mcp

- **Files:** `tools/submitResult.ts` (optional `metrics` input → `core.addTaskMetrics`
  after submit; description documents best-effort reporting), `schemas.ts`, README
  (capture paths incl. wrapper POST with exact `claude -p` usage).
- **Tests:** tool passes metrics through; omitting metrics unchanged; registry text.

## Phase 5 — client metrics lib

- **Files:** `client/src/metrics.ts` (new) — typed port of the design's
  `computeAnalytics` + `fmtDur`/`median`/`fmtNum`.
- **Tests:** `test/client/metrics.test.ts` against design-shaped fixture rows: KPI deltas
  vs previous window, medians, stage totals + dominant, throughput buckets, rounds
  distribution, token coverage, workers (incl. "(unlabeled)", null-worker exclusion —
  the bug the design verifier caught), empty result.

## Phase 6 — client UI

- **Files:** `views/AnalyticsView.tsx` (new), `views/ListView.tsx` (new; delete
  `GroupedList.tsx`), `components/TaskMetrics.tsx` (new), `DetailPanel.tsx` (Metrics
  section; Changes stat gains "· N commits"), `App.tsx` (third toggle + chart icon +
  range state; search/New-task hidden on analytics), `api.ts` (`getAnalytics`,
  `postMetrics`, `TaskDiff.commits`), `icons.tsx` (board/list/chart), `board.css`
  (`.af-range`, `.an-*`, `.af-m*`, `.lst` from the design HTML).
- **Tests:** AnalyticsView (KPIs, n/a cost, coverage banner, workers pills, empty state),
  ListView (lifecycle sort, ws column gating, row click opens drawer), TaskMetrics
  (reported vs n/a vs unworked), DetailPanel integration, App toggle; GroupedList tests
  replaced; TaskDetail fixtures gain `metrics`.

## Phase 7 — e2e + docs

- e2e: full loop where `submit_result` carries metrics → `/api/analytics` reflects
  tokens/rounds/stages; a release shows up as a stranded row with the right label.
- Root README analytics section; spec/plan → Implemented.
- **Final gate:** root `npm test` + `npm run build`.

---

## Risks / watch-outs

- `TaskDetail.metrics` widens the payload — client fixtures and strict types must be
  swept in the same phase that consumes them.
- Time math in tests: drive activity with explicit `now` functions (the codebase's ops
  accept `now` injectors) — no wall-clock flakiness.
- The design's `computeAnalytics` uses ms epochs; the wire uses ISO strings — convert at
  the api layer, keep the lib in ms like the design.
- Stale core dist before web suites (seen twice before): rebuild core at Phase 2/3 gates.
