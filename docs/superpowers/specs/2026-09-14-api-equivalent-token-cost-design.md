# Estimated API token cost

Date: 2026-09-14. Status: proposed design accompanying the implementation plan; feature implementation has not started.

## Outcome

Show **Estimated API cost** wherever AgentFactory presents token consumption. Calculate what the recorded usage would cost at public OpenAI or Anthropic API rates, including caching, and allow a task's cost to be broken down by pipeline stage, operation, agent engine, and model. Subscription usage receives the same API-equivalent estimate. Existing provider-reported `costUsd` remains a separate **Reported cost** value; neither field represents a verified invoice.

The default comparison policy is USD, direct-provider standard processing, and the provider's standard/global region. Apply mandatory model-specific context and cache rules. Capture observed service tier and region, but keep the comparison policy consistent across subscription and API runs. Describe this assumption in the details. Alternative policies, currency conversion, subscription allocation, taxes, tool charges, and budget enforcement are outside the first release.

## Evidence from the current repository

- `packages/web/server/routes/otel.ts` merges Claude ordinary input, cache reads, and cache creation into durable `tokensIn`. Its live `tokensCached` combines reads and writes. Those categories cannot be priced correctly from that aggregate alone.
- `packages/dispatcher/src/metrics.ts` takes the first `modelUsage` key when there is no top-level model, potentially attributing a multi-model total to one model.
- `packages/core/src/repo/metrics.ts` stores only aggregate counts and reported cost. The task breakdown infers stage from session timing and recognizes `otel:claude`, while the ingestion route emits `otel:claude-code`.
- Analytics retains the last task model and current/last worker; these are insufficient to attribute historical usage across models and attempts.
- Existing token surfaces are task metrics, live task detail, Live, Telemetry, and Analytics. Task cards and the list currently have no token consumption display, so they do not need a new token feature for this scope.

## Data flow and ownership

Provider report -> provider-specific normalization -> core ingestion and deduplication -> per-report valuation -> durable task metric -> shared aggregates -> UI.

Core owns normalization contracts, pricing, persistence, and aggregation. HTTP, MCP, dispatcher, reviewer, and telemetry adapters supply evidence. The browser formats values supplied by core and does not maintain a second price list.

Extend `task_metric` with nullable identity/attribution columns plus versioned `usage_json` and `valuation_json`. Keep all existing columns and their meaning. Store execution ID, provider event ID/deduplication key where available, provider, engine, pipeline stage, operation, worker, occurrence time, and attribution provenance. Reuse an existing execution identity if one is available when implementation begins; otherwise generate a UUID at session launch and propagate it through that session's reports. Pipeline stage and operation are separate: a review or visualization can run within a pipeline stage.

`usage_json` preserves billable counts and their semantics: ordinary input, cached reads, cache creation with known duration, unspecified cache creation, output, request input size, and relevant reported details. Unknown is distinct from zero. Preserve only allowlisted usage metadata, never prompts, credentials, or arbitrary telemetry payloads. Canonical input/output totals must reconcile with existing token displays; cache and reasoning subsets must not inflate total tokens.

`valuation_json` stores the policy/version, selected immutable rate snapshot and source, normalized components, calculation version, amount in integer nanodollars serialized as a decimal string, status, assumptions, and coverage. Decimal rate arithmetic must not use floating-point accumulation. Round once to nanodollars per report and round to display precision only after aggregation. A copied rate snapshot per report is intentionally simple and makes historical estimates independent of future catalogue edits.

Use statuses `complete`, `partial`, and `unavailable`. A partial amount is the sum of independently priceable components, accompanied by missing categories/reasons. Track priced, unpriced, and unknown token counts plus incomplete report counts; do not invent a coverage percentage when the denominator is unknown. Missing models or rates never become zero-dollar usage. An explicitly measured zero remains zero.

## Pricing policy

Maintain a checked-in, validated catalogue of exact provider/model identifiers and explicitly verified aliases. Each entry contains decimal USD rates per million tokens, component semantics, context thresholds, effective interval when known, verification date, policy, and official source URL. Do not use fuzzy model matching or substitute a similarly named public model for an internal model ID.

Compute each request under its applicable rules before summing. Aggregated CLI model totals can only be fully valued if the applicable rate does not require unavailable per-request context or cache information; otherwise preserve the limitation. Reasoning tokens already included in output are not charged twice. Cache-write rules are provider/model-specific and may be additive or replacement components; encode documented semantics rather than assuming a universal four-term formula.

Public lists consulted on 2026-09-14: [OpenAI API pricing](https://developers.openai.com/api/docs/pricing) and [Anthropic API pricing](https://platform.claude.com/docs/en/about-claude/pricing). Their separate cache categories and model-specific rules require more than a single input/output rate. Reverify rates and the relevant usage/caching documentation when implementing; the catalogue is the dated numerical source of truth, not this design document.

Use a rate effective at the usage occurrence time when evidence supports it. A newly observed price is not automatically valid for earlier usage. An explicit current-price historical comparison may be offered later with a different policy label. Existing estimates stay pinned when the catalogue changes; an explicit backfill may fill previously unavailable estimates with proven applicable rates without rewriting existing completed estimates.

## Reliability and history

Deduplicate replayed delivery of the same provider event atomically. Two genuinely separate billable requests with equal token counts must both survive. Namespace stable IDs by provider and execution; do not derive identity from counts or the in-memory telemetry sequence. Choose one authoritative usage stream per execution, preserving the existing OTel-versus-CLI gate. CLI summaries may enrich a matched record but must not be added to already recorded request totals. Normalize cumulative counters to deltas only for sources documented as cumulative.

Capture usage for implementation, review, visualization, and feedback evaluation, including failed attempts. Late usage retains its original attribution and must not change task lifecycle state. Legacy timing-based stage attribution remains explicitly inferred; missing operation or engine stays unknown.

Migration preserves old metrics and reported costs. Historical records with lost categories remain partial/unavailable. An explicit dry-run enrichment/backfill can use retained reports only when a unique match and original semantics can be proven. It must be idempotent, preserve token totals, and report skipped ambiguities. Unmatched imports must not silently duplicate legacy aggregate usage.

## Presentation

Use one `ApiCost` component with compact and detailed variants. Examples are `≈$1.24 API`, `≈$1.24 API · partial`, `Price unavailable`, and `<$0.01 API` for a nonzero value below the compact precision. Expanded details show rates, categories, coverage, assumptions, model, source links, and pricing verification date. Label zero explicitly only for a complete zero estimate. A partial zero subtotal needs the partial label.

Task breakdown rows and subtotals show tokens and cost over identical report sets. Live views explicitly identify whether values cover the current execution or the whole task and use that same scope for both quantities. Telemetry totals describe the retained event window. Analytics groups usage by recorded model, stage, worker, workspace, and occurrence date; its date filters must not attach an entire task lifetime's cost to the task's completion date.

Expose a small read-only pricing details view reachable from cost details, including supported models, policy, official sources, last verification, and missing mappings. Catalogue updates remain reviewed repository changes in this release.

## Acceptance

Every existing token surface presents the corresponding estimate or an explicit unavailable state. Task, breakdown, live, telemetry, and analytics agree when given the same report set. Provider fixtures prove cache normalization, model attribution, pricing boundaries, replay safety, and history stability. Old clients and old metric payloads remain compatible. Historical uncertainty is visible rather than converted to an invented precise total.
