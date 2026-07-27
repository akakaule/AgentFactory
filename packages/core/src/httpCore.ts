import { NotFoundError, InvalidTransitionError, ValidationError } from './errors.js';
import { GitError } from './git.js';
import type { createCore } from './index.js';

/**
 * The #45 network client: the agent-ops slice of Core, spoken over authenticated HTTP against a
 * board's /api surface (routes/agentOps.ts + the existing task/workspace reads). Same ops, same
 * typed errors — the server's errors.ts mapping is reversed here so callers keep catching
 * NotFoundError / InvalidTransitionError / ValidationError / GitError exactly as with a local core.
 *
 * Types derive from the real `createCore` binding (type-only import — erased at runtime), so this
 * surface cannot drift from core without a compile error.
 */

type SyncCore = ReturnType<typeof createCore>;
type Asyncified<T> = {
  [K in keyof T]: T[K] extends (...a: infer A) => infer R ? (...a: A) => Promise<Awaited<R>> : T[K];
};

/** Every op a remote MCP server or supervisor drives over HTTP (the §3.5 cut, verified per consumer). */
export type HttpCore = Pick<
  Asyncified<SyncCore>,
  | 'claimNextTask' | 'submitResult' | 'createTask'
  | 'reportProgress' | 'addComment' | 'updateStatus' | 'releaseClaim'
  | 'appendTranscript' | 'saveTranscript' | 'addTaskMetrics'
  | 'touchAgentSession' | 'endAgentSession' | 'listLiveAgents'
  | 'recordSupervisorHeartbeat' | 'resolveAgentPrompt' | 'resolveGitAuth' | 'getWorkspacePat'
  | 'beginDelivery' | 'recordDeliveryCheck' | 'completeDelivery' | 'failDelivery'
  | 'listTasks' | 'getTask' | 'listWorkspaces' | 'getAttachment'
>;

export interface HttpCoreOptions {
  /** Injectable fetch (tests point it at an in-process Hono `app.request`). */
  fetchImpl?: typeof fetch;
  /** Per-request abort ceiling — a hung board connection must fail, not wedge the caller. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

function errorFrom(status: number, message: string): Error {
  // reverse of packages/web/server/errors.ts
  if (status === 404) return new NotFoundError(message);
  if (status === 409) return new InvalidTransitionError(message);
  if (status === 400) return new ValidationError(message);
  if (status === 422) return new GitError(message);
  return new Error(`board request failed (${status}): ${message}`);
}

export function createHttpCore(baseUrl: string, token: string, opts: HttpCoreOptions = {}): HttpCore {
  const base = baseUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const req = async (method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> => {
    const init: RequestInit = {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    };
    const res = await fetchImpl(`${base}${path}`, init);
    if (!res.ok) {
      let message = String(res.status);
      try {
        const b = (await res.json()) as { message?: string };
        if (b && typeof b.message === 'string') message = b.message;
      } catch { /* non-JSON error body — the status carries it */ }
      throw errorFrom(res.status, message);
    }
    return res.json();
  };

  const enc = encodeURIComponent;

  return {
    // ── claim / deliver ──────────────────────────────────────────────────────
    claimNextTask: async (o = {}) => (await req('POST', '/api/agent/claim', o)) as never,
    submitResult: async (key, input) => (await req('POST', `/api/agent/tasks/${enc(key)}/submit`, input)) as never,
    createTask: async (input) => (await req('POST', '/api/agent/tasks', input)) as never,

    // ── narration / lifecycle ────────────────────────────────────────────────
    reportProgress: async (key, input) => { await req('POST', `/api/agent/tasks/${enc(key)}/progress`, input); },
    addComment: async (key, input) => (await req('POST', `/api/agent/tasks/${enc(key)}/comments`, input)) as never,
    updateStatus: async (key, status, _actor, _actorUserId, note) =>
      // the server derives the actor from the token — the local-signature actor is ignored on the wire
      (await req('POST', `/api/agent/tasks/${enc(key)}/status`, { status, note })) as never,
    releaseClaim: async (key) => (await req('POST', `/api/agent/tasks/${enc(key)}/release-claim`, {})) as never,

    // ── transcript / session / metrics ───────────────────────────────────────
    appendTranscript: async (key, input) => { await req('POST', `/api/agent/tasks/${enc(key)}/transcript`, input); },
    saveTranscript: async (key, input) => { await req('PUT', `/api/agent/tasks/${enc(key)}/transcript`, input); },
    addTaskMetrics: async (key, input) => (await req('POST', `/api/agent/tasks/${enc(key)}/metrics`, input)) as never,
    touchAgentSession: async (key) => { await req('POST', `/api/agent/tasks/${enc(key)}/session/touch`, {}); },
    endAgentSession: async (key) => { await req('POST', `/api/agent/tasks/${enc(key)}/session/end`, {}); },
    listLiveAgents: async () => (await req('GET', '/api/agent/live-agents')) as never,

    // ── supervisor surface ───────────────────────────────────────────────────
    recordSupervisorHeartbeat: async (input) => { await req('POST', '/api/agent/supervisors/heartbeat', input); },
    resolveAgentPrompt: async (key, workspace) =>
      ((await req('GET', `/api/agent/prompts/${enc(key)}?workspace=${enc(workspace)}`)) as { prompt: string }).prompt,
    resolveGitAuth: async (workspace) => (await req('GET', `/api/agent/workspaces/${enc(workspace)}/git-auth`)) as never,
    getWorkspacePat: async (workspace) =>
      ((await req('GET', `/api/agent/workspaces/${enc(workspace)}/pat`)) as { pat: string | null }).pat,

    // ── delivery (watcher) ───────────────────────────────────────────────────
    beginDelivery: async (key, seed) => (await req('POST', `/api/agent/tasks/${enc(key)}/delivery/begin`, seed)) as never,
    recordDeliveryCheck: async (key, obs) => (await req('POST', `/api/agent/tasks/${enc(key)}/delivery/check`, obs)) as never,
    completeDelivery: async (key, note) => (await req('POST', `/api/agent/tasks/${enc(key)}/delivery/complete`, { note })) as never,
    failDelivery: async (key, input) => (await req('POST', `/api/agent/tasks/${enc(key)}/delivery/fail`, input)) as never,

    // spec images ride the claim payload as MCP image blocks — the one binary read.
    // Row metadata comes back in headers; bytes are the body.
    getAttachment: async (id) => {
      const res = await fetchImpl(`${base}/api/attachments/${id}`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw errorFrom(res.status, String(res.status));
      return {
        id,
        taskId: Number(res.headers.get('x-attachment-task-id') ?? -1),
        filename: decodeURIComponent(res.headers.get('x-attachment-filename') ?? ''),
        mime: res.headers.get('content-type') ?? 'application/octet-stream',
        bytes: new Uint8Array(await res.arrayBuffer()),
      };
    },

    // ── reads (existing board routes, same guard) ────────────────────────────
    listTasks: async (o = {}) => {
      const q = new URLSearchParams();
      if (o.status) q.set('status', o.status);
      if (o.workspace) q.set('workspace', o.workspace);
      if (o.archived !== undefined) q.set('archived', String(o.archived));
      const qs = q.toString();
      return (await req('GET', `/api/tasks${qs ? `?${qs}` : ''}`)) as never;
    },
    getTask: async (key) => (await req('GET', `/api/tasks/${enc(key)}`)) as never,
    listWorkspaces: async () => (await req('GET', '/api/workspaces')) as never,
  };
}
