# Personal workflow implementation plan

Date: 2026-09-13
Status: Proposed; planning only. No features implemented by this document.
Design: [Dependable execution and quicker review](../specs/2026-09-13-personal-workflow-design.md)

## Delivery sequence

Ship one increment at a time and use it on real tasks before broadening. Each
increment is a proposed local branch/PR-sized unit, not authorization to push,
open PRs, send notifications, or modify external services now.

| Order | Increment | User-visible result | Depends on |
|---|---|---|---|
| 1 | Persist retry limits | Restarting supervisors no longer resets failure allowance | None |
| 2 | Bind executions to claims | Interrupted work recovers without accepting obsolete results | 1 |
| 3 | Make notifications recoverable | Important alerts survive board/network restarts | 1; integrate 2 when available |
| 4 | Record submission revisions | The board knows which change was reviewed/approved | 2 |
| 5 | Capture verification evidence | Tests and CI have inspectable provenance | 4 |
| 6 | Consolidate the decision panel | One place explains readiness and remaining concerns | 3-5 |
| 7 | Strengthen host observations/profile | GitHub/ADO delivery rules match each repository | 4; surfaces in 6 |
| 8 | Add consistent PR handoff and repair | Both hosts reuse PRs and recover within limits | 1, 2, 5, 7 |

## Common implementation discipline

- Work from canonical `C:\Git\AgentFactory`; preserve path case in child builds.
- Strict TypeScript includes noUncheckedIndexedAccess and exactOptionalPropertyTypes.
- RED: add a failing behavioral test and observe the intended failure. GREEN:
  implement the smallest change. Refactor only after relevant tests pass.
- Core remains the only DB writer; put SQL in repo helpers and rules in ops.
  Update local bindings, HTTP adapters, routes/schemas, MCP contracts, client types,
  and fixtures together for any new shared operation or required field.
- Append migrations; allocate the next unused slot when implementation starts.
  Test upgrades from current and representative divergent-schema fixtures.
- Add mutable tables to getVersion/change signaling where UI needs fresh reads.
- Preserve human implementation approval, curated AI feedback, process-tree
  termination, branch reuse, and actor/capability restrictions.
- At each integrated increment run focused tests, then `npm test`, `npm run build`,
  and `npm -w packages/web run typecheck:client`. Inspect the diff and applicable
  logs; use one built-in code review, not stacked reviewers.
- No live fault injection against active user work. Use temporary DBs/repos,
  stub processes/providers, and a local webhook receiver. Real host mutation
  demonstrations require an explicitly designated disposable task/repository.

## 1. Durable retry limits — first implementation target

Touchpoints: core schema/migrate/types/index/httpCore, new repo/ops retry helpers;
dispatcher.ts, reviewer.ts, watcher.ts; restartTask.ts, failure.ts; agentOps routes;
existing failure UI only where needed to explain the new budget.

1. Add tests that fail today: reconstruct a supervisor after 2/2 failures and
   assert no new spawn; restart only the owning operation; stage advance gets its
   own budget; repeated CI bounces stop after the delivery repair allowance.
2. Introduce persistent retry budget/generation and attempt reservation data.
   Atomically reserve before launch; settle once with a stable attempt ID.
   Distinguish an infrastructure retry from a delivery-repair cycle.
3. Replace in-memory maps as decision authorities. Keep maps only as caches of
   live processes. Wire visualization and feedback evaluation as separate scopes.
4. Preserve maxAttempts config defaults and status-preserving Restart. Retain
   existing failure/v1 and restart/v1 history for compatibility. Initialize known
   legacy exhausted states conservatively; never fabricate an attempt history.
5. Guard repair allowance in the claim path as well as dispatcher polling, so an
   interactive worker cannot unknowingly restart exhausted delivery work.
6. Reconcile reservations abandoned before spawn with a startup grace period.
   Until step 2 binds claims, detect predicted/actual task mismatches and charge
   only the actual attempt; do not assume the prediction is authoritative.

Proof: failures persist across new process/core instances; two reservations cannot
spend one remaining slot; config reload/restart does not restore spent allowance;
operator Restart does. Deliver this before adding a new review interface.

## 2. Execution ownership and recovery

