# Codex cost in Telemetry (board-editable model prices)

## Context
The Telemetry view shows cost for Claude rows only. Claude Code's `api_request` OTel event carries `cost_usd`; Codex's `response.completed` event carries only token counts (`input_token_count` incl. cached, `cached_token_count`, `output_token_count`), so Codex rows show "–" and the header total under-counts. Decisions already made with the user: prices are **editable on the board** (app_kv, like `agent_models`), pre-filled with GPT-6.1 Sol, and applied to **new events only** (no backfill — `task_metric` doesn't keep the cached split).

## Approach
Compute cost at ingest in the OTLP receiver whenever an event arrives without a cost and its model has a price. That one point feeds both the live feed (`TelemetryStore`) and the durable `task_metric.cost_usd`, so the Telemetry view, task metrics and analytics all pick it up with no client changes to those views.

### 1. Core — `packages/core/src/modelPrices.ts` (new), exported from `src/index.ts`
- `ModelPrice { input: number; cachedInput: number; output: number }` — USD per 1M tokens. Doc = `Record<modelId, ModelPrice>`, app_kv key `model_prices`.
- `DEFAULT_MODEL_PRICES = { 'gpt-6.1-sol': { input: 2.00, cachedInput: 0.10, output: 10.00 } }` (OpenAI standard rates; fast mode and >272K-token requests bill higher, noted in the UI hint).
- `getModelPrices(db)`: stored doc if the key exists (corrupt → defaults, the `engine_settings`/`agent_models` rule), else defaults.
- `setModelPrices(db, input)`: zod-validated whole-document replace (`parse` + `ValidationError`); ids use `MODEL_ID_PATTERN` from `agentModels.ts`; prices finite, ≥ 0, ≤ 1000; ≤ 100 models. Reuse `getKv`/`setKv` (`src/repo/kv.ts`).
- `priceUsage(prices, model, { tokensIn, tokensCached, tokensOut }) → number | undefined`: `((in − cached)·input + cached·cachedInput + out·output) / 1e6`; undefined for an unpriced model.
- Bind `getModelPrices`/`setModelPrices` in `createCore` next to `getAgentModels` (not in `httpCore` — supervisors don't need it).

### 2. Receiver — `packages/web/server/routes/otel.ts`
Read `core.getModelPrices()` once per POST; for each hit with `costUsd === undefined` and a model, set `hit.costUsd = priceUsage(...)` before it goes to the live feed and `addTaskMetrics`. Claude's own `cost_usd` is never overridden.

### 3. REST — `packages/web/server/routes/modelPrices.ts` (new), mounted at `/api/model-prices` in `server/app.ts`
GET → `{ prices }`; PUT (whole doc, `rejectService` = human-only) → `{ prices }`. Mirrors `routes/agentModels.ts`.

### 4. Client
- `types.ts` re-export `ModelPrice`; `api.ts` `getModelPrices`/`setModelPrices`.
- `components/ModelPricesPanel.tsx` (new): table of model id / input / cached / output ($ per 1M), add row (datalist from the Codex `MODEL_CATALOG` ids), remove row, Save / unsaved count, same styling classes as `AgentModelsPanel`. Hint: "Applied to Codex events as they arrive; Claude reports its own cost. Not retroactive."
- `AgentPromptsModal.tsx`: third tab **Prices**.

## Tests (RED first)
- `packages/core/test/modelPrices.test.ts`: defaults when unset, replace + read back, validation errors (bad id, negative, NaN), corrupt KV → defaults, `priceUsage` math (cached split) and unpriced → undefined.
- `packages/web/test/server/otel.test.ts`: existing `codexBody()` (gpt-5-codex, unpriced) → cost stays null; with a stored price for it → expected cost on `task_metric` and `/api/telemetry`; Claude event keeps its own `cost_usd`.
- `packages/web/test/server/modelPrices.test.ts`: GET defaults, PUT replace, 400 on invalid, 403 with a service token in token mode.
- `packages/web/test/client/ModelPricesPanel.test.tsx`: renders prefilled row, edit + save sends whole doc.

## Verification
- `npm run build` + `npm test` in a fresh worktree off `main` (`npm ci --cache .npm-cache` first).
- Live: after merge/rebuild/restart of :8787 (only the board — no supervisor change), the next Codex reviewer event shows a cost in Telemetry, and Agents › Prices edits change subsequent costs.

## Delivery
Branch `feat/codex-model-prices` in `.worktrees/codex-prices`; Conventional Commits; then ask before merging/pushing.
