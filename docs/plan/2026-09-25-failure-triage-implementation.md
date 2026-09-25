# Failure triage implementation plan

**Status:** Proposed v2 (revised 2026-09-25 alongside spec v2); documentation only. No implementation, provider calls with task data, or feature enablement performed.
**Spec:** [Advisory failure triage](../spec/2026-09-25-failure-triage-design.md)
**Goal:** Give users an evidence-based likely-cause label beside existing failures, without changing execution behavior. Phase 1 does it with local rules; Phase 2 adds a provider fallback only if Phase 1's evaluation says it is worth it.

## Working rules

- Use a feature branch/worktree and the repository's PR flow with Conventional Commits. Design docs live in `docs/spec/` and plans in `docs/plan/`.
- Use the correct-case checkout path (`C:\Git\AgentFactory`, or the actual worktree path) as the working directory. Plain `git` there is sufficient. Do not use `git -C`.
- Node >= 26; TypeScript uses `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `isolatedModules`, and casing enforcement. Preserve NodeNext `.js` import suffixes. Tests use the Vitest 2 workspace configuration and the existing node:sqlite shim where needed; browser tests use the web project's jsdom configuration.
- In an isolated worktree, run `npm ci --cache .npm-cache` there so `@agentfactory/*` links cannot resolve the parent checkout's build. Build core before tests that import its package exports. Keep npm caches untracked.
- For every behavioral slice, write the failing test, observe the relevant failure, implement the minimum change, then run the focused tests.
- Do not modify dispatcher/reviewer/watcher failure generation. The episode rule (spec section 4) handles the dispatcher's log-less `max_attempts` note without changing its writer. The only change outside triage code is Phase 2's MCP `add_comment` prefix reservation (step 6).
- Do not refactor intake into a shared framework.

## Delivery sequence

| PR | Work | Exit condition |
| --- | --- | --- |
| A | Steps 1-2: episode identity, evidence normalization, rule classifier, display policy | Core tests pass, including characterization of existing failure selection; nothing user-visible. |
| B | Step 3: derived read model, source/history/feedback operations and routes, prefix reservation, MCP stripping | Core, web-route, and MCP tests pass. |
| C | Step 4: banner panel, correction, source log | Browser evidence of the full Phase 1 flow; Phase 1 is live. |
| — | Step 5: Phase 1 evaluation | Dated report with held-out rule metrics, live confirm/correct and unknown share, and an explicit Phase 2 go/no-go. |
| D | Step 6 (Phase 2): authenticity prerequisite, settings, outbound input, persisted assessments, durable operations, HTTP parity | Core/contract/auth tests pass; no provider process enabled. |
| E | Step 7: optional fixture-backed supervisor, outage cooldown, heartbeat migration | Fixture assessments complete in db and authenticated board modes; race, outage, and error tests pass. |
| F | Step 8: Jev adapter and synthetic contract verification | Pinned model returns valid decisions; no production workspace enabled. |
| G | Step 9: provider UI states, settings, evaluation against rules, pilot | Held-out report meets FT-14 and an explicitly opted-in workspace is configured. |

A-C ship Phase 1. D-G happen only after a written "go" from step 5. D-F ship off by default; G is an evaluation/rollout deliverable, not permission to enable a workspace while implementing D-F.

# Phase 1

## 1. Establish failure-event and episode identity

**Existing files:** `packages/core/src/repo/tasks.ts`, `repo/activity.ts`, `failure.ts`, public exports in `index.ts`; tests under `packages/core/test/`.

1. Write characterization tests for current failure selection: latest failure, later result/review/restart, later unrelated comment, malformed latest failure, and old notes outside recent activity. (The SQL selector matches `lower(body) LIKE 'failure/v1%'` without trimming while `isFailureMarker` trims, but `addComment` trims every body before storing it, so a whitespace-prefixed marker cannot be written and needs no characterization.) Establish current behavior before extracting anything.
2. Extract a shared current-failure projection retaining activity ID, timestamp, parsed fields, and body. Reuse it for existing `Task.failure`; do not add a new independent selector with subtly different clearing rules.
3. Add the episode and evidence-event rule. Build fixtures with `buildFailureComment` using the dispatcher's real arguments. Cover:
   - A final-attempt timeout/crash note (with log) followed by `max_attempts`: the evidence is the timeout/crash note.
   - `max_attempts` with no predecessor, a malformed predecessor, a predecessor from another source, or a predecessor before a supersede marker: no usable evidence.
   - `stale` and log-less timeout notes: no fallback.
   - A reviewer's final `review_failed`: its own evidence.
4. Provide batched projections for task lists and exact task-scoped source lookup. An activity ID from another task must fail.
5. Characterize archive/done filtering for triage separately from original failure presentation. Triage must not alter existing failure visibility rules.

**Proof:** FT-02 characterization tests; existing failure, task-list, retry, and analytics suites unchanged. Compare original failure payloads before/after extraction using the same fixture sequence.

## 2. Evidence normalization, rules, and display policy

**New files:** `packages/core/src/failureTriage.ts` (taxonomy, types, display policy), `failureTriageEvidence.ts`, `failureTriageRules.ts`, and focused tests with fixtures under `packages/core/test/fixtures/failure-triage/`.
**Existing files:** `packages/core/src/types.ts`, `index.ts`.

1. Define the seven categories, their boundaries, and their suggestions from spec section 6 in a single source. Fix the category order for deterministic reporting.
2. Implement `failure-triage-evidence/v1`: header/evidence separation, CRLF/ANSI/control-character normalization. Fixtures: CRLF, ANSI, nested fences, huge lines, malformed JSON headers. Never alter the stored note.
3. Write per-rule positive and negative fixtures before each rule. Model them on real note shapes: dotnet/tsc/vitest output, npm/NuGet 401s, git push rejections and merge conflicts, network/rate-limit errors, codex/claude CLI errors, watcher-captured build errors. Implement the explicit-reason fast path, ordered patterns with rule IDs, the precedence order, `alsoMatched`, and the bounded matched line.
4. Test that bare reasons and supervisor boilerplate never match (for example the dispatcher's timeout and "exited without claiming" wording), and that incidental text (a `401` inside a test name, `ENOENT` in an unrelated path) is covered by negative fixtures.
5. Implement display policy v2 for Phase 1 sources (human label > non-unknown rule > unknown). Leave the provider branch for step 6.

**Proof:** FT-02/FT-03 unit tests; a rule-coverage table (rule ID → fixtures) in the test file.

## 3. Read model, feedback, and worker stripping

**New files:** `packages/core/src/ops/failureTriage.ts`, `packages/web/server/routes/failureTriage.ts`, and focused tests.
**Existing files:** `repo/activity.ts`, `repo/tasks.ts`, `ops/addComment.ts`, `index.ts`, `types.ts`; `packages/web/server/app.ts`; `packages/mcp/src/content.ts`, `tools/listTasks.ts`, and the claim path.

1. Add the batched `Task.failureTriage` summary to list and detail projections. Test that the query count stays constant as the number of failing tasks grows.
2. Add the exact source read for the current and evidence events: task-scoped, rejecting foreign IDs, with graceful not-found after task deletion.
3. Add `recordFailureTriageFeedback` and the `failure-triage-feedback/v1` marker: validation, bounded note, latest-wins, historical annotation, and no carry-forward to a newer failure.
4. Hide feedback markers from recent activity before its limit; add cursor-paginated history; keep malformed markers inert. Test that old human comments are retained after many internal markers.
5. Reserve the triage prefixes in core `addComment` for humans and agents.
6. Strip `failureTriage` and triage markers (including malformed ones) from MCP detail, list, and claim serializers. Retain original failure notes.
7. Add the history, source, and feedback routes with `rejectService`; derive feedback identity from the principal. Test service denial, forged actor fields, and cross-task source IDs.

**Proof:** FT-04/FT-05. Feedback moves `getVersion()`; task `updated_at`, status, claims, and worker budgets are untouched.

## 4. Banner UI

**Existing files:** `packages/web/client/src/{types,api}.ts`, `components/FailureBanner.tsx`, `DetailPanel.tsx`, existing styling conventions.
**New components/tests:** a compact failure-triage panel, with client tests under `packages/web/test/client/`.

1. Mirror the additive types and implement the API calls. Keep the original failure chip and restart behavior intact.
2. Render the rule label, rule ID, matched line, fixed suggestion, and "Based on attempt N's log" when the evidence came from an earlier note. Render human-labeled and unknown states.
3. Replace the recent-activity log lookup with the exact source read; test a note older than the recent-activity limit and a task deleted during the fetch.
4. Implement inline confirm/correct controls with an optional bounded note, keyboard navigation, saving/error states, and task-query refresh through the drawer callback. Test a new failure arriving while a feedback form for the old one is open: the feedback may annotate the old event but must never label the new one.
5. Smoke-test with auth enabled using fixture failures, including a skip-listed task produced by the dispatcher's final-attempt + `max_attempts` sequence: the label reflects the final attempt's log, the source expands, a correction is attributed, and restart clears the triage along with the original failure.

**Proof:** FT-01/FT-06 client tests plus browser evidence of the complete flow. No full-page reloads, window prompts, or new restart semantics.

## 5. Phase 1 evaluation and Phase 2 decision

**New artifacts:** the labeled corpus under `packages/core/test/fixtures/failure-triage/corpus/`, an opt-in evaluation script run via `tsx`, and a dated results document under `docs/`.

1. Assemble and split the corpus specified in spec section 10. Store no real credentials, proprietary logs, or production task IDs. Test the report calculations with a tiny hand-checked result set.
2. Freeze the rules, then run them on the held-out set. Report confusion, displayed precision, coverage, abstention, and per-category counts next to the reason-only mapping. Remove or tighten (on the tuning set) any rule that keeps displayed precision below 90%.
3. After Phase 1 has run on the live board for a while, record the confirm/correct rate among labeled events and the share of current episodes left unknown, using local history only.
4. Write the dated report with an explicit Phase 2 go/no-go and its reasoning. A no-go ends this plan here.

**Proof:** FT-01 to FT-06 green; report committed.

# Phase 2 (only after a "go" in step 5)

## 6. Prerequisites, outbound input, and durable core operations

**New files:** `packages/core/src/failureTriageInput.ts`, `failureTriageSettings.ts`, `ops/failureTriageSettings.ts`, focused tests.
**Existing files:** `packages/mcp/src/tools/addComment.ts`, `packages/core/src/ops/failureTriage.ts`, `repo/retry.ts` (reuse without changing unrelated retry semantics), `httpCore.ts`, `packages/web/server/routes/agentOps.ts`, `routes/failureTriage.ts`.

1. **Authenticity first.** Make the MCP `add_comment` tool reject bodies starting with `failure/v1` or a triage prefix, in both backend modes. Before merging, search skills, scripts, and the ado-bridge repository for legitimate MCP writers of failure notes.
2. **Settings.** Normalize stored settings to off on corruption, reject invalid human updates, deduplicate workspace names, and enforce the specified limits. No provider credentials in settings.
3. **Outbound input `failure-triage-input/v1`** over the evidence event: redaction before truncation, fixed bounds, preparation metadata, and a canonical fingerprint covering both source and evidence IDs. Fixtures: multiline secrets, URL query credentials, Windows/POSIX absolute paths, partially malformed blocks. Sentinel secrets must be absent from the complete serialized outbound state, including detail/source fields. Add local no-usable-evidence and sensitive-input results.
4. **Assessment schema.** Strict discriminated outcome variants, reserved marker parsing, distribution validation, provider metadata, and nullable usage fields. Add the provider branch to the display policy with exact threshold-boundary and tie tests.
5. **Candidates.** Selection from current episodes whose rule result is unknown and which have no human label, excluding assessed/busy/backoff events before the limit. Test that a busy first page cannot starve later events, and that a rules change or new feedback makes an event ineligible.
6. **Durable operations.** begin/validate/complete/recover as specified in spec section 8.4, with begin reserving and marking running in one transaction under `failure-triage:assess:<sourceActivityId>`. Exercise two core instances against the same database. Validate the 150-second lease and the exact source/evidence/workspace/fingerprint before egress and at publication; test supersession, opt-out, workspace moves, archive, completion, and deletion at each boundary. Test idempotent replay after response loss, exhausted finalization after a crash, and database reopen between steps.
7. **Error handling.** Durable backoff `min(6h, 5min * 4^(attempt - 1))` derived from `settled_at`; timeout/network/429/529/5xx/malformed handling; auth cancellation; terminal 4xx; size-error refund. A transient board publication error must not trigger another provider call while a valid response is held.
8. **Retry triage.** `retryFailureTriage` accepts only an `unavailable` current event and calls `advanceRetryBudget`. Test that a later marker supersedes the `unavailable` one for display and that `assessed`/`insufficient_evidence` events reject retry.
9. **HTTP parity.** Implement the spec section 8.7 route table. Supervisor routes require a supervisor token; test that plain service, user, and anonymous tokens are denied. Human settings/retry routes use `rejectService`. Add `createHttpCore` bindings and an awaitable supervisor Core slice; runtime and candidate responses carry only documented fields, and sanitized evidence is delivered only by begin. Run db and HTTP implementations through the same fixture contract, including exact prepared input and idempotent replay.

**Proof:** FT-07 to FT-10 and FT-12. Database tests show no status/claim/worker-budget changes, no recursive failure notes, and unchanged task timing.

## 7. Optional fixture-backed supervisor, cooldown, and health

**New package:** `packages/failure-triage/` with `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/{index,config,provider,supervisor}.ts`, an example config, a README, and injected-dependency tests.
**Existing files:** root `package.json`, `package-lock.json`, `tsconfig.json`, `vitest.workspace.ts`, `.gitignore`; core `schema.ts`, `migrate.ts`, `types.ts`; the HTTP heartbeat schema and the client supervisor-kind mirror/display.

1. Follow current supervisor conventions for db XOR board, config-relative DB resolution, key/token environment-variable names, authenticated `whoami` startup (supervisor capability required), and sanitized errors. Keep fixture mode available without any provider secret.
2. Implement one request at a time, no overlapping ticks, recovery before polling, bounded candidate processing, heartbeat, graceful cancellation, and the final pre-egress validation. Inject fetch/time/exit/log functions for deterministic tests.
3. Implement the supervisor-wide cooldown (30 seconds doubling to 10 minutes, reset on success). Test a simulated 10-minute provider outage with ten pending events: no event is exhausted, and processing resumes after recovery.
4. Separate provider errors from board transport/publication conflicts. Test a lost acknowledgement after a committed board transaction and board unavailability through lease expiry. Test stop while polling, waiting for the provider, and publishing; auth failures halt further calls; shutdown must not erase another process's replacement attempt.
5. Append a heartbeat-kind migration with the next free number, updating the fresh schema and widening constants consistently; never edit an applied migration. Test fresh and upgraded databases, row preservation, CHECK enforcement, and `foreign_key_check`.
6. Add explicit `failure-triage` and `failure-triage:dev` scripts. Leave the combined `supervisors` command unchanged; document running the optional process beside it. Ignore the real local config and keep an example without credentials.
7. Add the package to build references and Vitest workspace discovery.

**Proof:** FT-10/FT-11/FT-13 using the fixture provider in both modes, including an actual HTTP board with supervisor-token auth. Kill and restart a fixture supervisor and verify durable recovery. No external API is needed.

## 8. Implement and verify the Jev adapter

**New files:** `packages/failure-triage/src/providers/jev.ts`, adapter tests, and sanitized synthetic response fixtures.
**Reference only:** `packages/intake/src/providers/jev.ts` and the intake setup documentation.

1. Recheck the official [API](https://docs.typesafe.ai/api), [primitives](https://docs.typesafe.ai/primitives), and [models](https://docs.typesafe.ai/models). Configure an available pinned model; do not silently inherit a moving alias. Record the verification date, endpoint, requested/returned model, and response shape.
2. Write request-shape tests for exactly one Choice and one Noul in one call, with full category criteria (no null criteria) and only the prepared input in `state`. Test that log text cannot alter the questions or request headers.
3. Implement fetch with an AbortSignal; recognize aborts via the signal rather than assuming an `AbortError` name. Map Noul's `noul` and Choice's category/distribution/confidence into the provider-neutral contract, preserving null for missing usage/model metadata where allowed.
4. Test every error class from spec section 8.4, including 529, invalid JSON, oversized context, invalid distributions, and the backoff bounds. Never log authorization, request bodies, raw error objects, or response content.
5. Run one controlled live request containing only synthetic failure text, using configured credentials without printing them. Validate the result through core's real schema and save only a sanitized fixture and verification note. If credentials are unavailable, mark live compatibility unverified; fixture success is not proof of real-provider compatibility.

**Proof:** FT-08/FT-09/FT-11 plus the synthetic part of FT-14. No workspace logs are sent and no live board setting changes.

## 9. Provider UI, evaluation, and pilot

1. Render pending, assessed, insufficient-evidence, and unavailable provider states with fixed display-policy text, provider/model attribution, and excerpt/redaction warnings, never generated prose or numeric correctness claims. Offer "Retry triage" only on `unavailable`.
2. Add the Failure triage section to Task Intelligence settings, with independent off/advisory and workspace controls and an explicit explanation of what text leaves the machine. Saving refreshes the current client's queries; document other-tab refresh behavior rather than extending global SSE settings mechanics.
3. Run the held-out evaluation for the combined configuration (rules, then the provider on rules-unknown episodes) with the same frozen corpus, recording question/input/display/rules versions and the pinned model. Enforce the spec section 10 gate against the rules baseline; report provider-alone results for information. Capture latency and reported tokens; unknown usage stays null. A failed gate leaves real-workspace rollout disabled.
4. Document process setup, independent opt-in, redaction limits, supervisor tokens, cooldown/auth-stop/recovery, retry, unavailable/unknown states, and how to turn it off. Add a short root README entry linking the package README.
5. Enable a pilot only for a workspace explicitly opted in by its operator after provider data-handling verification. Collect confirmation/correction rates and do not claim unlabeled examples are correct.

**Proof:** FT-14 report and operator-visible pilot results. Automated actions remain out of scope regardless of pilot quality.

## Final verification and handoff

Run focused tests during each slice; once integrated, from the exact checkout root:

```powershell
npm run build
npm test
npx tsc -p packages/web/client/tsconfig.json --noEmit
git diff --check
```

Capture the actual results, not a prefilled success claim. Existing failure, delivery repair, reviewer, dispatcher, intake, retry, analytics, auth, and MCP tests must remain green. For Phase 2, use fixture integration to compare status/activity/worker-budget outcomes with triage off and on; the only additions should be advisory triage/feedback markers and triage's own retry/heartbeat records. Verify no tracked local config, API key, raw captured log, or npm cache enters the diff.

Commit verified slices with Conventional Commits and use the repository PR handoff. PR descriptions should explain the original generic failure banner, the resulting advisory label, validation, and any unverified provider/evaluation gate. Declare Phase 1 complete only when A-C pass and step 5's report exists; declare pilot readiness only after G's separate evidence exists.
