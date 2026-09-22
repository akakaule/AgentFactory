# Estimated API token cost implementation plan

Date: 2026-09-14. Status: ready for implementation; no feature code changed by this planning task.

Design: [Estimated API token cost](../specs/2026-09-14-api-equivalent-token-cost-design.md).

## Goal and boundaries

Display API-equivalent USD token costs throughout the existing token UI, using versioned public OpenAI and Anthropic rates. Include task totals and stage/operation/engine/model breakdowns. Preserve provider-reported cost separately. Ship shared pricing and trustworthy usage capture before adding the displays.

Use standard direct-provider API pricing as the comparison policy, even for subscription sessions. Capture observed tier/region but explain the standard/global comparison assumption. Include mandatory context and cache rules. First release excludes invoice reconciliation, subscription allocation, foreign exchange, non-token tools, budgets, and automatic price scraping.

Execute steps 1-8 in dependency order. Each implementation step starts with focused failing tests, records the failure, adds the smallest implementation, and reruns those tests. Build core before tests that consume its compiled workspace exports. Keep local commits focused and Conventional Commit formatted. Do not push or create a PR without an explicit request.

## 1. Lock the usage and pricing contracts

**Existing files:** `packages/core/src/types.ts`, `packages/core/src/validate.ts`, `packages/core/src/index.ts`, `packages/core/test/taskTokenBreakdown.test.ts`.

**New files:** `packages/core/src/usage.ts`, `packages/core/test/usage.test.ts`, sanitized provider fixtures under `packages/core/test/fixtures/usage/`.

- Inventory actual model IDs and telemetry fields from sanitized samples, including Codex, Claude, cached runs, multiple models, retries, and auxiliary sessions. Consult official usage and caching documentation alongside both pricing lists. Do not copy secrets or prompt content into fixtures.
- Define versioned normalized usage and valuation types. Optional legacy fields remain accepted; missing counts are not zero. Distinguish provider from agent engine, pipeline stage from operation, and source occurrence time from receipt time.
- Define mutually exclusive input categories and any additional charge components with explicit inclusion semantics. Include cache reads, writes by known TTL, unknown write TTL, output, and request context size. Treat reasoning as a subset when the source already includes it in output.
- Specify `complete | partial | unavailable`, amount as a decimal nanodollar string, component coverage, missing reasons, assumptions, and immutable policy/rate snapshot metadata. An omitted estimate from an older server is unavailable in the client.
- Normalize both `otel:claude-code` and the legacy `otel:claude` reporter to the Claude engine. Never infer an engine solely from a model name.

**Proof:** provider normalization fixtures reconcile input/output totals; missing cache data stays unknown; cache read/write fields remain distinct; negative, non-finite, unsafe integer, and contradictory subset counts are rejected; valid measured zero is retained. Regression test covers the existing Claude reporter mismatch.

## 2. Implement the versioned catalogue and pure calculator

**New files:** `packages/core/src/pricing.ts`, `packages/core/src/pricing/catalogue.ts`, `packages/core/test/pricing.test.ts`.

