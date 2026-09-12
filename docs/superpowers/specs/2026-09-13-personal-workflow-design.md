# Personal workflow: dependable execution and quicker review

Date: 2026-09-13
Status: Proposed design; implementation has not started.
Companion: [Implementation plan](../plans/2026-09-13-personal-workflow-implementation.md)

## Purpose

Develop AgentFactory as the owner's personal tool. Optimize for fewer manual
recoveries, quicker informed reviews, and consistent GitHub/Azure DevOps delivery.
Keep TypeScript, SQLite, the existing board, and separate supervisors. Cloud
tenancy, a new agent framework, extra native clients, and automatic merging are
outside this effort.

## What already exists

- Core owns lifecycle transitions, atomic claims, persistent branches, and history.
- Dispatcher/reviewer have timeouts, process-tree termination, failure notes,
  attempt limits, and operator Restart. Attempt counters/skip lists are in memory.
- Dispatcher predicts a task before spawn; the worker subsequently claims from
  the workspace queue. Durable accounting must bind the actual claim to its run.
- Notifications use an activity cursor in SQLite and webhook POSTs. Failed POSTs
  are logged but the cursor still advances; supervisor-down edges are in memory.
- The drawer already contains diff, review findings, metrics, failure details,
  transcripts, and visualizations. These should be composed, not duplicated.
- Verification is worker-reported text. Reviews are matched to submissions by
  activity ordering rather than a recorded commit identity.
- Watcher reads GitHub and Azure DevOps PRs/checks and returns CI/conflict failures
  for repair. Its provider observations include head/merge SHAs, but the durable
  delivery check write does not preserve that complete revision context.
- GitHub has a best-effort PR step in the worker protocol; Azure DevOps has no
  equivalent there. Workspace policy, verification command, and prompt overrides
  already exist and should remain the configuration foundation.

## 1. Less supervision

### Durable attempts, then execution identity

First persist retry accounting in core. A budget belongs to task, operation, and
work generation, not the lifetime of a supervisor. Operations are worker stage,
review, visualization, and delivery-feedback evaluation. New stages/submissions
start the relevant new generation; a supervisor restart does not. An operator
Restart opens a fresh budget generation and records why without erasing history
or changing the task's lifecycle status.

Keep existing maxAttempts settings as initial defaults. Add a separate persisted
delivery-repair budget (proposed default: two repair cycles per task delivery
episode). Successful worker submission does not reset that budget; otherwise a
CI -> repair -> review loop can run forever. Provider polling and temporary
provider outages consume no coding attempt. An exhausted repair budget leaves
the task visibly needing intervention and unclaimable until an explicit restart.

The next increment adds an execution record with a unique ID, task/stage,
operation, generation, attempt number, owner, timestamps, heartbeat, state,
retry-after time, and terminal reason. Reserve the intended eligible task before
spawn, and make the worker claim that reservation. An interactive MCP claim
creates its own execution atomically. Repeated claim responses return the same
execution; a reservation that never starts is reconciled after its grace period.

Only the current execution may report progress, submit, or settle its artifacts.
Reject late writes after release/reclaim; store obsolete output as historical
diagnostic data only. Reviewer work is similarly scoped to submission identity.
Ownership checks happen in core for both local DB and HTTP paths.

Reconcile on startup and each poll. Preserve a worker still reporting liveness;
expire abandoned claims using existing conservative timeout settings. A board
rejection prevents stale state writes but cannot stop git writes from an orphaned
process: confirm local process-tree termination or remote runner cancellation
before reusing the same worktree. If cancellation cannot be confirmed, surface
the situation instead of starting a competing writer. PID alone is insufficient
to establish ownership after a restart.

### Retry decisions

| Situation | Planned behavior |
|---|---|
| Transient network fault or abandoned execution | Retry with persisted backoff within budget |
| Missing CLI, invalid credentials, missing checkout | Explain the repair needed; do not repeatedly launch |
| Worker timeout/crash | Preserve output, reconcile ownership, retry within budget |
| CI failure or merge conflict | One repair event per observed revision/failure; charge delivery budget |
| Review findings | Preserve current human-curated feedback gate |
| Unknown failure | Bounded existing retry policy, then ask for intervention |

### Attention and notifications

Use a single set of attention reasons for board indicators and webhook alerts:
blocked question, review ready for a human, attempts exhausted, credentials/setup
needed, supervisor unavailable, and delivery stalled or policy unmet.

The board remains authoritative. An attention occurrence has a stable identity,
task/supervisor target, reason, first/last seen, and resolution. A new occurrence
can alert again after the previous one resolves. Acknowledge/snooze affects alert
delivery only, never approval or retries. Show automatic retries as progress.
For doc stages awaiting automated review, suppress immediate human-review alerts;
alert on findings or a configurable review wait threshold instead.

Retain existing AF_NOTIFY_WEBHOOKS destinations as the provisional default; the
notification-channel preference was asked during planning and remains optional.
Create a SQLite outbox entry per occurrence and configured destination in the
same transaction that advances the source cursor. Use request timeouts, bounded
backoff, per-destination success state, and a visible permanently-failed state.
Serialize poll ticks. Persist supervisor edge state. A crash after the receiver
accepts a POST can still duplicate an alert: promise at-least-once delivery, not
exactly-once delivery. Include a stable event ID and a task deep link; never place
credentials or access tokens in links or outbox payloads.

