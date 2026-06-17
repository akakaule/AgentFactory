export type Status = 'backlog' | 'queued' | 'in_progress' | 'in_review' | 'done' | 'blocked';
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

export interface Workspace {
  id: number; name: string; repoPath: string; createdAt: string;
  // per-workspace engineering discipline (migration #12); null = unset, behaves as before.
  policy: string | null;        // free-text standards injected into the claim payload + reviewer prompt
  verifyCommand: string | null; // command the implementation stage must run and pass before handoff
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

export interface Task {
  id: number; key: string; title: string; spec: string; acceptanceCriteria: string;
  status: Status; stage: Stage; resultSummary: string | null; seq: number;
  workspace: string; // workspace slug
  claimedBy: string | null; claimedAt: string | null; // current claim; cleared on re-queue
  archivedAt: string | null; // null = active; set = hidden from default listings (status stays 'done')
  aiReview: AiReviewSummary | null; // derived: latest ai-review comment verdict
  createdAt: string; updatedAt: string;
}
export interface Activity {
  id: number; taskId: number; type: ActivityType; actor: Actor;
  fromStatus: Status | null; toStatus: Status | null; body: string; createdAt: string;
  actorUserId: number | null; // the human user behind a 'human' action; null for agent/system/legacy
  actorName: string | null;   // joined app_user.display_name for actorUserId; null when unattributed
}
export interface Link { id: number; taskId: number; kind: LinkKind; label: string; url: string; }
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
  metrics: TaskMetricsView;
}

export interface CreateTaskInput {
  title: string; spec: string;
  acceptanceCriteria?: string | undefined; // required unless stage is 'description' (that stage writes them)
  stage?: Stage | undefined; // default 'implementation' — clients opt into the pipeline explicitly
  workspace?: string | undefined;
}
export interface CreateWorkspaceInput { name: string; repoPath: string; }
// null clears the field, undefined leaves it untouched (matches the PATCH semantics in the web layer)
export interface UpdateWorkspaceInput { policy?: string | null | undefined; verifyCommand?: string | null | undefined; }
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
