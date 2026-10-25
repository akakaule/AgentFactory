import type { AgentPrompts } from './agentPrompts.js';
import type { ReviewConsensus } from './reviewConsensus.js';
import type { AdoSyncSettings, AdoSyncSettingsInput } from './adoSync.js';

export type Status = 'backlog' | 'queued' | 'in_progress' | 'in_review' | 'delivering' | 'done' | 'blocked';
export type Actor = 'human' | 'agent';
/** Wire capabilities that must be present before supervisors and workers are restarted together. */
export const AGENT_CAPABILITIES = ['execution-fence/v1'] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];
/** Request header on the startup whoami: the capabilities the calling supervisor build speaks. */
export const AGENT_CAPABILITIES_HEADER = 'x-agentfactory-capabilities';
/** What every side of a capability mismatch must do: one restart of the whole fleet on one build. */
export const COORDINATED_RESTART = 'coordinated restart required: rebuild, then restart the board, MCP sessions and every supervisor together';

/** Durable retry accounting is deliberately open-ended so a new supervisor operation can be
 * added without another schema migration. Callers use names such as `dispatcher:implementation`
 * and `reviewer:implementation` to give stages/submissions independent budgets. */
export type RetryOperation = string;
export type RetryAttemptState = 'reserved' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type ExecutionState = RetryAttemptState;
export interface Execution {
  id: string; taskKey: string; stage: Stage; operation: RetryOperation;
  generation: number; attempt: number; maxAttempts: number; owner: string | null;
  state: ExecutionState; reservedAt: string; startedAt: string | null;
  heartbeatAt: string | null; retryAfterAt: string | null; terminalReason: string | null;
}
export interface RetryBudget {
  taskKey: string; operation: RetryOperation; generation: number;
  maxAttempts: number; attemptsUsed: number; remaining: number; exhausted: boolean;
}
export interface RetryReservation {
  id: string; taskKey: string; operation: RetryOperation; generation: number;
  attempt: number; maxAttempts: number; state: RetryAttemptState; reservedAt: string;
}

/**
 * Pipeline stage. The flow is description (writes the spec) → implementation, cycling through
 * the statuses once per stage; approving an in-review doc stage advances it via NEXT_STAGE and
 * re-queues, approving implementation delivers/closes the task. `plan` is a LEGACY stage
 * (pre-2026-10-21 tasks): it still runs and advances to implementation, but the flow never
 * routes a task there. STAGE_ORDER is display/sort order only, never the advance rule.
 */
export type Stage = 'description' | 'plan' | 'implementation';
export const STAGE_ORDER: readonly Stage[] = ['description', 'plan', 'implementation'];
/** The stage an approved doc stage advances to. */
export const NEXT_STAGE: Readonly<Record<Exclude<Stage, 'implementation'>, Stage>> = {
  description: 'implementation',
  plan: 'implementation',
};
export type ActivityType = 'status_change' | 'comment' | 'result' | 'feedback';
export type LinkKind = 'branch' | 'pr' | 'worktree' | 'log' | 'url';
/** What a task IS: 'code' = an agent-implemented feature (the default, today's only shape);
 *  'pr-review' = review a teammate's pull request (e.g. GitHub or Azure DevOps) — born straight
 *  into in_review; never implemented. Its only functional input is the head-branch link. */
export type TaskKind = 'code' | 'pr-review';

export interface Workspace {
  id: number; name: string; repoPath: string; createdAt: string;
  // per-workspace engineering discipline (migration #12); null = unset, behaves as before.
  policy: string | null;        // free-text standards injected into the claim payload + reviewer prompt
  verifyCommand: string | null; // command the implementation stage must run and pass before handoff
  // Whether a git PAT is stored for this workspace (migration #19). The raw credential is SECRET
  // and never serialized — only this boolean is exposed. Set/clear it via UpdateWorkspaceInput.pat.
  hasPat: boolean;
  // Per-workspace agent system-prompt overrides (migration #20); {} = inherit the global defaults.
  // The effective prompt an agent runs with is override ?? global ?? '' (see resolveAgentPrompt).
  promptOverrides: AgentPrompts;
  // Azure DevOps work-item import (migration #27); null = not configured. The watcher runs it only
  // when `enabled` and the workspace's origin is on Azure DevOps (see adoSync.ts).
  adoSync: AdoSyncSettings | null;
}

