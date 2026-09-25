# Failure triage implementation plan

**Status:** Proposed; documentation only. No implementation, provider calls with task data, or feature enablement performed.
**Spec:** [Advisory failure triage](../specs/2026-09-25-failure-triage-design.md)
**Goal:** Give users an evidence-based likely-cause label beside existing failures, without changing execution behavior.

## Working rules

- Use a feature branch/worktree and the repository's PR flow with Conventional Commits. Commit these design/plan documents in their current `docs/superpowers` locations.
- Use the correct-case checkout path (`C:\Git\AgentFactory`, or the actual worktree path) as the working directory. Plain `git` there is sufficient. Do not use `git -C`.
- Node >= 26; TypeScript uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`, and casing enforcement. Preserve NodeNext `.js` import suffixes. Tests use Vitest 2 workspace configuration and the existing node:sqlite shim where needed; browser tests use the web project's jsdom configuration.
- If using an isolated worktree, install dependencies there so `@agentfactory/*` links cannot resolve the parent checkout's build. Build core before tests importing its package exports. Keep npm caches untracked.
- For every behavioral slice, write the failing test, observe the relevant failure, implement the minimum change, then run the focused tests. These documentation changes themselves need link/contract/diff verification, not runtime tests.
- Do not modify dispatcher/reviewer/watcher failure generation unless integration proves a necessary compatibility fix. Do not refactor intake into a shared framework.

## Delivery sequence

| PR | Work | Exit condition |
| --- | --- | --- |
| A | Steps 1-3: source identity, contracts, durable core operations | Core tests pass; no provider process enabled. |
| B | Steps 4-5: HTTP parity, optional supervisor, fixture provider, heartbeat migration | Fixture assessment completes in db and authenticated board modes; race/error tests pass. |
| C | Step 6: Jev adapter and synthetic contract verification | Pinned model returns valid new decisions; no production workspace enabled. |
| D | Step 7: banner, correction/history, settings | Human flow works end-to-end; worker payloads retain original evidence only. |
| E | Step 8: evaluation, documentation, limited pilot | Held-out report meets FT-11 and an explicitly opted-in workspace is configured. |

PR D may build on B while provider verification proceeds independently. A-D ship off by default. E is an evaluation/rollout deliverable, not permission to enable a workspace while implementing A-D.

## 1. Establish exact failure-event identity

**Existing files:** `packages/core/src/repo/tasks.ts`, `repo/activity.ts`, `failure.ts`, public exports in `index.ts`; tests under `packages/core/test/`.

1. Write characterization tests for current failure selection: latest failure, later result/review/restart, later unrelated comment, malformed latest failure, and old notes outside recent activity. Establish current behavior before extracting anything.
2. Extract a shared current-failure projection retaining activity ID, timestamp, parsed fields, and body. Reuse it for existing `Task.failure`; do not add a new independent selector with subtly different clearing rules.
3. Provide batched projections for task lists and exact task-scoped source lookup for history/log access. An activity ID from another task must fail.
4. Characterize archive/done filtering for new triage separately from original failure presentation. Triage must not alter existing failure visibility rules globally.

**Proof:** FT-02/FT-07 characterization tests; existing failure, task-list, retry, and analytics suites unchanged. Compare original failure payloads before/after extraction using the same fixture sequence.

## 2. Add domain types, preparation, and display policy

**New files:** `packages/core/src/failureTriage.ts`, `failureTriageInput.ts`, `failureTriageSettings.ts`, and focused tests.
**Existing files:** `packages/core/src/types.ts`, `index.ts`.

1. Write failing tests for the three terminal outcome variants, reserved marker parsing, distribution validation, provider metadata, and independent nullable usage fields. Implement strict discriminated schemas and defensive stored-marker parsing.
2. Define the seven categories and their criteria/suggestions from spec section 6 in a single source consumed by provider and display logic. Fix the category order for deterministic reporting; probability ties abstain.
3. Implement `failure-triage-input/v1`: evidence/header separation, normalization, redaction before truncation, fixed excerpt bounds, metadata, and canonical fingerprint. Use synthetic fixtures covering CRLF, ANSI, nested fences, multiline secrets, URL query credentials, Windows/POSIX absolute paths, huge lines, and partially malformed blocks. Do not alter the stored original note.
4. Implement local no-usable-evidence and sensitive-input results. Test generic `max_attempts` and bare timeout cases without importing previous attempts' logs. Define canonical empty/null handling and stable hash ordering.
5. Implement the pure display policy (0.75 evidence probability, 0.75 category probability, 0.20 margin), human-label precedence, and unknown/unavailable distinctions. Test exact threshold boundaries and ties; never reinterpret provider confidence as correctness.
6. Normalize stored settings to off on corruption, reject invalid human updates, deduplicate workspace names, and enforce the specified limits. No provider credentials in settings.

**Proof:** FT-03/FT-04 schema, preparation, fingerprint, settings, and policy tests. Sentinel secrets must be absent from the complete serialized outbound state, including detail/source fields, not just the log excerpt.

## 3. Persist assessments and fence durable work

**New files:** `packages/core/src/ops/failureTriage.ts`, `ops/failureTriageSettings.ts`, focused operation/recovery tests; add a small repository helper if needed.
**Existing files:** `repo/activity.ts`, `repo/tasks.ts`, `ops/addComment.ts`, `index.ts`, `types.ts`; reuse `repo/retry.ts` without changing unrelated retry semantics.

1. Test and implement bounded candidate selection from current events, excluding assessed/busy/backoff events before the limit. Test a busy first page cannot starve later events.
2. Add begin/validate/complete/recover operations and bind them through Core. Core derives task/source identity, live settings, and the attempt limit; it returns sanitized prepared input rather than trusting a caller-provided log body or hash.
3. Begin must reserve and move to running in the same transaction, scoped to `failure-triage:assess:<sourceActivityId>`. Exercise two core instances against the same database, not only two promises on one object.
4. Validate the 150-second lease and exact source/workspace/fingerprint before egress and publication. Test source replacement, result/review/restart, opt-out, move between enabled workspaces, archive, completion, and deletion at each boundary.
5. Complete appends an assessment and settles its reservation atomically. Idempotent replay returns the existing terminal record after response loss; a replay for another task/source is rejected. Local terminal and exhausted-finalization paths recheck eligibility and evidence/budget in core.
6. Persist retry errors and derive bounded exponential backoff from durable attempt/settlement fields; implement timeout/network/429/529/5xx/malformed response handling, auth cancellation, terminal 4xx, and size-error refund. Separate provider settlement from board transport failure. A transient board publication error must not initiate another provider call while a valid response is held.
7. Recover only expired triage running attempts, including when no eligible candidates remain; use conditional settlement to fence late completions. A recovered attempt consumes one attempt, and a final failed attempt followed by process death still finalizes unavailable after restart. Test database reopen between steps.
8. Add batched `Task.failureTriage`, cursor-paginated history, and exact source reads. Hide internal markers before recent-activity limits; reserve their prefixes in generic comments. Publication changes the existing activity-based version signal without touching task timing fields.
9. Add human feedback operations with task/source/assessment checks, immutable model results, bounded local notes, latest-feedback selection, and historical feedback support. Unavailable results reject feedback.
10. Strip the new summary and marker families from MCP detail, list, and claim serializers, including malformed prefixes. Retain original failures. Include these filters in this PR even before a provider exists so the data contract is safe to expose.

**Proof:** FT-01/02/05/06/07/08. Database tests cover concurrency, reopened SQLite, lost-response replay, no status/claim/worker-budget changes, no recursive failure notes, unchanged task timing, and old human comments retained after many internal markers.

## 4. Wire HTTP parity and authorization

**Existing files:** `packages/core/src/httpCore.ts`, `packages/web/server/app.ts`, `routes/agentOps.ts`, `routes/tasks.ts`, associated type surfaces.
**New file:** `packages/web/server/routes/failureTriage.ts`; tests beside `httpCore.contract.test.ts`, `agentOps.test.ts`, and auth/task route suites.

1. Implement the exact route table in spec section 9, including the scoped recovery endpoint. Use inline validated Hono handlers where needed to preserve route type inference.
2. Human settings/history/source/feedback routes use `rejectService`; all runtime/begin/validate/complete/recovery routes use `requireService`. Derive feedback identity from the principal, never request body fields.
3. Add `createHttpCore` bindings and an awaitable supervisor Core slice. Runtime and candidate responses contain only the documented fields; sanitized evidence is delivered only by begin. Prevent raw source data from leaking into candidate lists or logs.
4. Validate request bounds, positive source IDs, cursor limits, completion variants, and settings. Use established error-to-HTTP mapping for validation, conflict, and not-found outcomes; expected ineligibility is a typed normal operation result where practical.
5. Test valid plain service access, denied user/anonymous service access, denied service writes to human feedback/settings, forged actor fields, and cross-task source IDs. Document the shared plain-service trust boundary.
6. Run db and HTTP implementations through the same fixture contract, including exact prepared input and idempotent replay.

**Proof:** FT-03/05/08/09 contract/auth tests. Probe the authenticated whoami route in startup tests; AUTH_MODE=none is not a valid board-mode supervisor configuration.

## 5. Add the optional fixture-backed supervisor and health

**New package:** `packages/failure-triage/` with `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{index,config,provider,supervisor}.ts`, example config, README, and injected-dependency tests.
**Existing files:** root `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.workspace.ts`, `.gitignore`; core `schema.ts`, `migrate.ts`, `types.ts`; HTTP heartbeat schema and client supervisor-kind mirror/display.

1. Follow current supervisor conventions for db XOR board, config-relative DB resolution, key/token environment-variable names, authenticated startup, and sanitized errors. Keep fixture mode available without any provider secret.
2. Implement one request at a time, no overlapping ticks, recovery before polling, bounded candidate processing, heartbeat, graceful cancellation, and the final pre-egress validation. Inject fetch/time/exit/log functions for deterministic tests.
3. Separate provider errors from board transport/publication conflicts. After obtaining a valid result, retry only publication within the lease. Test lost acknowledgement after a successful board transaction and board unavailability through lease expiry.
4. Test stop while polling, waiting for provider, and publishing; auth failures halt further calls. Shutdown must not erase another process's replacement attempt.
5. Append a heartbeat-kind migration, choosing the next free number at implementation time. Update the fresh schema and migration widening constants consistently; do not edit an applied migration. Test upgrades from the current schema and a fresh database, row preservation, CHECK enforcement, and `foreign_key_check`.
6. Add explicit `failure-triage` and `failure-triage:dev` scripts. Leave the existing combined `supervisors` command unchanged in v1; document running the optional process beside it. Ignore the real local config and keep an example without credentials.
7. Add the package to build references and Vitest workspace discovery; preserve node:sqlite test configuration and independent dependency links in worktrees.

**Proof:** FT-01/05/06/09 using fixture provider in both modes, including an actual HTTP board with service auth. Kill/restart a fixture supervisor and verify durable recovery. No external API is needed for this step.

## 6. Implement and verify the Jev adapter

**New files:** `packages/failure-triage/src/providers/jev.ts`, adapter tests and sanitized synthetic response fixtures.
**Reference only:** `packages/intake/src/providers/jev.ts` and intake setup documentation.

1. Recheck the official [API](https://docs.typesafe.ai/api), [primitives](https://docs.typesafe.ai/primitives), and [models](https://docs.typesafe.ai/models). Configure an available pinned model; do not silently inherit a moving alias. Record verification date, endpoint, requested/returned model, and response shape.
2. Write request-shape tests for exactly one Choice and one Noul in one call, full category criteria, and only the prepared input in `state`. Test that log text cannot alter questions or request headers.
3. Implement fetch with AbortSignal; recognize abort via the signal rather than assuming only an AbortError name. Map Noul's `noul` and Choice's returned category/distribution/confidence into the provider-neutral contract. Preserve null for missing usage/model metadata where allowed.
4. Test every error class from spec section 8, including 529, invalid JSON, oversized context, invalid distributions, and fixed backoff bounds. Never log authorization, body, raw error objects, or response content.
5. Run one controlled live request containing only synthetic failure text, using configured credentials without printing them. Validate the result through core's real schema and save only a sanitized fixture/verification note. If credentials are unavailable, mark live compatibility unverified; fixture success is not proof of real-provider compatibility.

**Proof:** FT-03/04/06 plus the synthetic part of FT-11. No workspace logs are sent in this step and no live board setting changes.

## 7. Build the advisory user flow

**Existing files:** `packages/web/client/src/{types,api}.ts`, `components/FailureBanner.tsx`, `DetailPanel.tsx`, Task Intelligence settings host, existing styling conventions.
**New components/tests:** a compact failure-triage panel and settings section, with client tests under `packages/web/test/client/`.

1. Mirror the additive types and implement API calls. Keep the original failure chip and restart behavior intact.
2. Render pending, assessed, insufficient-evidence, unavailable, and human-labeled states. Use fixed text from the display policy, not generated model prose or numeric correctness claims.
3. Fetch original source log by exact ID on expansion; test a note older than the recent activity limit and a task deleted during fetch. Show excerpt/redaction warnings and separate assessment history.
4. Implement inline confirm/correct controls with optional bounded note, keyboard navigation, saving/error states, and task-query refresh through the drawer callback. Test a new failure arriving while a historical feedback form is open; the feedback may annotate its old assessment but must never label the new one.
5. Add independent off/advisory and workspace controls, with explicit excerpt-egress explanation. Saving refreshes the current client's queries; document other-tab refresh behavior rather than extending global SSE settings mechanics.
6. Smoke-test the rendered flow with synthetic fixture failures and auth enabled: classification appears, source expands, correction is attributed, original result remains in history, and restart clears the current triage with the original failure.

**Proof:** FT-07/08/09/10 client/route tests plus browser evidence of the complete flow. No full-page reloads, window prompts, or new restart semantics.

## 8. Evaluate and document the pilot

**New artifacts:** synthetic labeled fixtures and an opt-in offline evaluation runner under the new package; a dated results document under `docs/` after measurement.

1. Assemble and split the corpus specified in spec section 11. Store no real credentials, proprietary logs, or original production task IDs. Test the report calculations with a tiny hand-checked synthetic result set.
2. Record question/input/display versions and pinned model with each run. Freeze the held-out set; report full counts and per-class outcomes alongside percentages.
3. Compare with the reason-only baseline and enforce the proposed 90% precision / at least 20 accepted predictions / +10 percentage-point coverage gate. Capture latency and reported tokens; unknown usage stays null. Failed gates leave real-workspace rollout disabled.
4. Document process setup, independent opt-in, input redaction limits, auth-stop/recovery, unavailable/unknown states, source identity, feedback, and how to turn it off. Add a short root README entry linking the package README.
5. Enable a pilot only for a workspace explicitly opted in by its operator after provider data-handling verification. Collect labeled-event corrections and run the timed log-triage exercise. Do not claim unlabeled examples are correct or lifecycle speed changes were caused by Jev without comparison evidence.

**Proof:** FT-11 report and operator-visible pilot results. Future automated actions remain out of scope regardless of pilot quality.

## Final verification and handoff

Run focused tests during each slice; once integrated, from the exact checkout root:

```powershell
npm run build
npm test
npx tsc -p packages/web/client/tsconfig.json --noEmit
git diff --check
```

Capture the actual results, not a prefilled success claim. Existing failure, delivery repair, reviewer, dispatcher, intake, retry, analytics, auth, and MCP tests must remain green. Use fixture integration to compare status/activity/worker-budget outcomes with triage off and on; the only additions should be advisory triage/feedback and its separate retry/heartbeat records. Verify no tracked local config, API key, raw captured log, or npm cache enters the diff.

Commit verified slices with Conventional Commits and use the repository PR handoff. PR descriptions should explain the original generic failure banner, the resulting advisory category, validation, and any unverified provider/evaluation gate. Complete A-D only when their tests pass; declare pilot readiness only after E's separate evidence exists.