## 2. Faster decisions

### Revision and evidence model

An implementation submission records its commit SHA and diff base SHA. Each test
record, review, visualization, approval, and host observation identifies the
submission it concerns. Doc stages use submission ID/content hash instead.
Historical unbound records stay readable with an explicit legacy label.

Record command, working-directory identity, start/end, exit code, source, and a
bounded log artifact for verification. Distinguish worker-reported statements,
runner-captured command results, and provider-observed CI. A passing command does
not prove all acceptance criteria; criteria can remain manual or unverified.

Capture verification through a supervisor-owned helper running on the machine
holding the worktree before cleanup. The worker requests configured checks; it
does not supply trusted exit codes. Record HEAD and worktree cleanliness before
and after execution. Evidence for dirty or changed files is not valid for a clean
submitted revision. This improves provenance; it is not a security sandbox against
a malicious worker. Unknown formats remain raw logs, not invented test counts.

Do not move build execution into the web server. Persist/cap artifacts before
worktree removal and retain small summaries when large logs are pruned. Storage
limits and explicit retention keep a personal SQLite deployment manageable.

### One decision panel

At the top of the existing task drawer show:

1. What changed: concise outcome, changed files, and link to full diff.
2. Evidence: required commands/CI, result source, tested revision, and missing checks.
3. Review: current findings, checked feedback, reviewer identity, and revision.
4. Remaining concerns: failed/unverified criteria, stale evidence, unresolved
   questions, host policies, or pending delivery.
5. Actions: approve current revision, request changes, answer, or retry where legal.

Use stored deterministic facts for readiness; generated summaries and HTML
visualizations are supporting material. Preserve existing finding curation and
override audit behavior. All artifact links must survive worktree cleanup.

Approval submits an expected submission ID and revision. Core rejects a stale
submission; the git adapter refreshes the known head before approval. A push
observed afterward invalidates readiness and requires renewed review/approval.
Polling cannot eliminate a push/merge race on the host; host branch policies are
still authoritative. Expose last-observed time and unknown freshness honestly.

## 3. The owner's repository workflow

Extend the existing workspace settings with an effective repository profile:
base branch (normally detected), canonical clone/runner mapping, verification
commands, required host checks/policies, pre/post-merge verification choice,
explicit handling of repositories with no CI, and PR handoff mode.

Keep feature/<key>-<title> and persisted branch reuse as defaults; make branch
templates configurable only if a real repository requires it. Preserve source
work-item links and Conventional Commits. Session/user authorization and repository
instructions constrain push/PR creation; a profile must not silently grant them.
Default new PR automation to manual until the owner enables the mode for that
workspace. Display the effective profile and its source before queueing.

Add a diagnostic check for local paths/casing, origin/base branch, available
tools, credential access, and configured verification commands. Report capability
gaps separately from code failures. Avoid a competing generic configuration system.

Unify provider handoff as lookup existing PR -> create if authorized and absent ->
persist link. Identify PRs by repository, source, and target, not title. Reconcile
ambiguous POST failures by querying before retrying. Preserve manually edited PR
text; generate a bounded managed section containing summary/evidence/task links.
Keep the watcher read-only toward git hosts; PR mutations belong in an explicit
handoff adapter with the appropriate credentials, separate from observer access.

Read GitHub check runs plus commit statuses; read Azure DevOps policy evaluations
as well as PR statuses/build outcomes. Distinguish required policy failure,
pending, cancelled, no checks, and unknown due to API failure. Keep native links,
PR head identity, merge identity, and actual evaluated revision. Do not attribute
a base-branch build to a PR without a verified revision relationship.

On open-PR failure, repair the same branch/PR. On an already merged PR failure,
create a linked follow-up repair task/branch from the current base; do not keep
pushing an already completed PR. An intentionally closed/abandoned PR asks for
operator judgment. Repeated polls must not duplicate repairs or external writes.

## Success measures and rollout

Use normal work on one GitHub and one Azure DevOps repository, with external
actions enabled only through the owner's chosen workflow. Compare ten tasks
before/after: manual recovery interventions, time to understand a review,
duplicate/missed alerts, and time spent finding CI errors. Treat this small sample
as directional personal feedback, not a statistical benchmark.

Target demonstrations: restart preserves an exhausted budget; an obsolete worker
cannot settle a replacement claim; a temporary webhook outage recovers; one panel
explains a current change; a new commit invalidates old evidence; both hosts reuse
an existing open PR and stop when repair allowance is exhausted.

Database changes use new migration slots assigned at implementation time, a
verified backup/restore procedure, and reconciliation for divergent schemas.
Upgrade board, MCP, and supervisors together for execution identity; fail fast on
incompatible capabilities. Do not invent historical attempts or evidence.

## External API references checked during planning

- [GitHub pull requests](https://docs.github.com/en/rest/pulls/pulls)
- [GitHub check runs](https://docs.github.com/en/rest/checks/runs)
- [Azure DevOps PR creation](https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-requests/create?view=azure-devops-rest-7.1)
- [Azure DevOps policy evaluations](https://learn.microsoft.com/en-us/rest/api/azure/devops/policy/evaluations/list?view=azure-devops-rest-7.1)

Endpoint details, required scopes, and provider edge cases must be rechecked when
implementing adapters. The ado-bridge repository is external to this checkout;
inspect its actual contract before changing source work-item synchronization.
