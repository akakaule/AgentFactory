import type { Task, TaskDetail, Activity, Status } from './types.js';

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
  listTasks: (status?: Status) => req<Task[]>(`/api/tasks${status ? `?status=${status}` : ''}`),
  getTask: (key: string) => req<TaskDetail>(`/api/tasks/${key}`),
  createTask: (b: { title: string; spec: string; acceptanceCriteria: string }) => req<Task>('/api/tasks', body(b)),
  updateTask: (key: string, b: { title?: string; spec?: string; acceptanceCriteria?: string }) => req<Task>(`/api/tasks/${key}`, { method: 'PATCH', body: JSON.stringify(b) }),
  addComment: (key: string, commentBody: string) => req<Activity>(`/api/tasks/${key}/comment`, body({ body: commentBody })),
  setStatus: (key: string, status: Status) => req<TaskDetail>(`/api/tasks/${key}/status`, body({ status })),
  approve: (key: string) => req<TaskDetail>(`/api/tasks/${key}/approve`, body({})),
  requestChanges: (key: string, feedback: string) => req<TaskDetail>(`/api/tasks/${key}/request-changes`, body({ feedback })),
};
