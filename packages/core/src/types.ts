export type Status = 'backlog' | 'queued' | 'in_progress' | 'in_review' | 'done' | 'blocked';
export type Actor = 'human' | 'agent';
export type ActivityType = 'status_change' | 'comment' | 'result' | 'feedback';
export type LinkKind = 'branch' | 'pr' | 'worktree' | 'log' | 'url';

export interface Workspace { id: number; name: string; repoPath: string; createdAt: string; }

export interface Task {
  id: number; key: string; title: string; spec: string; acceptanceCriteria: string;
  status: Status; resultSummary: string | null; seq: number;
  workspace: string; // workspace slug
  claimedBy: string | null; claimedAt: string | null; // current claim; cleared on re-queue
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

export interface TaskDetail extends Task { activity: Activity[]; links: Link[]; attachments: Attachment[]; repoPath: string; metrics: TaskMetricsView; }

export interface CreateTaskInput { title: string; spec: string; acceptanceCriteria: string; workspace?: string | undefined; }
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