/** A real human (or the seeded system row). Distinct from the `Actor` machine axis. */
export interface User {
  id: number; email: string; displayName: string;
  oidcSubject: string | null; // Entra 'oid' once OIDC lands; null for token-only/local users
  isSystem: boolean; createdAt: string;
}

export type AiReviewSeverity = 'info' | 'warning' | 'error';

/** One parsed finding from an `ai-review/v1` comment (all locator fields optional). */
export interface AiReviewFinding {
  severity: AiReviewSeverity | null;
  file: string | null;
  line: number | null;
  title: string;
  detail: string | null; // the problem (newer reviewers keep the remedy in `fix`)
  // the acceptance-criterion ids (AC<n>) this finding puts at risk; [] = outside the criteria,
  // absent = not reported (a reviewer from before criterion links)
  criteria?: string[] | undefined;
  fix?: string | undefined; // the change that resolves it
}

/** clean = current review, no findings; findings = current review with N>0; pending = a result is newer than the latest review. */
export type AiReviewVerdict = 'clean' | 'findings' | 'pending' | 'disputed';

/**
 * Verdict of the latest automated AI review, derived at read time from the activity log
 * (the latest `ai-review/v1` comment vs. the latest result). null = no AI review present.
 * Purely derived — there is no AI-review column. See src/aiReview.ts.
 */
export interface AiReviewSummary {
  verdict: AiReviewVerdict;
  findings: number; // count of items (0 when clean); for pending, the superseded review's count
  reviewer: string | null;
  items: AiReviewFinding[];
  consensus?: ReviewConsensus;
  // which submission/revision the review concerns (migration #29). 'legacy' = an unbound review
  // (posted before revisions were recorded; a clean one reads 'pending' while its stage has a
  // tracked submission it cannot prove, unless the task is done); 'superseded' = a newer submission replaced the one it
  // reviewed (a re-review is due); 'stale' = it names the current submission but that revision moved
  // (a later head, a head other than the submitted one, edited doc content) — only a resubmission
  // helps. Both non-current bindings read verdict 'pending'.
  binding?: ReviewBinding;
  revision?: ReviewRevision | null;
}

/** The revision a review/visualization/approval names: a submission id, plus the head SHA it saw. */
export interface ReviewRevision { submissionId: number; headSha: string | null; baseSha?: string | null; }
export type ReviewBinding = 'current' | 'stale' | 'superseded' | 'legacy';

/** Where a submission's revision came from: the pushed branch on origin, the local worktree,
 *  a doc stage's content hash, or nothing resolvable (an older worker / an unreachable origin). */
export type RevisionSource = 'origin' | 'local' | 'content' | 'unknown';
export type RevisionObservationSource = 'submit' | 'git' | 'provider';
/** 'stale' = the branch head (or doc content) was seen to move since the submission — a later
 *  failed observation does not clear that; 'unknown' = the revision was never resolved or the
 *  latest observation failed with no known mismatch. */
export type RevisionFreshness = 'current' | 'stale' | 'unknown';
export interface SubmissionRevisionInput { headSha: string; baseSha?: string | null | undefined; source: 'origin' | 'local'; }
/** `headSha` is the last head actually seen; source/observedAt/error describe the latest attempt,
 *  so a failed refresh (error set) keeps the previously known head. */
export interface RevisionObservation { headSha: string | null; source: RevisionObservationSource; observedAt: string; error: string | null; }
/** One submit_result's handed-over revision (migration #29) — outlives the worktree and branch. */
export interface SubmissionSummary {
  id: number;
  stage: Stage;
  executionId: string | null;
  branch: string | null;
  headSha: string | null;
  baseSha: string | null;
  contentHash: string | null;
  source: RevisionSource;
  observedAt: string;
  createdAt: string;
  lastObservation: RevisionObservation | null;
  freshness: RevisionFreshness;
}
/** What a human approves: the submission (and head) they looked at. A mismatch is refused. */
export interface ExpectedRevision { submissionId: number; headSha?: string | null | undefined; }

/**
 * The AI review as the human decides on it (docs/spec/2026-10-21-review-decision-panel-design.md
 * §5): each distinct issue once, grouped by what it needs from the human, and each acceptance
 * criterion's status. Derived at read time from the AiReviewSummary — see src/reviewBrief.ts.
 */