Touchpoints: core claimNextTask/releaseClaim/submitResult/agentSession; new
execution repo/ops; dispatcher spawn/reaper/processTree; reviewer and viz paths;
MCP claim/progress/submit; server agentOps; transcript and metric attribution.

1. Test two supervisors racing one task, dropped claim response, crash between
   reservation and spawn, and a late submit/progress call after release/reclaim.
2. Extend reservation to an execution record; bind task before spawn and pass its
   identity into MCP. Keep interactive get_next_task usable through an atomic
   claim-and-create path. Use unique execution identities in filenames/labels.
3. Require matching current execution for mutable lifecycle/artifact operations.
   Make retried settle requests idempotent; reviewer results also require their
   input generation. Historical output never changes current readiness.
4. Reconcile process liveness and board heartbeat separately; retain useful
   transcript/log tails. Reuse a worktree only after ownership is resolved.
5. Add a capability/version check and coordinated restart instructions. Do not
   silently accept old unfenced submit calls once the new mode is active.

Proof: kill a stub worker tree, restart supervisor, resume once; send old output
after a replacement claim and see it rejected. Repeat over local DB and HTTP.
Keep healthy slow and remote workers alive in clock-controlled tests.

## 3. Reliable attention notifications

Touchpoints: web/server/notifier.ts and index configuration; core new attention
and notification outbox helpers; supervisor heartbeat; task routes; App URL
selection; FailureBanner/BlockedBanner/SupervisorStrip.

1. Test webhook 500/network timeout, board restart, partial destination success,
   overlapping poll ticks, and repeated supervisor-down observations.
2. Persist attention occurrence and per-destination outbox state, with durable
   source cursor advancement. Add timeout/backoff and outbox error visibility.
3. Add blocked/setup/exhaustion/delivery-wait classifications. Delay human review
   alerts while the automated reviewer can still advance a doc stage.
4. Add stable task deep links and alert text: what happened, retry state, and what
   action is needed. Existing webhook destination is the provisional default.
5. Resolve/snooze attention independently from lifecycle; persist occurrence
   boundaries to avoid duplicate alerts on every restart. Keep payloads bounded.

Proof: a local receiver fails twice then succeeds; restart between attempts and
observe delivery. A successful destination is not resent because another failed.
Document unavoidable duplicate risk after an ambiguous successful POST. No
webhook is sent to a real person during implementation verification.

## 4. Revision-aware submissions and review

Touchpoints: core submitResult/approval/aiReview/delivery/repo helpers; MCP submit
guard and protocol; reviewer review/viz; web git/diff routes and ReviewActions;
watcher provider observation persistence.

1. Test submission A reviewed at SHA A, branch updated to SHA B, and approval of
   A rejected or explicitly treated as stale once B is observed. Test unchanged
   revision retry and doc-stage content identities.
2. Persist submission ID, head/base SHA and artifact references. Fetch/resolve
   revision in the existing git boundary; record source and observation time.
3. Carry identity into review and visualization records. Preserve ai-review/v1
   parsing/curated feedback; use structured identity without reinterpreting old
   unbound findings as current proof.
4. Approve with an expected submission/revision; invalidate stale readiness and
   show unknown freshness during provider/git failures. Maintain human overrides
   as distinct audited actions. Diff display can reproduce the reviewed snapshot.

Proof: a new push cannot inherit the previous revision's green review; deleted
worktrees do not erase revision metadata; historical tasks still render.

## 5. Captured verification and acceptance evidence

Touchpoints: supervisor-side verification helper, core artifact/evidence repo and
ops, MCP protocol, submit shape, workspace validation/settings, transcript/log
redaction, reviewer input, HTTP contracts.

1. Test a configured command returning 0/nonzero, timeout, output cap, dirty tree,
   HEAD change during checking, evidence upload failure, and worktree cleanup.
2. Run configured commands through a helper on the worker machine. Record
   execution/submission identity, command, exit code, timestamps, bounded logs,
   and before/after HEAD/cleanliness. Persist before cleanup/submit completion.
3. Label reported, runner-captured, and provider-observed evidence distinctly.
   Attach criterion-to-evidence links where meaningful; keep manual and unverified
   criteria explicit. No new LLM call solely to manufacture a readiness score.
