# Task Intake Intelligence implementation plan

Source: [Task Intake Intelligence, draft v0.3](../spec/2026-09-20-task-intake-intelligence-design.md).

Status: ready for staged implementation, checked against the repository on 2026-09-20; review decisions of the same day are folded in and the accepted contract adjustments are recorded in spec v0.3 (§0.1). PR A and fixture-backed PR B work have no remaining design blockers. The Jev adapter still requires the verification in Step 5. This planning task does not start implementation or enable third-party data egress.

## Scope and delivery order

Implement Stages 1–3: a provider-neutral core model, an optional intake supervisor, and advisory UI/analytics. Default to `off`, require workspace opt-in, and preserve queue/claim behavior. Stage 4 enforcement remains a separately reviewed follow-up after the calibration criterion is met. No `task_intake` table, claim exclusion, hold timer, or lifecycle edge belongs in this delivery.

Deliver as **three PRs, each safe to merge and deploy with the mode `off`**:

| PR | Steps | Ships |
|---|---|---|
| A | 1, 2, 3 | Core model, persistence/derivation, worker filtering, HTTP surface, override op. No network code, no migration. |
| B | 4, 5 | Intake supervisor, heartbeat-kind migration, reservation op, Jev adapter. Step 5 waits on API re-verification; Step 4 does not. |
| C | 6, 7 | Advisory UI and settings, then claim-context instrumentation and analytics — instrumentation last. |

Sequence: apply the accepted contracts below → domain/settings → persistence and worker filtering → HTTP surface → fixture supervisor and retries → Jev adapter → advisory UI and overrides → analytics and rollout. Provider-independent work can proceed before Jev API verification; real-provider work depends on that verification.

