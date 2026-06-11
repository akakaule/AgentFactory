import type { Task, TaskDetail, Activity, Status, Workspace } from './types.js';
import type { AnalyticsData } from './metrics.js';

export interface TaskDiff { branch: string; baseRef: string; diff: string; commits: number; }
export interface MetricsReport { model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; reportedBy?: string; }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init?.body ? { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } } : init);
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const b = await res.json(); msg = (b as any).message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
const body = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) });

export const api = {
  listTasks: (opts: { status?: Status; workspace?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.workspace) q.set('workspace', opts.workspace);
    const qs = q.toString();
    return req<Task[]>(`/api/tasks${qs ? `?${qs}` : ''}`);
  },
  getTask: (key: string) => req<TaskDetail>(`/api/tasks/${key}`),
  getDiff: (key: string) => req<TaskDiff>(`/api/tasks/${key}/diff`),
  getAnalytics: () => req<AnalyticsData>('/api/analytics'),
  postMetrics: (key: string, b: MetricsReport) => req<TaskDetail>(`/api/tasks/${key}/metrics`, body(b)),
  createTask: (b: { title: string; spec: string; acceptanceCriteria: string; workspace?: string }) => req<Task>('/api/tasks', body(b)),
  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),
  createWorkspace: (b: { name: string; repoPath: string }) => req<Workspace>('/api/workspaces', body(b)),
  updateTask: (key: string, b: { title?: string; spec?: string; acceptanceCriteria?: string }) => req<Task>(`/api/tasks/${key}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteTask: (key: string) => req<void>(`/api/tasks/${key}`, { method: 'DELETE' }),
  addComment: (key: string, commentBody: string) => req<Activity>(`/api/tasks/${key}/comment`, body({ body: commentBody })),
  setStatus: (key: string, status: Status) => req<TaskDetail>(`/api/tasks/${key}/status`, body({ status })),
  approve: (key: string) => req<TaskDetail>(`/api/tasks/${key}/approve`, body({})),
  requestChanges: (key: string, feedback: string) => req<TaskDetail>(`/api/tasks/${key}/request-changes`, body({ feedback })),
};
