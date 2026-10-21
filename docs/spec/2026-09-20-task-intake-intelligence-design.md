# Task Intake Intelligence

**Status:** Draft v0.3 — refined against the codebase 2026-09-20, then corrected by the implementation-plan review the same day (§0.1); review corrections incorporated; ready for staged implementation, with provider verification gates in §11 and §15. This document does not enable data egress.
**Plan:** [implementation plan](../plan/2026-09-20-task-intake-intelligence-implementation.md)
**Initial decision provider:** TypeSafe Jev
**Supersedes:** Draft v0.1 (pasted product draft; its open decisions are resolved or narrowed in §15).

Assess a task's *specification* before an autonomous agent burns tokens on it, and persist the
judgment as structured data that policy, UI and analytics can consume.

---

## 0. Review of draft v0.1 — what changed and why

The v0.1 principles hold and are kept verbatim in spirit: atomic decisions instead of general
reasoning, deterministic policy owns every lifecycle effect, provider-neutral abstraction, advisory
first, measure before trusting. The refinements below come from checking the draft against how
AgentFactory actually works.

| # | v0.1 said | Problem | v0.2 |
|---|-----------|---------|------|
| 1 | Input is `title` + `description` | A task has `spec` **and** `acceptanceCriteria` (`types.ts: Task`). The draft names missing acceptance criteria as a core failure mode, then omits them from the input. | Input carries `spec`, `acceptanceCriteria`, `stage`, and `plan` when present (§4). |
| 2 | Readiness is one question | A task at the `description` stage is *supposed* to be under-specified — that stage writes the acceptance criteria (`createTask.ts` seeds "To be defined by the description stage."). A stage-blind readiness question scores every pipeline task as not ready. | Readiness is asked **per stage** (§5.1). Stage is part of the assessed revision, so a task is re-assessed as it walks the pipeline. |
| 3 | `attention_required` + reason "Task readiness is low" | Not actionable. The human learns nothing about *what* to fix, and "decisions, not reasoning" forbids asking for free-text rationale. | Readiness is decomposed into three atomic yes/no questions (outcome, scope, verifiability); the lowest one *is* the reason (§5.1). |
| 4 | Assess inline when the human clicks Queue (Option A / hybrid) | Core ops are synchronous `node:sqlite` transactions; a network call cannot live inside `updateStatus`. Tasks also enter the queue without the web UI (MCP `create_task`, ado-bridge/clawpatch producers, db-mode writers), so a web-route hook misses them. | Assessment is **asynchronous, by a poller** that finds tasks whose current revision has no assessment (§3). Same shape as the reviewer and watcher. |
| 5 | Not eligible → bounce `queued → backlog` | Needs a new agent edge in `TRANSITIONS`, fights producers that auto-queue, and cannot wait for a pending assessment. | Stage 4 gates the **claim**, not the transition — a held task stays `queued` but unclaimable, exactly like a task with unmet dependencies today (§9). No new lifecycle edge. |
| 6 | Persist assessment **and** policy result | Thresholds will change while data is collected; a persisted policy result goes wrong the moment they do. Conflicts with the repo convention that review/failure state is *derived* from the activity log. | Persist raw decisions only. Policy is a pure function evaluated at read time against current settings (§7, §8). |
| 7 | "Durable structured task artifact/event" (TBD) | — | An `intake/v1` marker comment in the activity log, the same convention as `ai-review/v1`, `failure/v1`, `feedback-eval/v1`, `restart/v1`. No persistence migration for Stages 1–3 (v0.3: one unrelated heartbeat migration, §0.1); `getVersion()` picks it up for free (§8). |
| 8 | `readiness.value` (§6.1) vs `readiness.probability` (§8) | Inconsistent. | `probability` everywhere. |
| 9 | `confidence` next to `probabilities` | Redundant unless the provider reports an independent confidence. | v0.3: the provider's own `confidence` is stored as reported, `null` when absent (§0.1, §6). |
| 10 | Input includes `workspace.description`, `attachments[].description` | Neither field exists. Attachments are images only (`ATTACHMENT_MIMES`). | Dropped. Attachments contribute a count only (§4). |
| 11 | Nothing on data egress | Task specs leave the machine for a third-party API. The working board holds client workspaces. | Per-workspace opt-in; workspace name and link URLs are never sent (§4, §10). |
| 12 | Scope: all tasks, all queue entries | `pr-review` tasks never queue. Re-queues after review/delivery bounce are not intake. | Only `kind = 'code'`; only pre-execution statuses (§3). |
| 13 | Nothing on worker visibility | MCP strips uncurated AI verdicts from claim payloads so they cannot anchor the implementing agent (`mcp/src/content.ts`). | `intake/v1` comments are stripped the same way (§8). |
| 14 | Nothing on edit churn / cost | Assessing on every save of a draft burns provider calls. | Settle window + per-tick cap + the existing durable retry budget (§3, §11). |
| 15 | Fail open vs fail closed (TBD) | A false dichotomy once the gate is at claim time. | Bounded hold: wait up to `maxHoldMinutes` for an assessment, then fail open (§9). |

### 0.1 Corrections from the implementation-plan review (v0.3)

v0.2 made claims the code does not support. Each is corrected in place; this table is the index.

