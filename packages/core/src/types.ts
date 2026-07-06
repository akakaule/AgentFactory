export type Status = 'backlog' | 'queued' | 'in_progress' | 'in_review' | 'delivering' | 'done' | 'blocked';
export type Actor = 'human' | 'agent';

/**
 * Pipeline stage. A task walks the stages in STAGE_ORDER, cycling through the
 * statuses once per stage; approving an in-review doc stage (description/plan)
 * advances the stage and re-queues, approving implementation closes the task.
 */
export type Stage = 'description' | 'plan' | 'implementation';
export const STAGE_ORDER: readonly Stage[] = ['description', 'plan', 'implementation'];
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
  detail: string | null;
}

/** clean = current review, no findings; findings = current review with N>0; pending = a result is newer than the latest review. */
export type AiReviewVerdict = 'clean' | 'findings' | 'pending';

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

/** Which git host a workspace's origin points at — the axis the delivery watcher polls. */
export type DeliveryProvider = 'github' | 'azdo';
export type DeliveryPrState = 'unknown' | 'not_found' | 'open' | 'merged' | 'closed';
export type DeliveryChecksState = 'unknown' | 'none' | 'pending' | 'passing' | 'failing';
export interface DeliveryFailingCheck { name: string; url: string | null; }

/**
 * The PR/pipeline state of a 'delivering' task, as last observed by the watcher supervisor
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
}

export interface Task {
  id: number; key: string; title: string; spec: string; acceptanceCriteria: string;
  status: Status; stage: Stage; kind: TaskKind; resultSummary: string | null; seq: number;
  workspace: string; // workspace slug
  claimedBy: string | null; claimedAt: string | null; // current claim; cleared on re-queue
  archivedAt: string | null; // null = active; set = hidden from default listings (status stays 'done')
  aiReview: AiReviewSummary | null; // derived: latest ai-review comment verdict
  failure: FailureSummary | null; // derived: latest current supervisor failure (timeout/crash/denial/skip-list)
  delivery: DeliverySummary | null; // watcher-observed PR/pipeline state (migration #18); null when never in delivery
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

/** Which agent CLI produced a transcript. Only `claude` is parsed today; `codex` is the next drop-in. */
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

export type SupervisorKind = 'dispatcher' | 'reviewer' | 'watcher';

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

/** Per-task metrics: stage walk over the activity log + worker-reported token aggregate. */
export interface TaskMetricsView {
  queueMin: number; workMin: number; reviewMin: number; blockedMin: number;
  rounds: number; reopened: boolean; claimCount: number; doneAt: string | null;
  model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
}

export interface TaskDetail extends Task {
  activity: Activity[]; links: Link[]; attachments: Attachment[];
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
  metrics: TaskMetricsView;
}

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
export interface UpdateWorkspaceInput { repoPath?: string | undefined; policy?: string | null | undefined; verifyCommand?: string | null | undefined; pat?: string | null | undefined; }
export interface UpdateTaskInput { title?: string; spec?: string; acceptanceCriteria?: string; }
export interface LinkInput { kind: LinkKind; label: string; url: string; }
export interface SubmitResultInput {
  summary: string;
  links?: LinkInput[];
  // stage deliverables — required/forbidden per the task's stage (see ops/submitResult.ts):
  spec?: string | undefined;               // description stage: the rewritten feature description
  acceptanceCriteria?: string | undefined; // description stage: verifiable acceptance criteria
  plan?: string | undefined;               // plan stage: the implementation plan
  verification?: string | undefined;       // implementation/harden: reported outcome of the workspace verify command
}
export interface AddTaskMetricsInput {
  model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; reportedBy?: string;
}
export interface AddAttachmentInput { filename: string; mime: string; dataBase64: string; }

export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

export const RECENT_ACTIVITY_LIMIT = 50;
export const KEY_PREFIX = 'AF';
export const DEFAULT_WORKSPACE = 'default';