export type ReviewHeadline = 'changes_needed' | 'your_call' | 'minor' | 'clean' | 'pending';
export type ReviewGroup = 'must' | 'call' | 'should' | 'fyi';
export type ReviewDispute = 'severity' | 'validity' | 'unverified';
export interface ReviewOpinion {
  reviewer: string;
  decision: 'confirm' | 'reject' | 'uncertain';
  severity: AiReviewSeverity | null;
  reason: string | null;
  evidence: string;
}
/** A consensus candidate shown by reference: a merged duplicate or a rejected candidate. */
export interface ReviewCandidateRef { id: string; title: string; source: string; opinions: ReviewOpinion[] }
export interface ReviewIssue {
  id: string;                       // consensus candidate id; v1: F1…Fn by position
  group: ReviewGroup;
  dispute: ReviewDispute | null;    // set only when group is 'call'
  title: string;
  problem: string | null;           // finding.detail
  fix: string | null;
  file: string | null;
  line: number | null;
  criteria: string[] | null;        // null = unknown (legacy review, no id in the title)
  source: string | null;            // the reviewer who raised it
  opinions: ReviewOpinion[];        // [] for a single-reviewer (v1) review
  merged: ReviewCandidateRef[];
}
export interface ReviewCriterionRow {
  id: string;
  name: string | null;
  text: string;
  status: 'not_met' | 'your_call' | 'concerns' | 'clear';
  issueIds: string[];
}
export interface ReviewBrief {
  headline: ReviewHeadline;
  reviewers: string[];              // consensus participants, or [reviewer] for v1
  headSha: string | null;           // consensus.submission.headSha
  counts: { must: number; call: number; should: number; fyi: number; merged: number; rejected: number };
  issues: ReviewIssue[];            // must, call, should, fyi; candidate order within a group
  rejected: ReviewCandidateRef[];
  criteria: ReviewCriterionRow[];   // [] unless the stage is implementation and items parsed
  generalCriteria: string | null;   // the criteria text outside the list, shown with the rows
  unlinked: number;                 // open issues whose criteria is null (counted only with rows)
}

/**
 * The latest *current* supervisor failure for a task, derived at read time from the latest
 * `failure/v1` comment vs. the latest result (a successful result supersedes it ⇒ cleared).
 * Purely derived — there is no failure column. See src/failure.ts. null = no current failure.
 */
export interface FailureSummary {
  reason: string;            // known FAILURE_REASONS get a styled label; any other string renders generically
  detail: string | null;     // one-line human reason, e.g. "timed out after 60m"
  source: string | null;     // which supervisor emitted it: 'dispatcher' | 'reviewer'
  attempt: number | null;
  maxAttempts: number | null;
  skipListed: boolean;       // out of attempts ⇒ no further auto-retry; a human must intervene
  at: string;                // the failure comment's created_at
}

/**
 * Advisory failure triage (docs/spec/2026-09-25-failure-triage-design.md): a likely-cause label
 * for the current failure, derived at read time by local rules (src/failureTriageRules.ts).
 * Only human feedback is persisted (`failure-triage-feedback/v1` markers). Never changes lifecycle.
 */
export type FailureTriageCategory = 'access' | 'configuration' | 'infrastructure' | 'build_test' | 'agent_execution' | 'delivery' | 'unknown';
export interface FailureTriageRuleResult {
  version: string;                      // rules version, e.g. 'failure-triage-rules/v1'
  category: FailureTriageCategory;      // 'unknown' when no rule matched or there is no usable evidence
  ruleId: string | null;
  matchedLine: string | null;           // bounded excerpt of the local line that matched
  alsoMatched: FailureTriageCategory[]; // lower-precedence categories that also matched
}
export interface FailureTriageFeedback {
  activityId: number; sourceActivityId: number;
  action: 'confirm' | 'correct'; category: FailureTriageCategory;
  shownCategory: FailureTriageCategory; classifier: 'rules' | 'human'; rulesVersion: string | null;
  note: string | null; actorUserId: number | null; actorName: string | null; at: string;
}
export interface FailureTriageSummary {
  sourceActivityId: number;          // the current failure/v1 note (the episode identity)
  evidenceActivityId: number | null; // the note the rules read; null = no usable evidence
  classifier: 'rules' | 'human';     // who supplied the displayed category
  category: FailureTriageCategory; label: string; suggestion: string;
  rules: FailureTriageRuleResult;
  human: FailureTriageFeedback | null; // latest feedback for this source event
}
export interface FailureTriageHistoryItem {
  sourceActivityId: number; reason: string; source: string | null; at: string;
  evidenceActivityId: number | null; rules: FailureTriageRuleResult; feedback: FailureTriageFeedback[];
}
export interface FailureTriageHistoryPage { items: FailureTriageHistoryItem[]; nextBeforeId: number | null; }
export interface FailureTriageFeedbackInput {
  sourceActivityId: number; action: 'confirm' | 'correct'; shownCategory: FailureTriageCategory;
  category?: FailureTriageCategory | undefined; note?: string | undefined;
}

