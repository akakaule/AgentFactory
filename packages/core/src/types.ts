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

export interface Workspace { id: number; name: string; repoPath: string; createdAt: string; }

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
  aiReview: AiReviewSummary | null; // derived: latest ai-review comment verdict
  createdAt: string; updatedAt: string;
}
export interface Activity {
  id: number; taskId: number; type: ActivityType; actor: Actor;
  fromStatus: Status | null; toStatus: Status | null; body: string; createdAt: string;
}
export interface Link { id: number; taskId: number; kind: LinkKind; label: string; url: string; }
export interface Attachment { id: number; taskId: number; filename: string; mime: string; size: number; }

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
  metrics: TaskMetricsView;
}

export interface CreateTaskInput {
  title: string; spec: string;
  acceptanceCriteria?: string | undefined; // required unless stage is 'description' (that stage writes them)
  stage?: Stage | undefined; // default 'implementation' — clients opt into the pipeline explicitly
  workspace?: string | undefined;
}
export interface CreateWorkspaceInput { name: string; repoPath: string; }
export interface UpdateTaskInput { title?: string; spec?: string; acceptanceCriteria?: string; }
export interface LinkInput { kind: LinkKind; label: string; url: string; }
export interface SubmitResultInput { summary: string; links?: LinkInput[]; }
export interface AddTaskMetricsInput {
  model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; reportedBy?: string;
}
export interface AddAttachmentInput { filename: string; mime: string; dataBase64: string; }

export const ATTACHMENT_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export const ATTACHMENT_MAX_BYTES = 4 * 1024 * 1024;

export const RECENT_ACTIVITY_LIMIT = 50;
export const KEY_PREFIX = 'AF';
export const DEFAULT_WORKSPACE = 'default';
