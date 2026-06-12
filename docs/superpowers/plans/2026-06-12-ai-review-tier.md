# Plan — Automated First-Pass Review Tier (AF-13)

Spec: [../specs/2026-06-12-ai-review-tier.md](../specs/2026-06-12-ai-review-tier.md)

TDD throughout: failing test first, then implement. No new dependencies. No DB schema change.

## Phase 1 — core: the marker parser (single source of truth)

- **`packages/core/src/types.ts`** — add `AiReviewSummary { findings: number }`; add
  `aiReview: AiReviewSummary | null` to `Task` (flows to summary + detail via `extends`).
- **`packages/core/src/aiReview.ts`** (new) —
  - `parseAiReview(body): AiReviewSummary | null` — marker + embedded-JSON + tolerant fallback.
  - `findingsAtApproval(steps): number | null` — verdict snapshotted at the final `→ done`.
- **`packages/core/src/index.ts`** — export `parseAiReview`, `findingsAtApproval`, `AiReviewSummary`.
- Test: `packages/core/test/aiReview.test.ts` (RED → GREEN).

## Phase 2 — core: surface the derived field

- **`packages/core/src/repo/activity.ts`** — `latestAiReviewBodies(db, ids): Map<number,string>`
  (one grouped query: latest `comment` per task whose `lower(body) LIKE 'ai-review:%'`).
- **`packages/core/src/repo/tasks.ts`** — `toTask` sets `aiReview: null`; `listRows` overlays
  the batch result; `toDetail` overlays the single-task result. (Parser applied here.)
- Test: extend `packages/core/test/` — `aiReview` on `getTask` detail and `listTasks` summary.

## Phase 3 — core: analytics override input

- **`packages/core/src/ops/analyticsRows.ts`** — add `aiReviewFindings: number | null` to
  `AnalyticsTaskRow`; derive it in the existing `steps` walk via `findingsAtApproval`.
- Test: extend `packages/core/test/analyticsRows.test.ts` — clean approval (0), override (>0),
  no-review (null), reopen-then-clean.

## Phase 4 — web client: chip + break-glass + KPI

- **`packages/web/client/src/metrics.ts`** — add `aiReviewFindings` to the client
  `AnalyticsTaskRow`; add `override: { n; d; rate }` to `kpis` (exclude no-review; n/a at d=0).
- **`packages/web/client/src/components/AiReviewChip.tsx`** (new) — `null → null`; clean/green
  vs `n findings`/amber.
- **`packages/web/client/src/components/TaskCard.tsx`** — render chip on `in_review` cards.
- **`packages/web/client/src/components/DetailPanel.tsx`** — render chip; pass
  `aiFindings` into `ReviewActions`.
- **`packages/web/client/src/components/ReviewActions.tsx`** — `aiFindings?: number | undefined`;
  when > 0, Approve arms a confirm; note that approval is recorded as an override.
- **`packages/web/client/src/views/AnalyticsView.tsx`** — AI override-rate KPI card.
- **`packages/web/client/src/board.css`** — `.af-airev` chip + warn note; KPI grid 6 → 7.
- Tests: `metrics.test.ts` (override math), `AiReviewChip.test.tsx`, `ReviewActions.test.tsx`
  (break-glass), `AnalyticsView.test.tsx` (KPI card), `DetailPanel.test.tsx` (chip).

## Phase 5 — verify

- `npm test` (whole monorepo) green; `npm run build` green from the worktree root.
- Confirm: no new deps (package.json unchanged), no migration, board still never runs agents.

## Notes

- Detection is marker-based and actor-independent → the existing comment API is untouched.
- The reviewer loop script is **not** in this repo; the spec is its contract.