| v0.2 said | Actually | Corrected in |
|-----------|----------|--------------|
| No migration through Stage 3 | `supervisor_heartbeat.kind` has a SQL `CHECK`; a new supervisor kind needs a table rebuild | §2, §8, §14 — one Stage 2 migration that **widens** the CHECK (kept, not dropped: TypeScript cannot validate direct DB writes) |
| Retry budget "generation keyed to the revision" | Generations are integers; `reserveRetry` takes no revision and does not exclude concurrent reservations; dispatcher and reviewer sweep *every* `reserved` attempt older than 30 s, whatever its operation | §11 — dedicated `beginIntakeAssessment` op, operation `intake:assess:<revision>` |
| Stale = latest record's revision differs from current | Wrong after a revert (A → B → A would show A as stale and reassess it) | §8 |
| `evaluateIntakePolicy(assessment, settings)` | Rule 2 depends on stage, which was in neither argument | §6, §7 |
| MCP strips intake comments | The derived `Task.intake` would still reach the worker | §8 |
| `confidence` is derived from the distribution | Jev reports a Choice `confidence` separately from `probabilities` | §6 |
| Six error kinds | No defined behaviour for input larger than the provider accepts | §6, §11 |
| Raw invalid responses go to the supervisor log | Conflicts with the no-secret-leak criterion | §11 |
| `auth` marks the heartbeat unhealthy | Heartbeat health is recency only | §11, §12 — the supervisor exits non-zero instead |
| Settings GET is human-only | A board-mode supervisor must read behaviour settings each tick | §10 |
| Settings edits refresh the UI | `app_kv` writes do not move `getVersion()` | §10 |
| Analytics joins "the assessment current at first claim" | Task content at claim time is not reconstructible from the task row | §13 — `intake-claim/v1` context marker |
| Everything derives from the activity log | Transient provider failures never reach it | §13 |
| Intake markers live in the activity log like the others | `TaskDetail.activity` is the latest 50 rows; per-edit assessments would push human comments out | §8 |

---

## 1. Objective and principles

Evaluate whether a task is suitable for autonomous execution **before** a coding agent claims it,
by asking a provider a small number of narrow semantic questions. The component never executes,
rewrites, or moves tasks.

```text
Task content ──► Decision provider ──► intake/v1 assessment (persisted, raw)
                                              │
                        current settings ──►  TaskIntakePolicy (pure, core)
                                              │
                                   UI signal · claim gate (Stage 4) · analytics
```

1. **Decisions, not reasoning.** The provider answers atomic questions. It is never asked
   "should this task run?".
2. **Policy is deterministic and lives in core.** The provider cannot change task state. Policy is
   a pure function over `(assessment, settings)`.
3. **Provider-neutral.** Core knows the `intake/v1` schema and nothing about Jev. No provider
   response shape crosses the provider boundary.
4. **Infrastructure failure ≠ task failure.** A provider outage never produces a `failure/v1`
   note, never consumes a dispatcher attempt, and never blocks work for longer than a bounded hold.
5. **Earn trust with data.** Ship advisory, correlate with real outcomes, then decide on
   enforcement.

---

## 2. Packaging

| Piece | Location | Notes |
|-------|----------|-------|
| `IntakeAssessmentV1` types, marker build/parse, `intakeRevision()`, `evaluateIntakePolicy()`, intake settings, `recordIntakeAssessment` op, derived `Task.intake` | `packages/core` (`src/intake.ts`, `src/intakeSettings.ts`, `src/ops/intake.ts`) | The only DB toucher, as always. No network code. |
| `TaskIntakeDecisionProvider` interface, `JevTaskIntakeDecisionProvider`, fixture provider, poll loop | **new** `packages/intake` supervisor | Plain HTTP, no LLM spawn — the watcher's shape. `db` XOR `board` config via `boardConfig.ts`; heartbeat → health view. `SupervisorKind` gains `'intake'`, which needs the Stage 2 migration widening `supervisor_heartbeat.kind`'s CHECK (the data-driven table rebuild `migrate.ts` already used for the watcher; slot 26 is free as of 2026-09-20 — recheck before merging). |
| Strip `intake/v1` from claim payloads | `packages/mcp/src/content.ts` | One predicate added to the existing filter. |
| "Task Intelligence" drawer panel, board-card chip, settings modal section | `packages/web` | Client mirrors marker keys (cannot import core at runtime — existing constraint). |

**Why a supervisor and not the web server.** The provider call must sit outside core
transactions, must cover tasks created by any writer (MCP, producers, db-mode), and should keep the
API key off remote worker machines. A poller over DB state satisfies all three and gets health
reporting, board mode and the supervisors config UI for free. The cost is a fourth process; it
joins `npm run supervisors`. Rejected alternative: a background loop inside `:8787` — fewer
processes, but it puts the first outbound third-party call into the board process and breaks the
"board owns state, supervisors do external work" split.

**Jev is optional configuration, not a plugin.** With no provider configured the supervisor exits
at startup with a clear message; with the feature `off` nothing anywhere changes.

---

## 3. Trigger and scope