- Seed exact supported model IDs found in step 1 from the official [OpenAI](https://developers.openai.com/api/docs/pricing) and [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) lists. Verify rates at implementation time; store source URL, verification date, effective interval where known, and immutable version. Explicitly list supported aliases.
- Encode standard/global comparison policy and model-specific context/cache rules as data. Keep unsupported modalities/models/rules unpriced. Do not apply a default input rate to unknown cache writes or assume omitted TTL means five minutes.
- Implement deterministic decimal arithmetic with BigInt, producing integer nanodollars once per report. Serialize BigInt values as strings at JSON boundaries. Preserve enough precision in intermediate multiplication/division; specify and test the final rounding rule.
- Price independent components, return partial coverage when others are unknown, and aggregate integer amounts without rounding rows to cents. Use the same pure calculator for durable and unattributed live events.
- Resolve prices by occurrence time and known effective interval. A catalogue refresh must not mutate a stored valuation. A current rate without historical evidence cannot fully price an older record under the historical policy.

**Proof:** independently hand-calculated fixtures for each seeded model/rule; cache hit/write mixtures; context boundary just below/at/above threshold; inclusive reasoning; output-only measurements; zero; unknown model; missing TTL; expired or future rates; very small values; many-report sums; mixed complete/partial/unavailable aggregation. Separate synthetic arithmetic fixtures from numerical assertions tied to dated official rates.

## 3. Persist usage evidence and valuation atomically

**Existing files:** `packages/core/src/migrate.ts`, `packages/core/src/repo/metrics.ts`, `packages/core/src/ops/addTaskMetrics.ts`, `packages/core/src/version.ts`, `packages/core/test/migrate.test.ts`, `packages/core/test/version.test.ts`.

**New tests:** `packages/core/test/metricValuation.test.ts`.

- Allocate the next unused migration at implementation time. The inspected working tree has migration 24; concurrent work may advance it. Follow existing idempotent schema reconciliation and preserve branch-added columns.
- Add nullable identity and attribution columns to `task_metric`: provider, engine, execution ID, provider event/deduplication key, stage, operation, worker, occurred-at, and provenance. Add versioned `usage_json`, `valuation_json`, and an update marker suitable for refresh invalidation. Keep `tokens_in`, `tokens_out`, `cost_usd`, `model`, and `reported_by` compatible.
- Store the selected complete rate snapshot inside each valuation to avoid a separate pricing join/table in this release. Bound and validate metadata payloads. Never store arbitrary provider event bodies.
- Add a partial unique index for non-null deduplication keys. One transaction normalizes, inserts or safely enriches a matched report, and stores the valuation. Replay must return the existing result without changing totals. Distinct requests with identical counts remain distinct.
- Retain legacy metrics with unknown identities. Do not heuristically deduplicate them. Keep a source-authority marker for execution summaries versus request events.
- Include valuation-only enrichment in `getVersion`; test same-timestamp updates as well as ordinary inserts so an open drawer does not stay stale.

**Proof:** migration of a populated pre-feature DB preserves counts, totals, and reported cost; fresh and repeated migration; compatible branch-shaped schema; transactional rollback; duplicate replay and competing inserts; late reports; immutable historical snapshots after catalogue replacement; valuation-only refresh. Use temporary databases only.

## 4. Carry the contract across adapters and every agent session

**Existing files:** `packages/web/server/routes/otel.ts`, `packages/web/server/telemetry.ts`, `packages/web/server/schemas.ts`, `packages/web/server/routes/tasks.ts`, `packages/web/server/routes/agentOps.ts`, `packages/core/src/httpCore.ts`, `packages/mcp/src/schemas.ts`, `packages/mcp/src/tools/submitResult.ts`, `packages/dispatcher/src/metrics.ts`, `packages/dispatcher/src/codex.ts`, `packages/dispatcher/src/dispatcher.ts`, `packages/dispatcher/src/types.ts`, `packages/reviewer/src/reviewer.ts` and affected adapter types.

**Existing tests:** `packages/web/test/server/otel.test.ts`, `packages/web/test/server/telemetry.test.ts`, `packages/web/test/server/httpCore.contract.test.ts`, `packages/web/test/server/agentOps.test.ts`, `packages/dispatcher/test/metrics.test.ts`; extend the relevant dispatcher, Codex, MCP, and reviewer tests.

- Preserve Claude cache reads separately from cache creation, including creation TTL when supplied. Preserve Codex cached-input subsets and other documented categories without adding them twice. Correct the live Cached label to reflect reads, with separate write detail.
- Prefer provider request/event identity; propagate execution UUID, stage, operation, engine, workspace, and worker from launch. Reuse any execution framework landed by intervening work; do not add a competing claim system.
- Capture attribution for implementation, review, visualization, and feedback evaluation. Keep source event time where valid; record receipt time separately. Invalid/missing event time uses a documented fallback and marks provenance.
- Parse Claude per-model usage as separate records. Keep aggregate reported cost at its original scope rather than copying it into every model. Preserve existing flat parser compatibility where needed. Aggregate summaries lacking request context must retain pricing uncertainty.
- Apply the same normalized contract to Codex CLI fallback and MCP-supplied metrics. Update both explicit HTTP metrics payload builders and generic agent routes; no adapter may silently strip new fields.
- Preserve one authoritative usage source per execution. Do not sum OTel requests and the CLI total for the same work. Supplementation requires proven identity/coverage; missing IDs must not be replaced with token-count hashes. Normalize known cumulative streams before persistence.
- Capture usage from failed sessions and final reports after task transitions without moving task status. Reviewer fallback must have the same anti-double-counting rule as dispatcher fallback.
- Publish the normalized valuation in the telemetry feed after core ingestion. Replayed durable events must not inflate the live window. Unattributed events may be priced in the window but do not appear in task totals until attribution is established.

**Proof:** OTel and no-OTel executions for both engines; multi-model Claude result; replayed provider event; two legitimate equal-size requests; cumulative counters; failed run with final usage; late review event after stage transition; review/visualization operation separation; old HTTP/MCP payload compatibility; no secret metadata in persisted fixtures.

## 5. Expose matching aggregates for task, session, telemetry, and analytics

**Existing files:** `packages/core/src/repo/metrics.ts`, `packages/core/src/repo/tasks.ts`, `packages/core/src/ops/analyticsRows.ts`, `packages/core/src/ops/tokenTrend.ts`, `packages/core/src/types.ts`, `packages/web/server/routes/analytics.ts`, `packages/web/client/src/types.ts`, `packages/web/client/src/metrics.ts`; locate and update the existing `listLiveSessions` implementation and its contract.

**Existing tests:** `packages/core/test/taskTokenBreakdown.test.ts`, `packages/core/test/analyticsRows.test.ts`, `packages/core/test/tokenTrend.test.ts`, `packages/web/test/server/analytics.test.ts`, `packages/web/test/client/metrics.test.ts`.

- Extend task total and breakdown contracts with API estimate and coverage, keeping reported cost separate. Group on recorded stage, operation, engine, and model. Use the existing timing inference only for legacy records, marked as inferred.
- Sum stored per-report valuations. Never multiply task totals by the last model's rate. Preserve unknown buckets and reconcile all subtotals to their parent report set.
- Expose execution-scoped tokens and estimates for current live sessions. Where historical live rows only support whole-task values, explicitly return and display task scope for both quantities.
- Add cost to daily trends and analytics dimensions. Attribute model and worker from usage evidence, not the last model/worker on the task. Date-range cost and tokens must filter by occurrence time; preserve existing task lifecycle statistics separately.
- Use bounded/batched report queries and shared aggregation helpers; avoid a detail fetch per UI row. Preserve the single-user application architecture instead of introducing a separate analytics service.
- Return identical coverage semantics for each aggregate. Empty history, incomplete measurements, and complete zero are distinct states.

**Proof:** one fixture spanning two providers, several models/workers/stages, retries, unknown attribution, and multiple days reconciles exactly across all applicable views. Test UTC boundaries, workspace/range filters, session-versus-task scope, partial coverage propagation, and no change to unrelated lifecycle analytics.

## 6. Add one cost presentation to every existing token surface

**New files:** `packages/web/client/src/components/ApiCost.tsx`, `packages/web/client/src/costFormat.ts`, `packages/web/test/client/ApiCost.test.tsx`.

**Existing files:** `packages/web/client/src/components/TaskMetrics.tsx`, `packages/web/client/src/components/LiveSection.tsx`, `packages/web/client/src/views/LiveView.tsx`, `packages/web/client/src/views/TelemetryView.tsx`, `packages/web/client/src/views/AnalyticsView.tsx`, `packages/web/client/src/board.css`; corresponding component tests, adding coverage where absent.

| Existing surface | Required result |
| --- | --- |
| Task Metrics summary | Estimated API cost beside token totals; separate Reported cost when present |
| Task token breakdown | Per-row estimate, operation/engine/model attribution, stage subtotals and total; visible coverage |
| Task live section and Live view | Estimate beside tokens with matching execution/task scope |
| Telemetry summary and events | Per-event estimate and retained-window subtotal; cache read/write distinction; separate reported cost detail |
| Analytics KPIs and grouped tables | Estimates beside token totals for model, worker, workspace, branch, and stage groups |
| Analytics daily trend | Cost series or adjacent cost view with matching date range; exact values in accessible tooltip/table |

- Use `≈$x API` compact display with a full accessible label. Show `<$0.01` for small nonzero compact values; retain precision in details. Never format an unavailable estimate as `$0.00`.
- Display partial known subtotal with `partial` and its missing-data explanation. Only show coverage percentages when a measured denominator exists. Tooltips/details expose model, component counts/rates, assumptions, policy/version, source link, and verification date.
- Ensure pricing details work by keyboard and touch rather than hover alone. Keep narrow task breakdowns horizontally scrollable and verify accessible table headers.
- Existing TaskCard and ListView have no token display in the inspected tree. Do not add unrelated token UI there; if concurrent work adds token consumption, include those new locations in the final coverage audit.
- Search all client token-formatting and usage fields after implementation to catch additional surfaces. Backend and client formatting must never independently calculate prices.

**Proof:** component tests for complete, partial, unavailable, measured zero, very small amounts, legacy-server responses, separate reported cost, stage subtotal reconciliation, and narrow layout. Browser verification must cover each row of the surface table with seeded deterministic data.

## 7. Add pricing transparency and a conservative historical backfill

**New files:** `packages/core/src/ops/pricingCatalogue.ts`, `packages/core/src/ops/backfillMetricValuations.ts`, `packages/core/test/backfillMetricValuations.test.ts`, `packages/web/client/src/components/PricingDetails.tsx`; add a small read-only pricing route and relevant contract tests.

**Existing files:** `docs/token-telemetry.md`, core exports and affected web API/client contracts.

- Expose a read-only catalogue/policy view from cost details: supported model IDs, source URLs, verification dates, and missing mappings. Keep catalogue editing in reviewed repository changes for this release.
- Provide a dry-run-first backfill entry point through the existing maintenance pattern. Report eligible, completed, partial, unavailable, and ambiguous records plus predicted totals before applying it.
- Price old records only with proven category semantics and applicable historical rates. Enrich from retained telemetry/transcripts only when an unambiguous identity and count reconciliation are available. Skip uncertain matches; never append a second copy of an existing aggregate.
- Applying the same backfill twice must have no additional effect. Leave completed pinned valuations unchanged; retain reported costs and token totals. Do not run a mutating backfill on the live workspace as part of automated tests.
- Document the estimate policy, model support, capture limitations, catalogue update procedure, source-authority rule, and historical unavailable states. Explain that reported cost and API-equivalent cost may differ.

**Proof:** complete recoverable history, merged legacy input, unknown model, missing effective-date evidence, ambiguous transcript match, repeated backfill, preserved token totals/reported costs, unchanged completed estimates, and UI refresh after enrichment.

## 8. Verify end to end and prepare rollout

- Start from the correct-case `C:\Git\AgentFactory` working directory, Node 26+, strict TypeScript settings including `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`. Inspect working-tree and active-agent changes before editing or staging; retain unrelated work.
- Use a temporary populated DB and deterministic provider fixtures for the full path: ingestion -> persistence -> API -> browser. Include one successful execution, one failed/retried execution, and auxiliary review/visualization usage. Do not trigger paid agent runs solely to prove pricing arithmetic.
- Record the initial targeted RED result, then the final GREEN result for each step. Run relevant focused suites while developing, followed by the checks below once the integrated feature is ready.

```powershell
npm run build
npm -w packages/web run typecheck:client
npm test -- --reporter=dot --maxWorkers=2 --minWorkers=1
git diff --check
```

- Confirm task totals equal the sum of their breakdowns, and reconcile live/telemetry/analytics only over the same selected report set. Exercise unknown and partial data in the browser, not just fully priced fixtures.
- Audit all token UI locations with `rg`, inspect desktop and narrow layouts, and record screenshots or browser assertions from the temporary fixture environment. Validate catalogue source links and numerical fixtures against the official pricing lists.
- Before any eventual live schema upgrade/restart, inspect active claims, arrange a controlled service drain, back up SQLite consistently with WAL handling, and rebuild all affected packages. Preserve service environment/credentials and late usage delivery. Reload all long-running processes that cache compiled core exports in the coordinated rollout.
- Roll back to the pre-feature binaries if needed; the migration is additive and legacy columns remain usable. Preserve the upgraded database and backup rather than deleting new usage. Test old-reader behavior against the upgraded fixture DB.

**Completion gate:** all existing token surfaces have a matching estimate or explicit unavailable state; both providers' cache/model rules are covered by dated fixtures; duplicate delivery cannot inflate totals; auxiliary and failed sessions retain attribution; historical estimates are stable; compatibility, migration, full tests, build, typecheck, and browser evidence pass.

## Delivery checkpoints

1. Steps 1-3: tested core accounting and durable storage.
2. Steps 4-5: complete capture, source reconciliation, and API aggregates.
3. Steps 6-7: consistent UI, pricing transparency, and historical handling.
4. Step 8: verified integration and a concrete rollout result.

All four checkpoints are required for the requested feature. Missing provider metadata is represented explicitly and does not justify inventing a price. No runtime restart, live backfill, push, or PR is performed by this planning task.