export type IntakeMode = 'off' | 'advisory' | 'enforced';
export type IntakeErrorKind = 'timeout' | 'rate_limit' | 'network' | 'invalid_response' | 'unavailable' | 'input_too_large';
export type IntakeReadinessPart = 'outcomeClear' | 'scopeBounded' | 'verifiable';
export type Complexity = 'trivial' | 'small' | 'medium' | 'large' | 'architectural';
export type Risk = 'low' | 'medium' | 'high' | 'critical';

export interface IntakeProviderMeta { name: string; model: string | null; }
export interface IntakeUsage { inputTokens: number | null; outputTokens: number | null; }
export interface IntakeReadiness { probability: number; parts: Partial<Record<IntakeReadinessPart, number>>; }
export interface IntakeChoice<T extends string> { value: T; probabilities: Record<T, number>; confidence: number | null; }
export interface IntakeDecisions {
  readiness: IntakeReadiness;
  complexity: IntakeChoice<Complexity>;
  risk: IntakeChoice<Risk>;
  [key: string]: unknown;
}
export interface IntakeAssessmentBase {
  schema: 'intake/v1'; taskKey: string; sourceRevision: string; attemptId: string | null;
  stage: Stage; questionSet: string; provider: IntakeProviderMeta; usage: IntakeUsage;
  assessedAt: string; latencyMs: number;
}
export interface IntakeAssessed extends IntakeAssessmentBase { status: 'assessed'; decisions: IntakeDecisions; }
export interface IntakeUnavailable extends IntakeAssessmentBase {
  status: 'unavailable'; error: { kind: IntakeErrorKind; detail: string };
}
export type IntakeAssessmentV1 = IntakeAssessed | IntakeUnavailable;
export type IntakeReasonCode = 'readiness_low' | 'outcome_unclear' | 'scope_unbounded' | 'not_verifiable' | 'architectural' | 'risk_at_or_above';
export interface IntakeReason { code: IntakeReasonCode; message: string; }
export interface IntakePolicyResult { policyVersion: 'intake-policy/v1'; eligibility: 'eligible' | 'attention_required'; reasons: IntakeReason[]; }
export interface IntakeSummary {
  state: 'current' | 'stale' | 'unavailable'; assessment: IntakeAssessmentV1;
  policy: IntakePolicyResult | null; overridden: boolean;
}
export interface IntakeSettings {
  mode: IntakeMode; workspaces: string[]; sendWorkspacePolicy: boolean;
  settleSeconds: number; maxPerTick: number; maxAttempts: number;
  readinessNeedsAttention: boolean; readinessThreshold: number;
  architecturalNeedsAttention: boolean; riskAttentionLevel: Risk | null; maxHoldMinutes: number;
  /** Skip the spec stage for a queued spec-stage task assessed at or under these thresholds. */
  skipSpec: boolean; skipSpecMaxComplexity: 'trivial' | 'small'; skipSpecMaxRisk: Risk; skipSpecMinReadiness: number;
}
export interface TaskIntakeState {
  key: string; title: string; spec: string; acceptanceCriteria: string; stage: Stage; plan: string | null;
  links: { kind: LinkKind; label: string }[]; attachmentCount: number; workspacePolicy: string | null;
}

