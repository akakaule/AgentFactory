export type Status = 'backlog' | 'queued' | 'in_progress' | 'in_review' | 'done' | 'blocked';
export type Actor = 'human' | 'agent';
export type ActivityType = 'status_change' | 'comment' | 'result' | 'feedback';
export type LinkKind = 'branch' | 'pr' | 'worktree' | 'log' | 'url';

export interface Workspace { id: number; name: string; repoPath: string; createdAt: string; }

export interface Task {
  id: number; key: string; title: string; spec: string; acceptanceCriteria: string;
  status: Status; resultSummary: string | null; seq: number;
  workspace: string; // workspace slug
  createdAt: string; updatedAt: string;
}
export interface Activity {
  id: number; taskId: number; type: ActivityType; actor: Actor;
  fromStatus: Status | null; toStatus: Status | null; body: string; createdAt: string;
}
export interface Link { id: number; taskId: number; kind: LinkKind; label: string; url: string; }
export interface TaskDetail extends Task { activity: Activity[]; links: Link[]; repoPath: string; }

export interface CreateTaskInput { title: string; spec: string; acceptanceCriteria: string; workspace?: string | undefined; }
export interface CreateWorkspaceInput { name: string; repoPath: string; }
export interface UpdateTaskInput { title?: string; spec?: string; acceptanceCriteria?: string; }
export interface LinkInput { kind: LinkKind; label: string; url: string; }
export interface SubmitResultInput { summary: string; links?: LinkInput[]; }

export const RECENT_ACTIVITY_LIMIT = 50;
export const KEY_PREFIX = 'AF';
export const DEFAULT_WORKSPACE = 'default';