**Trigger: asynchronous assess-on-change** (v0.1's Option B, made robust).

Each tick the intake supervisor selects tasks where **all** hold:

- `kind = 'code'`, not archived;
- status ∈ `backlog`, `queued`, `in_progress` (`in_progress` only so a task claimed within one poll
  interval still gets an assessment for analytics — it has no gating effect there);
- the workspace is opted in (§10);
- no `intake/v1` record exists for the task's **current** `intakeRevision` (§6);
- `updated_at` is older than `settleSeconds` (default 60) — drafts being edited are left alone;
- the `intake:assess` retry budget for this revision is not exhausted (§11).

It assesses at most `maxPerTick` (default 5) tasks per tick, oldest `updated_at` first, `queued`
before `backlog`.

Consequences:

- A task assessed in backlog is already current when the human queues it — zero added latency.
- A producer that creates-and-queues in one motion is assessed within one poll interval.
- A pipeline task is re-assessed when the `description` stage rewrites the spec and again when the
  `plan` stage lands, because `stage`, `spec`, `acceptanceCriteria` and `plan` are all in the
  revision. Those later assessments see progressively better input — which is itself a useful
  analytics signal (did the description stage raise readiness?).
- Re-queues (`in_review → queued`, `delivering → queued`, reopen) are re-assessed only if content
  changed. Reviewer feedback does not alter the revision.

---

## 4. Assessment input

```typescript
interface TaskIntakeState {
  key: string;                       // e.g. "AF-151" — opaque correlation id
  title: string;
  spec: string;
  acceptanceCriteria: string;        // may be the description-stage placeholder
  stage: Stage;                      // 'description' | 'plan' | 'implementation'
  plan: string | null;               // present once the plan stage has submitted
  links: { kind: LinkKind; label: string }[];   // URLs deliberately omitted
  attachmentCount: number;           // images only today; content is never sent
  workspacePolicy: string | null;    // the free-text engineering standards, if the workspace opts in to sending them
}
```

Never sent: repository contents, git history, source files, other tasks, activity/comments,
workspace name or repo path, link URLs, attachment bytes, tokens, PATs, environment variables.

Intake evaluates the **specification**, not the implementation. Repository-aware assessment is a
separate later feature.

---

## 5. Decisions (question set `intake-questions/v1`)

The question texts, including the per-value criteria below, are constants in the provider
package, versioned as a set. Every assessment records the question-set version so analytics never
mixes answers to different questions.

### 5.1 Readiness — three yes/no probabilities (Jev primitive: `Noul`)

| Key | Question (stage-aware preamble prepended) |
|-----|-------------------------------------------|
| `outcomeClear` | Is the requested outcome — what should be true when the work is finished — stated clearly enough that two engineers would describe the same result? |
| `scopeBounded` | Is the scope bounded — is it clear what is and is not part of this task? |
| `verifiable` | Could a reviewer decide from the acceptance criteria alone whether the work is complete? |

Stage-aware preamble:

- `implementation` — "An autonomous coding agent will implement this now, without asking a human."
- `plan` — "An autonomous agent will write an implementation plan for this now."
- `description` — "An autonomous agent will rewrite this into a full specification and write the
  acceptance criteria. Judge whether the *intent* is sufficient for that." `verifiable` is **not
  asked** at this stage (the stage's job is to make it true).

`readiness.probability = min(asked sub-probabilities)`. The weakest sub-question supplies the
policy reason ("acceptance criteria are not verifiable"), which is what makes
`attention_required` actionable without any free-text reasoning from the provider.

### 5.2 Complexity — one choice (Jev primitive: `Choice`)

| Value | Criteria sent in the question |
|-------|-------------------------------|
| `trivial` | Highly localized, mechanical change |
| `small` | Limited implementation, ordinary coding work |
| `medium` | Multiple components or meaningful reasoning |
| `large` | Broad change across several areas, or substantial investigation |
| `architectural` | Significant design decisions are needed before normal implementation |

### 5.3 Risk — one choice (`Choice`)

Impact **if the implementation is wrong** — independent of complexity (a one-line authorization
change is `small` / `high`).

| Value | Criteria sent in the question |
|-------|-------------------------------|
| `low` | Limited, local impact; easily reversible |
| `medium` | Could affect normal functionality; recovery is straightforward |
| `high` | Could affect important data, integrations, security, availability or many users |
| `critical` | Severe security, data-integrity, regulatory or production consequences |

### 5.4 Deferred dimensions

`taskType` and `securitySensitive` are **out of v1**. Risk already absorbs security impact, and
neither has a consumer yet. The schema's `decisions` object is open (§6), so they can be added as a
new question-set version without a schema bump. Deterministic risk floors ("touches auth ⇒ min
high") are likewise deferred until there is deterministic input to key them on.

---

## 6. Persisted schema — `intake/v1`

```typescript
interface IntakeAssessmentV1 {
  schema: 'intake/v1';
  status: 'assessed' | 'unavailable';
  taskKey: string;
  sourceRevision: string;            // intakeRevision() of the content that was assessed
  attemptId: string | null;           // reservation id; null only for validated preflight rejection
  stage: Stage;                      // the stage that was assessed; validated against the task on write
  questionSet: string;               // 'intake-questions/v1'
  provider: { name: string; model: string | null };   // model as RETURNED by the provider, never the configured alias
  usage: { inputTokens: number | null; outputTokens: number | null };  // as reported; null when the provider is silent
  assessedAt: string;                // ISO
  latencyMs: number;

  // status === 'assessed'
  decisions?: {
    readiness: {
      probability: number;                                   // min of the parts
      parts: Partial<Record<'outcomeClear' | 'scopeBounded' | 'verifiable', number>>;
    };
    complexity: { value: Complexity; probabilities: Record<Complexity, number>; confidence: number | null };
    risk:       { value: Risk;       probabilities: Record<Risk, number>;       confidence: number | null };
  };

  // status === 'unavailable' — retry budget exhausted for this revision, or the input cannot be sent at all
  error?: { kind: 'timeout' | 'rate_limit' | 'network' | 'invalid_response' | 'unavailable' | 'input_too_large'; detail: string };
}
```

- `confidence` is the **provider's own** confidence for a choice, stored as reported and `null`
  when the provider reports none. It is not the top probability (Jev reports the two separately);
  the UI shows `probabilities[value]` and offers `confidence` in the expanded view. A missing
  provider value stays `null` everywhere — it is never synthesised.
- `auth` is not an error kind a record can carry: an authentication failure is the supervisor's
  problem, not a property of a task revision (§11).
- Validation (zod, in core): probabilities and non-null confidence in `[0,1]`; reported token
  counts are nonnegative integers or null; choice distributions sum to 1 ± 0.02;
  `value` is the arg-max (ties resolve to the first option in declaration order); readiness equals
  the minimum of exactly the parts required for `stage`. A record failing validation is rejected by `recordIntakeAssessment` —
  malformed provider output must never render as a confident assessment.
- `error.detail` is a sanitized one-liner. No headers, no request bodies, no credentials.

### Revision

```text
intakeRevision(task) = sha256( canonicalJSON({ title, spec, acceptanceCriteria, stage, plan }) )
                       with strings trimmed and CRLF → LF
```

Computed in core (`node:crypto`). Links, attachments, priority, workspace and status are *not*
material — changing them does not stale an assessment. The question set is deliberately not part
of the revision: shipping new questions must not trigger a mass re-assessment; analytics
partitions by `questionSet` instead.

`recordIntakeAssessment(key, assessment)` recomputes the task's current revision and stage inside
its transaction and **rejects a record whose `sourceRevision` or `stage` no longer matches**, and
one whose workspace was opted out or whose mode went `off` while the call was in flight. Publishing
the same revision twice is idempotent. The edit-during-assessment
race therefore resolves itself on the next tick.

---

## 7. Policy

```typescript
// core, pure
function evaluateIntakePolicy(a: IntakeAssessmentV1, stage: Stage, s: IntakeSettings): IntakePolicyResult;

interface IntakePolicyResult {
  policyVersion: 'intake-policy/v1';
  eligibility: 'eligible' | 'attention_required';
  reasons: IntakeReason[];   // { code: 'readiness_low' | 'outcome_unclear' | 'scope_unbounded' | 'not_verifiable' | 'architectural' | 'risk_at_or_above', message }
}
```

Default rules (each individually switchable in settings):

1. `readiness.probability < readinessThreshold` → `attention_required`, reason from the weakest part
   (ties: `outcomeClear`, then `scopeBounded`, then `verifiable`). Switched by its own
   `readinessNeedsAttention` setting, not by a magic threshold value.
2. `complexity.value === 'architectural'` **and** `stage === 'implementation'` → `attention_required`
   (architectural work belongs in the description/plan pipeline, where a human approves each stage).
3. `risk.value ≥ riskAttentionLevel` (default: off) → `attention_required`.

Policy is evaluated at read time — in `toDetail`/list mapping for the UI, and in the claim path in
Stage 4. It is **not** persisted with the assessment. What *is* recorded is the policy outcome at
the moments it had an effect (hold, release, override — §9), so analytics can reconstruct what
the human actually saw.

**Thresholds in v1:** present in settings, used only to colour the UI signal, shipped with a
deliberately provisional `readinessThreshold = 0.6`. Nobody knows yet whether Jev's probabilities
are calibrated; §12 exists to find out. Raw probabilities are always displayed.

---

## 8. Persistence and derived state

**Storage: an agent-actor comment in the activity log** whose body starts with the marker, a
one-line human summary, then fenced JSON — the `failure/v1` format exactly:

````text
intake/v1 — ready 91% · medium · low risk (jev)

```json
{ "schema": "intake/v1", ... }
```
````

- No migration for persistence. History is retained for free (every revision's assessment stays
  in the log). The only migration in Stages 1–3 is the heartbeat-kind widening (§2).
- `getVersion()` already folds in activity → the UI refreshes when an assessment lands.
- Core gains `isIntakeMarker` / `buildIntakeComment` / `parseIntakeComment` in `src/intake.ts`.
  A malformed marker has no policy effect. Preserve its raw text in the separate intake-history
  view; reserved prefixes remain excluded from the normal activity window.
- **Three reserved marker families:** `intake/v1` (assessment), `intake-override/v1` (human
  acknowledgment, §9) and `intake-claim/v1` (claim-time context, §13).
- `addComment` must refuse a body starting with any of them, for both actors — only the dedicated
  ops write them. This is a **new** guard: `addComment` has no marker checks today (the existing markers are
  trusted by convention). It matters here because Stage 4 lets this marker hold a task, so a
  worker must not be able to forge one. `intake-override/v1` is likewise writable only by the
  human-only `overrideIntake` op.
- **Intake markers are excluded before the activity window is applied.** `TaskDetail.activity`
  is the latest `RECENT_ACTIVITY_LIMIT` (50) rows; a task edited twenty times in backlog would
  otherwise lose its human comments to assessment rows. `recentActivity` filters the three
  families out, and their history is exposed separately (`GET /api/tasks/:key/intake/history`,
  fetched on demand by the panel). Collapsing them in the UI would not be enough — the window is
  cut server-side.
- **MCP strips all three marker families by prefix (even when malformed) and nulls the derived
  `Task.intake`** on every task-returning tool (`get_task`, `get_next_task`, `list_tasks`), in
  both db and board mode. A worker
  told "risk: critical, readiness 41%" is being anchored by an uncurated machine judgment — the
  same reason `ai-review/v1` is stripped.
- Metrics: the stage walk (`metrics.ts`) keys on `status_change`/`result` rows; confirm during
  implementation that an extra agent comment does not perturb `rounds`/`claimCount`, and add a
  regression test.

**Derived at read time** (no column), alongside `aiReview` and `failure`:

```typescript
interface IntakeSummary {
  state: 'current' | 'stale' | 'unavailable';
  assessment: IntakeAssessmentV1;               // see selection rule below
  policy: IntakePolicyResult | null;            // null unless state === 'current' && status === 'assessed'
  overridden: boolean;                          // a current intake-override/v1 exists for this revision
}
// Task.intake: IntakeSummary | null            // null = never assessed
```

Record selection, batched across tasks for list mapping (full marker history, not the 50-row
window):

1. the latest **valid** record whose `sourceRevision` equals the task's current revision →
   `current` (or `unavailable` if that record's status is). A revert A → B → A therefore shows A's
   existing assessment and is not assessed again;
2. otherwise the latest valid record of any revision → `stale`, shown greyed. Stale wins over
   unavailable when the revision has changed;
3. otherwise `null`.

When the mode is `off` or the workspace is not opted in, `Task.intake` is `null` while the history
stays in the log.

"Assessing…" is a client-side inference: `intake === null || state === 'stale'`, feature enabled
for the workspace, and the intake supervisor healthy. Supervisor down ⇒ "Assessment paused".

> **Stage 4 note.** A claim gate has to exclude held tasks inside `oldestQueuedRow`'s SQL.
> Parsing comment JSON in SQL is not acceptable, so Stage 4 will add a small current-state table
> (`task_intake`: task_id, source_revision, eligibility inputs, hold timestamps — the
> `task_delivery` pattern) via a new appended migration, written by `recordIntakeAssessment` in
> the same transaction as the comment. The activity log stays the history of record. This is
> deliberately **not** built before enforcement is approved.

---

## 9. Queue interaction

### Stages 1–3 (advisory) — no lifecycle effect

`backlog → queued` behaves exactly as today. The Queue action in the UI shows a non-blocking
inline notice when `policy.eligibility === 'attention_required'` ("Intake flags: acceptance
criteria are not verifiable — queue anyway?"). One click proceeds. Queueing over a flag is
recorded (below) because override frequency is a primary success metric.

### Stage 4 (enforced, later, separately approved) — gate the claim

```text
queued task
   │
   ├─ current assessment, eligible ............................ claimable
   ├─ current assessment, attention_required, not overridden .. HELD (stays queued)
   ├─ no current assessment, waiting < maxHoldMinutes ......... HELD (pending)
   └─ no current assessment, waiting ≥ maxHoldMinutes ......... claimable (fail open) + one hold-expired note
```

- A held task is `queued` but skipped by `claimNextTask`, the same mechanism as
  `unmetDependencyCount > 0`. The board shows it in the queue column with a "Held by intake" chip
  and the reasons. **No new `TRANSITIONS` edge**, no bounce, producers unaffected.
- The dispatcher never burns an attempt on a held task, and a provider outage delays work by at
  most `maxHoldMinutes` (default 10) — this replaces the fail-open/fail-closed question.
- Only the description-stage and implementation-stage *first* queue entry are gated. Re-queues
  after a review send-back, a delivery bounce, or an auto-approved doc stage whose content did not
  change keep their existing assessment and are not re-held by a pending state.

### Override (human-only)

`POST /api/tasks/:key/intake/override { reason? }` → core `overrideIntake` writes a **human**
comment:

```text
intake-override/v1 — queued despite: acceptance criteria are not verifiable
{ "sourceRevision": "…", "policyVersion": "intake-policy/v1", "reasons": ["not_verifiable"], "reason": "spike, AC irrelevant" }
```

The request carries the revision the human was shown; core re-evaluates policy inside the
transaction and rejects a mismatch, so an edit between notice and click refreshes the notice
instead of acknowledging unseen content. Caller-supplied reasons are never authoritative — the
record stores core's own reasons plus the effective policy settings, so a later threshold change
cannot rewrite what was acknowledged. Queueing over a flag is one core op
(`queueWithIntakeAcknowledgment`): the acknowledgment and the `backlog → queued` move commit
together or not at all. Service/API queue operations stay non-blocking and never fabricate a human
override.

An override is bound to `sourceRevision`: a material edit produces a new revision, a new
assessment, and — if still flagged — needs a new override. Agents can never override
(`rejectService` on the route, human actor asserted in core). In advisory mode the same record is
written when a human queues over a flag, so the metric exists before enforcement does.

---

## 10. Configuration

Split along the existing line: **secrets and wiring in the file, behaviour on the board.**

`intake.config.json` (file-only, like the other supervisors):

```jsonc
{
  "db": "./agentfactory.db",            // XOR "board": { "url", "tokenEnv" }   (plain service token is sufficient)
  "pollSeconds": 30,
  "provider": {
    "name": "jev",
    "endpoint": "https://…",            // verify against Jev docs
    "apiKeyEnv": "TYPESAFE_API_KEY",    // env var NAME; the key itself is never in a file, the DB, a log, or an API response
    "model": "jev-1.13.0",              // a PINNED version, never a moving alias — an alias would silently change stored results
    "timeoutSeconds": 20               // range 1–120; core attempt deadline is 150 seconds
  }
}
```

Board settings (`app_kv` key `intake_settings`, normalized like `engineSettings.ts`; editable
live in the UI, read by core and by the supervisor each tick — no restart):

```jsonc
{
  "mode": "off",                         // 'off' | 'advisory' | 'enforced'   (default off; 'enforced' rejected until Stage 4 ships)
  "workspaces": [],                      // OPT-IN list of workspace slugs. Empty = nothing is sent anywhere.
  "sendWorkspacePolicy": false,
  "settleSeconds": 60,
  "maxPerTick": 5,
  "maxAttempts": 3,
  "readinessNeedsAttention": true,
  "readinessThreshold": 0.6,
  "architecturalNeedsAttention": true,
  "riskAttentionLevel": null,            // null | 'high' | 'critical'
  "maxHoldMinutes": 10                   // Stage 4
}
```

**Workspaces are opt-in here, unlike the other supervisors (which are opt-out).** Intake is the
only component that sends task text to a third party, and this board carries client workspaces.
Serving a new workspace must be a deliberate act.

`GET/PUT /api/intake-settings` are human-only. A board-mode supervisor reads behaviour through a
separate **service-only** runtime read under `/api/agent` that returns the normalized settings and
the allowlisted assessment inputs — never provider wiring. Missing or corrupt settings normalize
to `off` with an empty workspace list; an invalid explicit update is rejected rather than
half-applied, so a typo can never enable data egress.

Settings live in `app_kv`, which does not move `getVersion()`. The client that saves settings
invalidates its own task queries so policy colours update at once. **Accepted limitation:** other
open clients keep the old colouring until their next refetch. No settings poll is added for this.

**Trust boundary (advisory mode).** A plain service token is enough to publish an assessment, and
workers hold one too. Reserving the markers blocks forgery through `add_comment`, but does not stop
a service-token holder calling the assessment op directly. That is acceptable while assessments
are advisory. Authenticated assessment writers are a precondition of any Stage 4 proposal.

---

## 11. Provider

```typescript
// packages/intake
interface TaskIntakeDecisionProvider {
  readonly name: string;
  assess(state: TaskIntakeState, signal: AbortSignal): Promise<{
    decisions: IntakeDecisions;
    model: string | null;
    usage: { inputTokens: number | null; outputTokens: number | null };
  }>;
}
```

- `JevTaskIntakeDecisionProvider` sends **one request**: one state, all questions for the task's
  stage (4–5 questions). It maps the response into `IntakeDecisions`; nothing Jev-shaped escapes
  the class. Injectable `fetch` for tests (the `createHttpCore` pattern).
- `FixtureTaskIntakeDecisionProvider` returns canned decisions keyed by task title — the provider-independent
  test provider, and the e2e harness's permanent one.
- Typed `IntakeProviderError { kind }` for the record error kinds in §6 plus `auth`, which never reaches a record (§11 failure table).

**Provider evidence.** NimBus spec 033 (`docs/spec/033-integration-intelligence-failure-classification`,
NimBus repo) records a verification against https://docs.typesafe.ai/api.md dated 2026-09-19:
`POST https://api.typesafe.ai/v1/systemone` with a Bearer key, a `questions` map evaluated in one
request, Choice answers carrying `choice` + `probabilities` + a separate `confidence`, Noul
answers carrying only a probability, the response echoing `model` and `usage` token counts, a
64k-token request budget with about 32k for state, and 401/422/429/529 as documented errors.
The local NimBus spec's provider section was inspected during this revision. Treat it as a
**starting point to re-verify, not current API certification**: it describes another feature. Stage 2 re-verifies each item
against the current documentation and one controlled request with synthetic task text, and records
endpoint, auth scheme, sanitized response examples and the date.

**To re-verify before Stage 2:**

1. A single request can carry one state and several independent questions.
2. `Choice` returns a full probability distribution, not just the winning label.
3. `Noul` returns a probability rather than a boolean.
4. The response reports the model that actually answered and token usage; store only returned metadata.
5. Rate limits, max state size (long specs + plans), and whether task text is retained or used
   for training — the last one gates enabling it for client workspaces at all.

If (2) or (3) fails, stop and take a schema/calibration decision — do not ship synthetic one-hot
distributions as if they were measured confidence.

### Reservation and concurrency

The generic retry primitives are not enough on their own: `reserveRetry` only increments a counter
(two supervisors would both get a slot), and the dispatcher and reviewer each run
`reconcileAbandonedRetryReservations` with a 30-second grace over **every** `reserved` attempt
regardless of operation — so an intake reservation left in `reserved` across a provider call can
be refunded and deleted while the call is still in flight.

`beginIntakeAssessment(key, revision)` is therefore one dedicated core transaction that, in order:
rechecks mode / workspace / revision; returns `busy` if an active (`reserved` or `running`)
attempt already exists for `intake:assess:<revision>`; reserves a slot; and **moves it to
`running` before returning**. The provider call happens only after that commit, never inside a
SQLite transaction. The reservation id travels through publication and settlement, so a lost HTTP
response is reconciled instead of causing a second assessment. Backoff is computed from settled
attempts' timestamps and applied *between* attempts — an attempt is settled before any wait, so
no reservation is held across a backoff.

**Abandoned `running` attempts and ownership.** Bound configured provider timeouts to 1–120
seconds. Every intake attempt has the same core-owned deadline: `reserved_at` + 150 seconds
(the maximum request timeout plus a 30-second publication margin). Recovery never uses the
recovering supervisor's local timeout. A tick atomically settles an expired active intake attempt
as failed with reason `abandoned`; it counts because a provider call may have happened. This
reuses existing timestamps and needs no retry-table migration.

Before reserving, the begin transaction also checks for an existing assessment, deadline expiry,
and backoff. Provider-result publication and settlement require the matching active attempt ID and an unexpired
deadline; an expired/replaced owner cannot publish or settle its successor. Successful publication
and successful settlement commit together. Persist `attemptId` with the assessment so retries
following a lost HTTP response return the committed result. A client receiving a delayed begin
response checks the returned deadline before sending; it must not start expired work. Cancellation
cannot guarantee a provider stops processing a request, so the guarantee is exclusive local
ownership and publication, not exactly-once execution at the provider.

Recovery also publishes one unavailable record for an exhausted-but-unpublished current revision,
including a crash between final failure and publication. This dedicated recovery transaction
rechecks current revision, eligibility, exhaustion and absence of an existing record; it uses the
last failed attempt ID and does not require that failed attempt to remain active. Preflight
size rejection is the other explicit publication path without an active attempt. Map `abandoned` to assessment error
`unavailable`; keep `abandoned` as the internal retry diagnostic. Material edits start a fresh
budget; restart alone does not. Test expiry, late results, mixed supervisor timeouts and lost
responses as well as concurrent reserve and dispatcher-sweep cases.

### Failure handling

| Event | Behaviour |
|-------|-----------|
| Transport failure (`timeout`, `network`) — no HTTP response | Settle the attempt `failed` with the sanitized kind as `terminal_reason`; retry on a later tick with bounded exponential backoff. Nothing written to the task. |
| Retryable HTTP response (429 → `rate_limit`, 529 → `unavailable`) | Same, kept distinct from transport failures in the recorded kind. Only these documented HTTP statuses are retried; do not implicitly retry arbitrary 5xx or other 4xx. |
| `invalid_response` | Counts as an attempt. Log the error kind and sanitized diagnostics only — **never** the raw response, request body or headers, in any log. Fixture capture for API verification is an explicit, separate, non-production path. |
| `input_too_large` | Detected **before sending** against the provider's documented limit using a conservative estimate (characters are not tokens — the pre-check is deliberately pessimistic and is not the only guard), **and** when a validated provider error specifically identifies oversized input (not every 422). Preflight rejection publishes without reserving; after a call, publish `unavailable` and cancel/refund atomically. Consume no retries. Material input is never silently truncated. An edit creates a new revision and a new attempt. |
| Other terminal HTTP response (including non-size 422 and undocumented 5xx) | Publish `unavailable` with error kind `unavailable` and settle the attempt failed in the same transaction; do not retry this revision. Sanitize diagnostics. Revisit this mapping only if API re-verification documents another retryable status. |
| Authentication failure (401/403) | Cancel/refund the reservation (not the task's fault), log one sanitized line, and **exit non-zero**. The heartbeat stops, the existing recency check marks the supervisor down, and the UI shows "Assessment paused". **Accepted:** "paused" appears only after the normal staleness interval, not instantly; `concurrently` leaves the other supervisors running. No heartbeat contract change. |
| Budget exhausted for a revision | Exactly one `intake/v1` record with `status: 'unavailable'`. UI shows "Assessment unavailable". A material edit starts a new revision with a fresh budget. |

None of these produce `failure/v1`, touch the dispatcher's attempt budget, or change task status.

---

## 12. UI

Drawer panel, below the description, collapsed to one line by default:

```text
Task Intelligence                                    jev · 2m ago
Ready 91% · Medium (67%) · Low risk (92%)

▸ Outcome clear 97% · Scope bounded 91% · Verifiable 93%
```

| State | Rendering |
|-------|-----------|
| current, eligible | as above, neutral |
| current, attention | amber; reasons listed in plain language, weakest readiness part highlighted |
| stale | previous values greyed + "Task changed since assessment — reassessing…" |
| never assessed, enabled | "Assessing…" |
| unavailable | "Assessment unavailable" — muted, **not** styled as a failure, never the red failure chip |
| supervisor heartbeat stale | "Assessment paused — intake supervisor is not running". Appears after the existing staleness interval, including after an auth-failure exit |
| feature off / workspace not opted in | panel absent |

Board card: a small chip only when `attention_required` (or "Held by intake" in Stage 4). Eligible
tasks get no chip — the board is dense enough.

---

## 13. Observability

Assessments, overrides and claim context derive from the activity log (`analyticsRows.ts`
pattern). Provider **attempts and failures by kind derive from the durable retry rows**
(`terminal_reason`), because transient failures never reach the activity log. Two documented
gaps: retry rows share the retry tables' retention, so failure history is only as old as they are;
and **authentication failures are absent from durable analytics** — the reservation is cancelled,
which deletes the attempt row, and the process exits. A process-local counter would not fix
durable reporting, so none is added; an auth outage shows up as a coverage gap and a stale
heartbeat.

**Claim-time context.** Task content at claim time cannot be reconstructed from the task row, so
a new claim in an enabled workspace writes an `intake-claim/v1` marker in the same transaction:
revision, stage, the id of the applicable assessment (or none), and the policy version + effective
settings. It is observational only, never written on held-claim replay, never alters the claim
activity body (which carries the worker label), and is absent when intake is off. This is the one
place the feature touches `claimNextTask`; it ships last, with a test proving claim results are
identical with intake off.

Operational: assessments per day, latency p50/p95, failures by kind, unavailable rate, coverage
(share of claimed `code` tasks that had a current assessment at claim time), re-assessments per
task.

Validity — the questions this feature must eventually answer, each a join of the assessment
named by the **first claim's context marker** (per task and stage) against the task's outcome. An
assessment obtained after the claim never counts as pre-claim coverage; later edits do not rewrite
the cohort; legacy claims without a marker are excluded with a visible count; incomplete tasks are
not failures; unavailable is never blended into zero readiness. Partition by question set,
provider/model and stage, and show denominators and decile sample sizes:

| Signal | Outcome it should predict |
|--------|---------------------------|
| readiness (and each part) | `blocked` transitions, review rounds, first-pass approval, skip-listing |
| complexity | tokens, work minutes, claim count |
| risk | confirmed `ai-review` error findings, delivery bounces (`ci_failed`) |
| override | did overridden tasks fail more often than eligible ones? |
| description-stage delta | does readiness rise after the description stage rewrites the spec? |

Plus a calibration view: bucket readiness by decile, plot against actual first-pass approval.
**Exit criterion for proposing Stage 4:** a visible monotonic relationship between readiness and
first-pass approval over at least ~100 assessed-and-completed tasks. If it isn't there, enforcement
is not built and the question set is revised instead.

---

## 14. Delivery stages and acceptance criteria

Delivered as **three PRs, each safe to merge and deploy with the mode `off`**: Stage 1 plus the
HTTP surface and override op; Stage 2 (supervisor, migration, Jev); Stage 3 (UI, claim-context
marker, analytics).

### Stage 1 — Domain model (core only, no network)

Types, marker build/parse, `intakeRevision`, `evaluateIntakePolicy`, `intake_settings`,
`recordIntakeAssessment`, derived `Task.intake`, `addComment` marker guard, MCP stripping.

1. `intakeRevision` is stable across whitespace/CRLF noise and changes for each of title, spec,
   acceptance criteria, stage, plan; it does not change for links, attachments, priority, status.
2. `recordIntakeAssessment` rejects invalid distributions, a non-arg-max `value`, and a
   `sourceRevision` that no longer matches the task.
3. `Task.intake.state` is `current` → `stale` after a material edit → `current` after a new
   record; reverting to an already-assessed revision is `current` again with no new assessment.
4. Policy: each rule fires and is individually switchable; the description stage never yields
   `not_verifiable`; reasons name the weakest readiness part.
5. All three marker families and the derived `Task.intake` are absent from every MCP
   task-returning payload, in db and board mode.
6. A human/worker `add_comment` starting with any reserved intake marker is refused. Intake
   markers do not consume the 50-row activity window; their history is retrievable separately.
7. With `mode: 'off'` every existing test passes unchanged and no task payload gains a non-null
   `intake`.

### Stage 2 — Intake supervisor + Jev provider

8. Selection honours kind, status set, opt-in workspaces, settle window, `maxPerTick`, ordering.
9. One provider request per assessment; the Jev response maps to `intake/v1` with the **returned**
   model, confidence and reported token usage recorded (tested against sanitized real-response fixtures).
10. Every failure kind follows §11's table; an auth failure refunds the reservation and exits
    non-zero; `input_too_large` publishes `unavailable` without consuming retries; exhaustion
    writes exactly one `unavailable` record per revision, including after a crash before
    publication.
10a. Two concurrent supervisors make one provider call per revision; a dispatcher/reviewer
    abandoned-reservation sweep during a call refunds nothing; an abandoned `running` attempt is
    recovered and does not block its revision.
10b. The heartbeat-kind migration preserves existing rows on upgrade and matches a fresh DB.
11. No provider failure produces a `failure/v1` comment, a status change, or a dispatcher attempt.
12. The API key, and provider response bodies, appear in no DB row, activity body, log line,
    heartbeat, or HTTP response (asserted with sentinels); the outbound field allowlist is asserted
    exactly.
13. Works in `db` and `board` mode; `whoami` gate at startup; heartbeat visible in the health view.

### Stage 3 — Advisory UI

14. Drawer panel renders every state in §12; board chip only on attention.
15. Queueing over a flag shows the inline notice, proceeds on confirm, and writes
    `intake-override/v1` bound to the revision.
16. Settings section edits `intake_settings` live; `enforced` is not selectable; saving refreshes
    the saving client's task data.
17. Analytics exposes the operational metrics and the calibration view, attributed through
    `intake-claim/v1`; claim results with intake off are identical to today's.

### Stage 4 — Enforcement (not approved; gated on §13's exit criterion)

`task_intake` table + migration, claim gate in `oldestQueuedRow`, bounded hold, "Held by intake"
chip, override releases the hold. Specified in §9; to be re-reviewed with real data before build.

All stages: `npm run build` and `npm test` green; Conventional Commits; local commits only.

---

## 15. Decisions

Accepted decisions for implementation:

| v0.1 open decision | v0.2 |
|--------------------|------|
| Trigger | Asynchronous assess-on-change by a poller, with a settle window (§3). |
| Initial enforcement | Advisory only. `enforced` exists in the mode enum but is rejected until Stage 4. |
| Dimensions | Readiness (3 parts), complexity, risk. Task type and security sensitivity deferred (§5.4). |
| Persistence | `intake/v1` marker comment; derived summary; no persistence migration until Stage 4. One Stage 2 migration widens the heartbeat-kind CHECK (§2, §8). |
| Thresholds | Present, provisional, colour the UI only. Raw probabilities always shown (§7). |
| Failure policy | Bounded hold then fail open (§9) — moot until Stage 4. |
| Override | Always available to a human, never to an agent, bound to the assessed revision, always logged (§9). |
| Provider packaging | Schema + policy in core; provider + loop in a new optional `packages/intake` supervisor (§2). |

Remaining provider verification and rollout gates (not blockers for PR A or fixture work):

1. **Jev data handling.** Does TypeSafe retain or train on submitted task text? Determines which
   workspaces may ever be opted in. Blocks Stage 2 for client workspaces, not for `default`.
2. **Jev API facts** — the five items in §11, re-verified from NimBus spec 033's evidence rather
   than rediscovered. Blocks the Jev adapter, not fixture-backed supervisor work.
3. **`sendWorkspacePolicy`.** Workspace policy text improves the readiness judgment but is the
   most organisation-specific text on the board. Accepted default: off; enabling it remains an explicit workspace data-sharing choice.
4. **Supervisor packaging is settled:** a separate package/process, with different credentials
   and independent failure handling. The watcher remains supervisor-token-gated; intake uses a plain
   service token in advisory mode.

## 16. Non-goals (v1)

Rewriting task descriptions; generating acceptance criteria; repository inspection; choosing
architecture; choosing Claude vs Codex or a model tier from complexity; adjusting review depth from
risk; replacing the dispatcher, reviewer or human approval. Several of these are obvious *consumers*
of intake signals — which is the point of building the signal first and proving it predicts
something.