/** Which git host a workspace's origin points at — the axis the delivery watcher polls. */
export type DeliveryProvider = 'github' | 'azdo';
export type DeliveryPrState = 'unknown' | 'not_found' | 'open' | 'merged' | 'closed';
export type DeliveryChecksState = 'unknown' | 'none' | 'pending' | 'passing' | 'failing';
export interface DeliveryFailingCheck { name: string; url: string | null; }

/**
 * The PR/pipeline state of a task's current approved delivery, as last observed by the watcher supervisor
 * (current-state `task_delivery` row, migration #18 — seeded at approve, updated per poll).
 * External, polled and mutable — persisted, not derived from the activity log; NOT part of
 * getVersion() (ops bump task.updated_at only when the observed state changes). null on a
 * task that never entered delivery.
 */
export interface DeliverySummary {
  provider: DeliveryProvider;
  branch: string;
  prUrl: string | null;
  prId: string | null;
  prState: DeliveryPrState;
  checksState: DeliveryChecksState;
  failing: DeliveryFailingCheck[];     // failing check names + run URLs (empty unless checksState is 'failing')
  checkedAt: string | null;            // last watcher poll; null until the first one
  stateChangedAt: string;              // last time the observed state actually changed
  approvedHeadSha?: string | null;     // the submitted head the human approved (migration #29)
  headSha?: string | null;             // the PR head the provider last reported; differs ⇒ pushed after approval
  submissionId?: number | null;        // the approved submission this delivery episode is bound to (migration #29)
}

export interface Task {
  id: number; key: string; title: string; spec: string; acceptanceCriteria: string;
  status: Status; stage: Stage; kind: TaskKind; resultSummary: string | null; seq: number;
  workspace: string; // workspace slug
  unmetDependencyCount: number; // queued tasks with a non-zero count are waiting and cannot be claimed
  claimedBy: string | null; claimedAt: string | null; // current claim; cleared on re-queue
  archivedAt: string | null; // null = active; set = hidden from default listings (status stays 'done')
  aiReview: AiReviewSummary | null; // derived: latest ai-review comment verdict
  reviewBrief?: ReviewBrief | null; // derived from aiReview + acceptance criteria; null with no review, on list reads outside in_review, and in agent payloads
  failure: FailureSummary | null; // derived: latest current supervisor failure (timeout/crash/denial/skip-list)
  delivery: DeliverySummary | null; // watcher-observed PR/pipeline state (migration #18); null when never in delivery
  intake?: IntakeSummary | null; // derived from intake/v1 markers; hidden when intake is off or not opted in
  intakeHold?: { until: string } | null; // derived: queued implementation work waiting (≤ maxHoldMinutes) for its revision's intake assessment; unclaimable meanwhile
  failureTriage?: FailureTriageSummary | null; // derived likely cause of the current failure; null when none / archived / done
  createdAt: string; updatedAt: string;
}
export interface Activity {
  id: number; taskId: number; type: ActivityType; actor: Actor;
  fromStatus: Status | null; toStatus: Status | null; body: string; createdAt: string;
  actorUserId: number | null; // the human user behind a 'human' action; null for agent/system/legacy
  actorName: string | null;   // joined app_user.display_name for actorUserId; null when unattributed
}
export interface Link { id: number; taskId: number; kind: LinkKind; label: string; url: string; }

/** One activity row in the global (cross-task) feed the notifier consumes, joined to its task. */
export interface ActivityFeedRow {
  id: number; taskKey: string; taskTitle: string; workspace: string;
  type: ActivityType; actor: Actor; toStatus: Status | null; body: string; createdAt: string;
}
export interface Attachment { id: number; taskId: number; filename: string; mime: string; size: number; }

/** Compact task identity used for the two directions of the dependency graph in TaskDetail. */
export interface TaskReference {
  key: string; title: string; status: Status; workspace: string;
}

/** One agent-reported milestone in a live session's small rolling feed. */
export interface AgentMilestone { msg: string; at: string; }

/**
 * A currently-running agent, as surfaced to the Live view / drawer. Derived from the
 * `agent_session` live row joined to its task; only sessions with ended_at IS NULL appear.
 * Ephemeral current-state (not history) — gone when the session ends.
 */
