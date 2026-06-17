import type { Task, TaskDetail, Activity, Status, Stage, Workspace, Attachment, AgentSessionView, TelemetryEvent } from './types.js';
import type { AnalyticsData } from './metrics.js';

export interface TaskDiff { branch: string; baseRef: string; diff: string; commits: number; }
export interface MetricsReport { model?: string; tokensIn?: number; tokensOut?: number; costUsd?: number; reportedBy?: string; }
export interface WhoAmI { kind: 'user' | 'service' | 'anon'; userId?: number; email?: string; displayName?: string; label?: string; }

// Bearer token for token-mode (remote/phone) deployments — persisted in localStorage and
// sent on every request. Absent in local none-mode, so all of this stays inert there.
const TOKEN_KEY = 'af_token';
let token: string | null = (() => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } })();
export function getToken(): string | null { return token; }
export function setToken(t: string | null): void {
  token = t && t.trim() ? t.trim() : null;
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* private mode */ }
}

// The app registers a handler so a 401 (token required / expired) surfaces the sign-in gate.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void): void { onUnauthorized = fn; }

// EventSource cannot set an Authorization header — carry the token on the query string.
export function eventsUrl(): string { return token ? `/events?access_token=${encodeURIComponent(token)}` : '/events'; }

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
  if (init?.body) headers['content-type'] = 'application/json';
  if (token) headers['authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) {
    let msg = `${res.status}`;
    try { const b = await res.json(); msg = (b as any).message ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
const body = (b: unknown) => ({ method: 'POST', body: JSON.stringify(b) });

export const attachmentUrl = (id: number) => `/api/attachments/${id}`;

export const api = {
  listTasks: (opts: { status?: Status; workspace?: string; archived?: boolean } = {}) => {
    const q = new URLSearchParams();
    if (opts.status) q.set('status', opts.status);
    if (opts.workspace) q.set('workspace', opts.workspace);
    if (opts.archived) q.set('archived', 'true');
    const qs = q.toString();
    return req<Task[]>(`/api/tasks${qs ? `?${qs}` : ''}`);
  },
  getTask: (key: string) => req<TaskDetail>(`/api/tasks/${key}`),
  getDiff: (key: string) => req<TaskDiff>(`/api/tasks/${key}/diff`),
  getAnalytics: () => req<AnalyticsData>('/api/analytics'),
  whoami: () => req<WhoAmI>('/auth/whoami'),
  listAgents: () => req<AgentSessionView[]>('/api/agents'),
  listTelemetry: (opts: { limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.limit) q.set('limit', String(opts.limit));
    const qs = q.toString();
    return req<TelemetryEvent[]>(`/api/telemetry${qs ? `?${qs}` : ''}`);
  },
  addAttachment: (key: string, b: { filename: string; mime: string; dataBase64: string }) =>
    req<Attachment>(`/api/tasks/${key}/attachments`, body(b)),
  deleteAttachment: (id: number) => req<void>(`/api/attachments/${id}`, { method: 'DELETE' }),
  postMetrics: (key: string, b: MetricsReport) => req<TaskDetail>(`/api/tasks/${key}/metrics`, body(b)),
  createTask: (b: { title: string; spec: string; acceptanceCriteria?: string; stage?: Stage; workspace?: string }) => req<Task>('/api/tasks', body(b)),
  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),
  createWorkspace: (b: { name: string; repoPath: string }) => req<Workspace>('/api/workspaces', body(b)),
  updateWorkspace: (name: string, b: { policy?: string | null; verifyCommand?: string | null }) =>
    req<Workspace>(`/api/workspaces/${name}`, { method: 'PATCH', body: JSON.stringify(b) }),
  updateTask: (key: string, b: { title?: string; spec?: string; acceptanceCriteria?: string }) => req<Task>(`/api/tasks/${key}`, { method: 'PATCH', body: JSON.stringify(b) }),
  deleteTask: (key: string) => req<void>(`/api/tasks/${key}`, { method: 'DELETE' }),
  addComment: (key: string, commentBody: string) => req<Activity>(`/api/tasks/${key}/comment`, body({ body: commentBody })),
  setStatus: (key: string, status: Status) => req<TaskDetail>(`/api/tasks/${key}/status`, body({ status })),
  archive: (key: string) => req<TaskDetail>(`/api/tasks/${key}/archive`, body({})),
  unarchive: (key: string) => req<TaskDetail>(`/api/tasks/${key}/unarchive`, body({})),
  archiveDone: (b: { workspace?: string } = {}) => req<{ archived: number }>('/api/tasks/archive-done', body(b)),
  approve: (key: string) => req<TaskDetail>(`/api/tasks/${key}/approve`, body({})),
  requestChanges: (key: string, feedback: string) => req<TaskDetail>(`/api/tasks/${key}/request-changes`, body({ feedback })),
};