Use RED–GREEN–REFACTOR for each implementation step: add behavioral tests, observe their intended failure, make the minimal change, and run the focused suite again. Run commands from canonical `C:\Git\AgentFactory` or the correctly cased worktree root. Node >=26 is required. Preserve strict TypeScript, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes`. In a new worktree run `npm ci --cache .npm-cache`, then build before testing; do not share workspace links with the parent checkout. Use Conventional Commits locally; no push or PR without an explicit request.

## Accepted contract adjustments

These corrections are incorporated in spec v0.3 and are implementation requirements. Provider API re-verification remains a prerequisite of Step 5, not of starting PR A or the fixture-backed work in PR B.

| Gap | Accepted resolution |
|---|---|
| §7's policy signature omits stage even though architectural policy depends on it. The persisted assessment also omits stage. | Persist the assessed stage and pass stage explicitly to the pure policy function. Validate it against the current task on write. This also makes historical stage comparisons possible. |
| The draft promises no migration through Stage 3, but `supervisor_heartbeat.kind` has a SQL CHECK constraint. | Keep Stage 1 migration-free. Append a Stage 2 migration **widening** the heartbeat kind constraint for `intake`, following `migrate.ts`'s existing table-rebuild pattern. The CHECK stays: dropping database validation is an optional architectural choice, not a simplification this feature needs, and TypeScript cannot validate direct DB writes. Preserve old rows; never edit an applied migration. Slot 26 is free as of 2026-09-20 (head is 25) — recheck immediately before merging. |
| Retry generations are integers; `reserveRetry` has no revision parameter. | Use revision-scoped operation names `intake:assess:<sourceRevision>` within the existing string-based `RetryOperation` contract. Retain `intake:assess` as the logical operation family. This avoids resetting an unrelated revision or adding retry storage solely for intake. |
| `reserveRetry` only increments a counter, so it cannot exclude a second supervisor; and the dispatcher and reviewer each run `reconcileAbandonedRetryReservations` with a 30-second grace over every `reserved` attempt regardless of operation, so an intake attempt left `reserved` across a provider call can be refunded and deleted mid-call. | Add a dedicated core op (`beginIntakeAssessment`) that in **one transaction** rechecks eligibility, refuses when an active (`reserved`/`running`) attempt exists for the revision, reserves, and moves the attempt to `running` before returning. Call the provider only after that commit. Settle before any backoff wait, so no reservation is held across a backoff. Define recovery for abandoned `running` attempts (Step 4.5) — without it a crash blocks the revision indefinitely. |
| Settings GET is human-only in §10, but board-mode intake must read settings every tick. | Keep human GET/PUT as specified and add a service-only intake runtime read containing normalized behavior settings and allowlisted assessment inputs, never provider secrets. |
| MCP filtering comments alone still exposes `Task.intake`. | Null the derived intake summary as well as stripping both intake marker families from worker payloads; audit list and other task-returning tools too. |
| Heartbeat health currently means recency only. It cannot represent an immediate auth failure while heartbeats continue. | **No heartbeat contract change.** On an authentication failure the supervisor cancels/refunds the reservation, logs one sanitized line and exits non-zero. The heartbeat stops, the existing recency check marks it down, the UI shows "paused". Accepted: "paused" appears only after the existing staleness interval, not instantly. `concurrently` keeps the other supervisors running. |
| `app_kv` writes do not change `getVersion()`. | **No settings poll.** The client that saves settings invalidates its own task queries. Documented limitation: other open clients keep the old policy colouring until their next refetch. Do not add KV writes to the board change signal. |
| Historical content at claim time is not reconstructible from the current task row alone. | Add a small internal claim-time intake context marker containing revision, stage, applicable assessment reference, and settings/policy version needed for attribution. Write it atomically with a new claim only when intake is enabled. Do not alter the existing claim activity body, which stores the worker label. Strip and reserve this marker like other intake markers. |
| Transient errors live in logs, so activity-only analytics cannot count every provider failure. | Derive attempt failures from durable retry rows, and assessment/override history from activity. Store only sanitized error-kind metadata in retry terminal reasons. Document retention limits rather than inventing historical failures. **Authentication failures are absent from durable analytics** — cancelling a reservation deletes the attempt row and the process exits; a process-local counter would not make reporting durable, so none is added. Document the gap. |
| §11 suggests logging raw invalid responses, conflicting with the secret-leak acceptance criterion. | Log structured error kind and sanitized diagnostics; never raw provider responses, request bodies, or headers. Use explicit fixture capture outside production logging when verifying the API. |
| §8 defines stale as "latest record's revision ≠ current", which is wrong after a revert (A → B → A shows A as stale and reassesses it). | Select the latest **valid** record matching the current revision; fall back to the latest historical record for stale display; stale wins over unavailable when the revision changed. Batch the full-history lookup for list mapping. |
| No defined behaviour for input larger than the provider accepts. | Add error kind `input_too_large`: publish `unavailable` immediately, consume no retries. Detect it both before sending (a deliberately pessimistic estimate against the documented limit — characters are not tokens, so the pre-check is never the only guard) and when the provider rejects the input. Never truncate material input. |
| `TaskDetail.activity` is the latest 50 rows; per-edit assessments, per-claim context markers and overrides would push human comments out. | Exclude the internal intake marker families **before** the activity limit is applied and expose their history through a separate read. Collapsing them in the UI is not sufficient — the window is cut server-side. |
| The spec treated a choice's confidence as derived and allowed a moving model alias. | Store the provider's own `confidence` separately from the distribution, the returned model id, and reported input/output tokens. Configure a pinned model version. Any value the provider does not report stays `null` — never synthesised. |

Also specify these small edge contracts in tests: `queued`, then `backlog`, then `in_progress` ordering; oldest `updated_at` and task ID as tie-breakers; stale takes precedence over unavailable if revision changed; arg-max ties use a documented deterministic choice; description assessments require exactly outcome/scope readiness parts and omit verifiability. Normalize strings by trim and CRLF-to-LF only, preserving meaningful internal whitespace. A question-set change alone does not trigger reassessment.

Plain service credentials currently identify workers and a reviewer/intake service at the same capability level. Reserving markers blocks generic comment forgery but does not isolate a dedicated assessment endpoint from another service-token holder. Document this advisory-mode trust boundary. Stronger writer authorization is a prerequisite for any enforcement proposal, not something the marker guard alone provides.

## 1. Domain schema, revision, policy, and settings — Stage 1

**Files:** create `packages/core/src/intake.ts`, `intakeSettings.ts`, and corresponding tests; update `types.ts` and public exports in `index.ts`.

1. Define discriminated assessed/unavailable records, provider metadata, readiness parts, complexity/risk distributions, typed error kinds, policy reasons, and the derived summary. Validate finite probabilities, sums within tolerance, arg-max consistency, timestamp/latency shape, and readiness equal to the minimum required parts. Unavailable records cannot carry decisions; assessed records cannot carry an error.
2. Implement marker detection, building, and defensive parsing using the failure-marker convention. Malformed stored markers remain raw text in the separate intake-history view; they never become actionable assessments or consume the normal activity window. Unknown future decision keys must not bypass validation of known decisions.
3. Implement `intakeRevision()` with deterministic key order and canonical string normalization. Test each material field independently, null versus empty plan semantics, and all excluded fields.
4. Implement pure policy with explicit stage context. Define stable weakest-part tie-breaking, independently switchable rules, and no policy result for unavailable/stale data. Use the explicit `readinessNeedsAttention` setting from the spec.
5. Normalize settings conservatively: missing/corrupt settings mean off and an empty opt-in list. Validate thresholds and positive bounded integers; reject `enforced` on write. Reject invalid explicit updates instead of silently enabling data egress.

**Proof:** focused schema/revision/policy/settings tests cover all source acceptance criteria 1, 2, and 4, including NaN, missing distributions, wrong stage parts, tied weakest parts, and architectural work at each stage. No network code in core.

## 2. Persist and derive assessments; protect worker payloads — Stage 1

**Files:** create `packages/core/src/ops/intake.ts`; update `repo/activity.ts`, `repo/tasks.ts`, `ops/addComment.ts`, `index.ts`, client type mirrors, and `packages/mcp/src/content.ts` plus other task-returning paths as needed.

1. Bind `recordIntakeAssessment` through core. Inside one transaction validate the payload, task key, current revision/stage, and workspace/mode eligibility. Recheck eligibility at publication so a task moved to a non-opted-in workspace or disabled feature cannot publish a stale in-flight result.
2. Make repeated publication for the same revision idempotent. Select by full marker history, not only the recent activity window. Reject edit-during-request results; preserve historical records. Ensure a revision already assessed before a later edit/revert is not needlessly assessed again.
3. Batch marker-history reads for list mapping; derive detail and list consistently using the selection rule above (latest valid record for the current revision, else latest historical record as stale). Policy uses current settings without rewriting records. When off or outside opted-in workspaces, expose `intake: null` while retaining history.
4. Reserve `intake/v1`, `intake-override/v1`, and the agreed internal claim-context marker in generic `addComment` for both actors. Dedicated validated operations remain the only writers.
5. Filter the three intake marker families out of `recentActivity` before `RECENT_ACTIVITY_LIMIT` is applied, and add a separate intake-history read (core op + `GET /api/tasks/:key/intake/history`). Test that twenty assessments do not displace a human comment.
6. Strip markers by prefix even when malformed and remove derived intake data from MCP outputs. Test real `get_task`, `get_next_task`, and any list serialization, including board-mode adapters.
7. Confirm activity publication changes `getVersion()` without updating task content timestamps merely for an assessment. Add metrics regressions proving comments do not add claims, rounds, or work duration.

**Proof:** current → stale → current, revert-to-assessed-revision is current with no reassessment, unavailable/stale precedence, off-mode behavior, concurrent duplicate publication, edit/disable/workspace-change races, marker spoof attempts, and worker payload filtering. Existing lifecycle and claims suites stay green.

## 3. HTTP contracts and advisory overrides — Stages 1–3 foundation

**Files:** `packages/core/src/httpCore.ts`, `index.ts`, `ops/intake.ts`; `packages/web/server/routes/agentOps.ts`, new `routes/intake.ts`, `routes/tasks.ts`, `app.ts`, and route schemas/tests.

1. Expose service-only runtime selection/read and validated assessment publication with local/HTTP parity. Return an explicit revision with each assessment input. Build provider input by allowlist; do not serialize an entire task detail.
2. Add human-only settings GET/PUT and `POST /api/tasks/:key/intake/override`; pin actors server-side and assert human authority in core. Never accept the caller's policy reasons as authoritative.
3. Bind overrides to an expected revision and evaluate current policy in the transaction. A material edit between notice and confirmation must refresh the notice rather than silently acknowledging new content.
4. For queueing over a flag, combine recording the acknowledgment and the queue mutation atomically in core, reusing existing transition validation. Preserve one-click advisory confirmation; API/service queue operations remain non-blocking and do not fabricate human overrides.
5. Include policy version and effective policy settings in override audit data so later threshold changes cannot rewrite what was acknowledged.

**Proof:** human/service authorization matrix; forged actors rejected; invalid JSON/distributions return normal typed errors; idempotent retries; queue failure leaves no false acknowledgment; revision mismatch refreshes confirmation. Transport parity tests use isolated databases.

## 4. Fixture-backed supervisor and durable retry lifecycle — Stage 2

**Files:** new `packages/intake/{package.json,tsconfig.json,vitest.config.ts,src/*,test/*,README.md}`; root `package.json`, lockfile, `tsconfig.json`, `vitest.workspace.ts`; core heartbeat/retry helpers and appended migration; server heartbeat schemas and supervisor configuration plumbing.

1. Scaffold from the watcher's injected-dependency loop, without Git-host or LLM-spawn behavior. Add config parsing for DB XOR board, poll timing, fixture/Jev provider wiring, timeout, and API-key environment-variable name. With no configured provider exit clearly; default/off combined-supervisor startup must leave existing processes usable.
2. Introduce `TaskIntakeDecisionProvider`, typed errors, question-set constants, allowlisted state construction, and a deterministic fixture provider. API-key resolution stays in the supervisor.
3. Add `intake` through core/server/client supervisor-kind contracts and config UI. Append the heartbeat migration (CHECK widened, not removed) and test upgrade preservation plus fresh DB setup. The heartbeat contract itself is unchanged. Board-mode startup performs `whoami`; plain service tokens remain sufficient under the documented advisory trust model.
4. Select only nonarchived code tasks in the three allowed statuses and opted-in workspaces. Apply settle window, current-revision history lookup, retry eligibility, priority ordering, and cap. Re-read settings every tick and immediately before outbound work. Abort in-flight work on disable/opt-out where practical; publication always rechecks it.
5. Implement `beginIntakeAssessment` in core: one transaction that rechecks mode/workspace/revision, returns `busy` when an active attempt exists for `intake:assess:<revision>`, reserves a slot and moves it to `running`. The provider call starts only after that commit. Use the shared attempt deadline and ownership checks specified in §11: request timeouts are limited to 120 seconds; recovery uses a fixed 150-second deadline from `reserved_at`, independent of the recovering supervisor's configuration. Expired attempts settle failed (`abandoned`) and count because a call may have happened. Reject late publication from an expired or replaced attempt. Persist successful settlement and the assessment together, storing the attempt ID in the marker to reconcile lost HTTP responses. Do not change dispatch/review retry semantics or the generic sweep. Carry the reservation identity through publication/settlement so a lost HTTP response can be reconciled without a second assessment.
6. Persist attempt timing/error kind sufficient for restart-safe backoff. Use bounded exponential backoff with injected clock/randomness, computed from settled attempts and applied between attempts — settle first, then wait. On auth failure cancel/refund the current reservation, log one sanitized line and exit non-zero. On `input_too_large`, cancel/refund and publish `unavailable` in one transaction; validated preflight rejection needs no reservation. Require a confirmed size diagnostic instead of treating every 422 as oversized input. Other terminal HTTP errors publish unavailable without retry, per §11. Transient and invalid-response failures consume intake attempts only.
7. On exhaustion, publish exactly one unavailable marker. Include exhausted-but-unpublished revisions in recovery selection: otherwise a crash between final failure and publication would hide the task forever. Edits create a fresh budget; restart alone does not.
8. Handle abort, timeout, shutdown, unexpected provider errors, and publication errors separately. Provider calls never run inside SQLite transactions. No provider outcome changes task status or creates `failure/v1`.

**Proof:** fake-clock selection/backoff tests; restart and concurrent-supervisor tests (one provider call per revision); a dispatcher/reviewer abandoned-reservation sweep fired during a provider call refunds nothing; abandoned `running` recovery unblocks the revision; every error kind including `input_too_large`; auth refund and non-zero exit; exhausted publication crash recovery; stale-response discard; no dispatcher attempt consumption; no duplicate calls while a reservation is active. Run the same representative scenarios in DB and board modes.

## 5. Verify and implement Jev — Stage 2 external dependency

**Files:** new `packages/intake/src/providers/jev.ts`, provider tests/fixtures, and provider setup documentation.

Start from the provider evidence recorded in NimBus spec 033 (endpoint, Bearer auth, multi-question request, Choice `probabilities` plus separate `confidence`, numeric Noul, echoed `model`, `usage` tokens, size budget, documented error statuses) and **re-verify it** — it was written for another feature and has not been certified from this repository. Verify the five API facts in spec §11 against current official documentation and a controlled request using synthetic task text: multi-question requests, full choice distributions, numeric Noul probability, returned model metadata, and limits/data handling. Record the exact endpoint, auth scheme, response examples, and verification date. No assumed API shape belongs in production code.

Implement one request per assessment with four questions for description and five for plan/implementation. Keep prompts/versioned criteria constant. Treat task text as data, explicitly map returned model, validate through core's schema, and classify timeout/auth/rate-limit/network/invalid-response/unavailable/input-too-large without leaking response bodies. Retry only documented HTTP statuses 429 and 529; transport timeout/network failures have a separate bounded retry policy. Do not implicitly retry arbitrary 5xx or other 4xx. Send the pinned configured model and persist the model the response reports, the provider `confidence`, and reported token usage — `null` where the provider is silent. Honor cancellation and documented size limits; do not silently truncate material input.

Use injectable fetch and recorded sanitized fixtures for success and malformed responses. If the provider lacks probabilities, document the limitation and seek a schema/calibration decision before proceeding; do not pretend synthetic one-hot values are measured confidence. Client-workspace opt-in remains blocked until retention/training behavior is established. `sendWorkspacePolicy` defaults to false.

**Proof:** fixture contract tests and one synthetic smoke request. A sentinel key and sentinel forbidden fields must be absent from DB contents, activity, captured logs, heartbeats, and HTTP responses. Assert the exact outbound field allowlist, including omission of URLs, workspace names, paths, comments, attachment bytes, and policy when disabled.

Additional retry proof: reject late results after attempt expiry/replacement; reconcile a committed result whose HTTP response was lost; test supervisors with different request timeouts; distinguish size-related 422 from other validation errors; and prove refund plus unavailable publication cannot be split by a crash.

## 6. Advisory UI and live settings — Stage 3

**Files:** `packages/web/client/src/{types.ts,api.ts,App.tsx}`; new intake panel/chip/settings components; `components/DetailPanel.tsx`, `TaskCard.tsx`, `TaskRow.tsx`, `SupervisorStrip.tsx`, existing queue actions, styles, and component tests.

Render all spec §12 states. Show raw probabilities and provider/time metadata; expand readiness parts and choice confidence; explain the weakest-part reason in plain language. Use an amber card chip only for current attention. Unavailable is muted, stale preserves prior values, and a stale supervisor heartbeat produces paused text rather than endless assessing (after an auth-failure exit this appears once the existing staleness interval elapses). The panel loads intake history on demand from the separate read. Hide intake outside enabled workspaces.

Add live settings with explicit workspace opt-in and no selectable enforced mode. Reuse the existing supervisor-health hook. Do not poll settings: invalidate task queries when this client saves settings so policy colors update without a new activity row; other open clients refresh on their next refetch (documented limitation). Add the advisory queue notice and revision-bound acknowledgment from Step 3. Keep ordinary queue flows and service-created tasks working as before.

**Proof:** component tests for every state and one-click queue confirmation/cancellation/race handling. Inspect rendered drawer, board card, settings, and narrow viewport with fixture data. Confirm keyboard access, readable percentages, and no failure styling for provider unavailability.

## 7. Outcome attribution and calibration — Stage 3

**Files:** `packages/core/src/ops/claimNextTask.ts`, intake marker helpers, `ops/analyticsRows.ts`, retry read helpers; server analytics contracts; client `views/AnalyticsView.tsx` and aggregation tests.

1. This is the last change in the delivery. Add the agreed claim-context marker atomically for enabled workspaces on new claims, not held-claim replay. Prove off-mode equivalence: with intake off, claim results, activity rows and claim ordering are identical to today's. Preserve worker labels and lifecycle semantics. Record revision/stage, current assessment identity or absence, and applicable policy snapshot. This is observational only.
2. Join assessments to the first claim per task/stage using that context and activity ordering. Never attribute an assessment obtained after claim as pre-claim coverage. Later task edits must not rewrite the cohort. Legacy rows lacking sufficient context are unknown/excluded with visible counts.
3. Expose daily assessment counts, latency p50/p95, failures by kind (from retry rows; label the view with the documented absence of auth failures), unavailable rate, coverage denominator/numerator, reassessments, and revision-bound overrides. Separate provider attempts from successfully published assessments.
4. Correlate readiness/parts with blocked transitions, review rounds, first-pass approval and skip-listing; complexity with tokens/work minutes/claims; risk with confirmed review findings and CI delivery failures. Compare description-stage readiness progression only within identifiable task/stage histories.
5. Partition by question set/provider and stage. Show decile sample sizes, completed-task counts, and explicit denominators; incomplete tasks do not count as failed outcomes. Do not blend unavailable/unknown assessments into zero readiness.

**Proof:** deterministic history fixtures covering edits before/after claim, assessments after claim, repeated claims, stage advancement, overrides, unavailable assessments, threshold changes, and missing legacy data. Existing analytics totals remain unchanged by new marker comments.

## 8. Final validation and rollout

Run focused suites after each step and the following integration checks for each PR, not only after PR C:

```powershell
npm run build
npm test
npm -w packages/web run typecheck:client
git diff --check
```

Use an isolated DB and fixture provider for end-to-end checks: default-off startup; explicit advisory opt-in; backlog assessment; queue with/without acknowledgment; claim unaffected by an attention flag; content edit/reassessment; description → plan → implementation; opt-out during a request; outage/auth/restart recovery; and UI/settings refresh. Exercise both DB and HTTP supervisor modes. Compare status changes, claim selection, attempt budgets, and core metrics against the same fixture with intake off.

Update setup docs and examples with migration ownership (board process), API-key environment setup, opt-in behavior, safe logging, and optional supervisor startup. Build before restarting long-lived consumers of compiled packages. Keep the runtime feature off until the operator explicitly opts in; implementation completion is not permission to transmit real task text.

Record actual commands, outcomes, and limitations when implementation is performed. This planning-only change does not claim build, test, API, or UI execution.

## Acceptance coverage and deferred enforcement

| Source acceptance criteria | Planned proof |
|---|---|
| 1–4: revision, validation, derived state, policy | Steps 1–2 unit and transactional tests |
| 5–7: worker filtering, marker guard, off behavior | Step 2 MCP/regression tests and Step 8 baseline comparison |
| 8–13: selection, provider, failures, secrecy, modes/health | Steps 4–5 supervisor, migration, transport, and sentinel tests |
| 14–16: panel/chip, override, settings | Steps 3 and 6 API/component tests and visual inspection |
| 17: operational analytics and calibration | Step 7 historical cohort tests and fixture analytics view |

Stage 4 requires a separate plan and approval after approximately 100 assessed-and-completed tasks demonstrate the specified monotonic relationship. That proposal must resolve authenticated assessment writers, first-queue/requeue/stage eligibility, bounded pending holds versus assessed attention holds, settings changes, and revision-bound overrides before adding `task_intake`, migrations, or SQL claim filtering. No enforcement work is implied by completing this plan.