4. Add storage caps and retention; tests verify summary/revision records survive
   artifact pruning. Legacy verification strings remain reported evidence.

Proof: a failing check cannot display as passing; changed or dirty trees cannot
produce revision-valid green evidence; the log remains accessible after cleanup.

## 6. A single decision panel

Touchpoints: DetailPanel, Changes, ReviewActions, FailureBanner, task metrics,
visualization/transcript components, API/client types and board CSS.

1. Test ready, findings, missing evidence, stale revision, blocked, and delivery
   pending states using typed fixtures. Include rapid task switching to catch
   stale asynchronous responses.
2. Compose the five sections from the design above existing detailed components.
   Show deterministic concerns first; full logs/diff stay expandable.
3. Preserve checkbox-curated Request changes, attributed overrides, and legal
   action rules. Link attention entries directly to the relevant concern.
4. Verify desktop and narrow/mobile layouts with seeded local data. Record a
   before/after walkthrough of the same task, including visible errors.

Proof: in one drawer the owner can identify what changed, evidence provenance,
current findings, remaining concerns, and the next legal action without opening
the host. No old response can pair one task's header with another task's actions.

## 7. Repository profiles and provider observation parity

Touchpoints: Workspace types/repo/ops/validation; WorkspacesModal; MCP protocol
and git/default-branch resolution; watcher config/providers/types; delivery ops.

1. Add table-driven GitHub/ADO provider fixtures for required/pending/failed/no-CI,
   permission error, rate limit, pagination, stale build, merge conflict, and
   post-merge checks. Verify evaluation revision, not merely a green API field.
2. Extend existing workspace settings with base branch, verification/check
   requirements, explicit no-CI choice, and PR mode. Display effective values and
   keep legacy behavior until the owner configures stricter requirements.
3. Add a read-only diagnostic action for path case, remote identity, base ref,
   executables, credential access, and check visibility. Keep secret values hidden.
4. Implement GitHub check/status and ADO policy/build observation parity using
   the official references in the design. Store native context and timestamps;
   unknown/forbidden cannot satisfy a configured requirement.
5. Verify source work-item references survive spec/plan rewriting. Inspect the
   external ado-bridge contract before proposing sync changes; do not create a
   second source-of-truth issue tracker in this increment.

Proof: identical policy scenarios produce the same delivery outcome on both host
fixtures; missing required CI stays visibly unresolved; explicit no-CI policy is
distinguishable from a successfully verified build.

## 8. Consistent PR handoff and bounded repair

Touchpoints: new explicit host handoff adapter in the runner/MCP integration,
existing GitHub protocol step, task PR links/delivery/retry ops, provider fixtures,
workspace PR configuration and review panel.

1. Test existing PR lookup, absent PR creation, ambiguous create timeout, missing
   write capability, preserved user text, and non-default target branch.
2. Route GitHub and ADO through lookup/create/reconcile operations; persist PR
   identity. Only enabled/authorized workspace modes may mutate the host.
   Keep observer credentials/read-only watcher behavior separate.
3. Deduplicate failures by delivery generation, revision, and failure occurrence.
   Charge one repair cycle per new intervention, not each poll. Include concrete
   CI errors/conflict context and the current repository profile in repair input.
4. Reuse open PR branches; for merged failures create a linked follow-up from the
   latest base. Closed/abandoned work requires judgment. Exhausted budget surfaces
   an attention item and stops automatic repair, including after restart.

Proof: scripted provider tests show no duplicate PR following an ambiguous POST,
no duplicate repair for repeated polls, same-branch open-PR recovery, and correct
follow-up behavior after merge. Perform one designated GitHub/ADO smoke task when
the owner explicitly chooses test repositories and authorizes external writes.

## Completion and personal feedback

This plan is complete when its scope, dependencies, touchpoints, and verification
are reviewable; feature completion requires the tests and demonstrations above.
Keep a short baseline for the next ten ordinary tasks: recovery interventions,
minutes to understand reviews, missed/duplicate alerts, and time finding errors.
After each increment, use the tool and revise the next priority based on actual
friction. Start with increment 1; defer later scope that does not save effort.