export interface AgentSessionView {
  key: string; title: string; status: Status; workspace: string; stage: Stage;
  label: string | null;            // the claimant/worker label (session identity)
  phase: string | null;            // latest milestone message
  phaseAt: string | null;          // when the latest milestone arrived
  recent: AgentMilestone[];        // small rolling feed (latest last)
  tokensIn: number | null; tokensOut: number | null; // agent-reported, so-far
  startedAt: string;               // claim time
  heartbeatAt: string;             // last-seen-alive (claim / progress / dispatcher tick)
}

/** Which agent CLI produced a transcript. */
export type TranscriptEngine = 'claude' | 'codex';

/**
 * One normalized block of an agent session transcript, parsed from the engine's raw JSONL
 * (see src/transcript.ts). A flat discriminated union on `kind` so it crosses the HTTP/JSON
 * boundary cleanly and the client renders by switching on `kind`. `id` is `<line-uuid>:<index>`,
 * stable across live polls so the client dedups; `sidechain` marks subagent (Task tool) work.
 */
export interface TranscriptBlockBase { id: string; role: 'user' | 'assistant'; at: string | null; sidechain: boolean; }
export type TranscriptBlock =
  | (TranscriptBlockBase & { kind: 'text' | 'thinking'; text: string })
  | (TranscriptBlockBase & { kind: 'bash'; command: string; description: string | null; stdout: string | null; stderr: string | null; exitCode: number | null; isError: boolean; truncated: boolean })
  | (TranscriptBlockBase & { kind: 'tool'; name: string; input: string; result: string | null; isError: boolean; truncated: boolean })
  | (TranscriptBlockBase & { kind: 'image'; note: string });

/**
 * A task's agent transcript as surfaced to the drawer — live while the session runs, then the
 * persisted artifact after it ends. `state`: 'live' = streaming from the running session's tail
 * buffer; 'final' = the persisted full transcript; 'none' = nothing captured (legacy/doc-stage
 * tasks), so the UI hides the section. Derived (parsed) at read time — there is no block table.
 */
export interface TranscriptResponse {
  state: 'live' | 'final' | 'none';
  engine: TranscriptEngine | null;
  attempt: number | null;
  bytes: number | null; // uncompressed transcript size, for the UI size badge
  blocks: TranscriptBlock[];
}

export type SupervisorKind = 'dispatcher' | 'reviewer' | 'watcher' | 'intake';

/**
 * A headless supervisor (dispatcher/reviewer) as surfaced to the health view. Current-state,
 * derived from the `supervisor_heartbeat` row each one upserts every poll; `healthy` is computed
 * at read time from last-seen vs. the supervisor's own poll interval. Ephemeral — a supervisor
 * that never starts simply has no row.
 */
export interface SupervisorView {
  name: string; kind: SupervisorKind;
  workspaces: string[];      // workspace slugs this supervisor serves
  inFlight: number;          // live sessions right now
  capacity: number;          // max concurrent it will run
  pollSeconds: number | null; // its poll interval (drives the staleness threshold)
  polls: number;             // cumulative poll cycles since it started
  version: string | null;    // optional build/version string
  startedAt: string;
  lastSeenAt: string;
  healthy: boolean;          // beat within HEALTHY_MISSED_POLLS × pollSeconds (else it's down)
  staleSeconds: number;      // seconds since the last heartbeat
}

/** Recorded usage grouped by inferred pipeline stage, reported agent engine, and model. */
export interface TaskTokenUsage {
  stage: Stage | null;
  agent: 'codex' | 'claude' | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
}

/** Per-task metrics: stage walk over the activity log + worker-reported token aggregate. */
export interface TaskMetricsView {
  queueMin: number; workMin: number; reviewMin: number; blockedMin: number; deliveringMin: number;
  rounds: number; reopened: boolean; claimCount: number; doneAt: string | null;
  model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
  /** Task detail only; omitted by older servers and analytics summaries. */
  tokenBreakdown?: TaskTokenUsage[];
}

export interface TaskDetail extends Task {
  activity: Activity[]; links: Link[]; attachments: Attachment[];
  dependencies: TaskReference[]; // prerequisites this task waits for
  dependents: TaskReference[]; // tasks blocked by this task
  repoPath: string;
  branch: string | null; // server-named feature branch, set on the first implementation-stage claim; null before then
  plan: string | null; // the plan stage's deliverable; null until that stage submits
  // human's original spec/acceptance criteria, snapshotted before the description stage rewrote them;
  // null when no description-stage rewrite happened (implementation-only and legacy tasks)
  originalSpec: string | null;
  originalAcceptanceCriteria: string | null;
  // the claimed task's workspace discipline (migration #12), carried into the claim payload + reviewer
  policy: string | null;        // free-text engineering standards the work must satisfy
  verifyCommand: string | null; // command the implementation/harden stage must run and pass before handoff
  // change visualization (migration #16): a self-contained HTML overview attached during review.
  // hasVisualization gates the drawer button; the HTML itself is fetched on demand from
  // GET /api/tasks/:key/visualization (kept off TaskDetail — it's tens of KB).
  hasVisualization: boolean;
  visualizationGeneratedAt: string | null;
  visualizationRevision?: ReviewRevision | null; // the submission the visualization was attached under
  // the current stage's latest submission (migration #29); null for historical tasks / before
  // the stage's first submit. Optional so older servers' payloads still type.
  submission?: SubmissionSummary | null;
  metrics: TaskMetricsView;
  // the implementing agent's claim per acceptance criterion from the latest result
  // (criteria-claims/v1, src/criteriaClaims.ts); null when that result reported none.
  // Always set by the board; optional so older servers' payloads still type.
  criteriaClaims?: CriterionClaim[] | null;
}

/** The implementing agent's claim for one acceptance criterion (id AC1…ACn from parseAcceptanceCriteria). */
export interface CriterionClaim { id: string; claim: string }

export interface CreateTaskInput {
  title: string; spec: string;
  acceptanceCriteria?: string | undefined; // required unless stage is 'description' (that stage writes them)
  stage?: Stage | undefined; // default 'implementation' — clients opt into the pipeline explicitly
  kind?: TaskKind | undefined; // default 'code'; 'pr-review' for an imported PR-review task
  links?: LinkInput[] | undefined; // links attached at creation (a PR-review task requires a head-branch link; the pr link is optional)
  workspace?: string | undefined;
  actor?: Actor | undefined; // caller-set attribution for the seed activity; default 'human' (not part of createTaskSchema)
}
export interface CreateWorkspaceInput { name: string; repoPath: string; }
// null clears the field, undefined leaves it untouched (matches the PATCH semantics in the web layer).
// repoPath is a defining field: a string re-points the workspace; it is never null.
export interface UpdateWorkspaceInput {
  repoPath?: string | undefined; policy?: string | null | undefined; verifyCommand?: string | null | undefined; pat?: string | null | undefined;
  // the full override set (only keys to override; a blank/omitted key inherits the global default);
  // replaces the stored map. Present-but-empty ({}) clears all overrides.
  promptOverrides?: Record<string, string> | undefined;
  // the ADO work-item import settings (defaults fill omitted keys); null clears them
  adoSync?: AdoSyncSettingsInput | null | undefined;
}
export interface UpdateTaskInput { title?: string; spec?: string; acceptanceCriteria?: string; workspace?: string; }
export interface LinkInput { kind: LinkKind; label: string; url: string; }
export interface SubmitResultInput {
  summary: string;
  executionId?: string | undefined;
  /** The claimedAt value from the worker's current claim; rejects late submissions from an old execution. */
  claimAt?: string | undefined;
  links?: LinkInput[];
  // stage deliverables — required/forbidden per the task's stage (see ops/submitResult.ts):
  spec?: string | undefined;               // description stage: the rewritten feature description
  acceptanceCriteria?: string | undefined; // description stage: verifiable acceptance criteria
  plan?: string | undefined;               // plan stage: the implementation plan
  verification?: string | undefined;       // implementation/harden: reported outcome of the workspace verify command
  criteria?: CriterionClaim[] | undefined;   // implementation: the agent's claim per acceptance criterion
  revision?: SubmissionRevisionInput | undefined; // implementation: the pushed head/base SHA, resolved at the git boundary
}
export interface AddTaskMetricsInput {
  model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; reportedBy?: string; executionId?: string;
}
export interface AddCommentInput { actor: Actor; body: string; actorUserId?: number | null; executionId?: string | undefined; }
export interface AddAttachmentInput { filename: string; mime: string; dataBase64: string; }

export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

export const RECENT_ACTIVITY_LIMIT = 50;
export const KEY_PREFIX = 'AF';
export const DEFAULT_WORKSPACE = 'default';
