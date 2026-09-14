import { Hono } from 'hono';
import { z } from 'zod';
import { AGENT_CAPABILITIES, ValidationError } from '@agentfactory/core';
import type { Core } from '../types.js';
import { validated } from '../validate.js';
import { requireService, requireSupervisor, principalOf } from '../auth.js';

// Wire shapes for the ops core does NOT re-validate itself (heartbeat, progress, transcript,
// delivery observations) — without these a malformed body surfaced as a 500, not a 400.
// `.passthrough()` keeps core the authority on any extra fields it knows about.
const claimBody = z.object({ workspace: z.string().min(1).optional(), claimedBy: z.string().min(1).optional(), executionId: z.string().min(1).optional() });
const progressBody = z.object({
  executionId: z.string().min(1).optional(),
  message: z.string().min(1).max(500),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
});
const agentCommentBody = z.object({ body: z.string().min(1), executionId: z.string().min(1).optional() });
const agentStatusBody = z.object({ status: z.string().min(1), note: z.string().optional(), executionId: z.string().min(1).optional() });
const releaseClaimBody = z.object({ executionId: z.string().min(1).optional() });
const transcriptAppendBody = z.object({ chunk: z.string().min(1), attempt: z.number().int().positive().optional(), sessionId: z.string().nullable().optional(), engine: z.string().optional() }).passthrough();
const transcriptSaveBody = z.object({ raw: z.string().min(1), attempt: z.number().int().positive().optional(), sessionId: z.string().nullable().optional(), engine: z.string().optional() }).passthrough();
const heartbeatBody = z.object({
  name: z.string().min(1), kind: z.enum(['dispatcher', 'reviewer', 'watcher']),
  workspaces: z.array(z.string()), inFlight: z.number().int().nonnegative(), capacity: z.number().int().nonnegative(),
  pollSeconds: z.number().nullable().optional(), version: z.string().nullable().optional(),
});
const deliveryBeginBody = z.object({ provider: z.enum(['github', 'azdo']), branch: z.string().min(1), prUrl: z.string().nullable().optional() });
const deliveryCheckBody = z.object({
  prUrl: z.string().nullable(), prId: z.string().nullable(),
  prState: z.string(), checksState: z.string(),
  failing: z.array(z.object({ name: z.string(), url: z.string().nullable() })),
}).passthrough();
const deliveryCompleteBody = z.object({ note: z.string() });
const deliveryFailBody = z.object({ reason: z.string().min(1), detail: z.string(), body: z.string().optional() }).passthrough();
const retryReserveBody = z.object({ operation: z.string().min(1), maxAttempts: z.number().int().positive() });
const retryReconcileBody = z.object({ actualKey: z.string().min(1), operation: z.string().min(1), maxAttempts: z.number().int().positive() });
const retryReconcileAbandonedBody = z.object({ graceMs: z.number().finite().nonnegative() });
const retryRecordFailureBody = z.object({ operation: z.string().min(1), maxAttempts: z.number().int().positive(), attempt: z.number().int().positive(), reason: z.string() });
const retrySettleBody = z.object({ state: z.enum(['running', 'succeeded', 'failed', 'cancelled']), reason: z.string().optional() });
const executionReconcileBody = z.object({ graceMs: z.number().finite().nonnegative() });

type AgentOpsCore = Core & {
  reportProgress(key: string, input: { message: string; tokensIn?: number; tokensOut?: number; executionId?: string }): void;
  reserveExecution(key: string, input: { operation: string; maxAttempts: number; owner?: string | null; startImmediately?: boolean }): unknown;
  reconcileExecutions(graceMs: number): number;
  touchExecution(id: string): boolean;
  reserveRetry(key: string, input: { operation: string; maxAttempts: number }): unknown;
  reconcileRetry(id: string, input: { actualKey: string; operation: string; maxAttempts: number }): unknown;
  reconcileAbandonedRetryReservations(graceMs: number): number;
  getRetryBudget(key: string, operation: string): unknown;
  recordRetryFailure(key: string, input: { operation: string; maxAttempts: number; attempt: number; reason: string }): void;
  settleRetry(id: string, input: { state: 'running' | 'succeeded' | 'failed' | 'cancelled'; reason?: string | undefined }): boolean;
  releaseClaim(key: string, now?: () => string, executionId?: string): unknown;
};

/**
 * The agent-ops surface (#45): every board operation a worker MCP session or a remote supervisor
 * needs, over authenticated HTTP. Service tokens only (enforced router-wide); the `human|agent`
 * actor axis is fixed server-side — every op here runs as `actor: 'agent'` (or as the dedicated
 * system op), so a network caller can never assert an actor.
 *
 * Explicit REST routes (not generic RPC) keep per-route authorization a static, auditable table.
 * Bodies are deliberately passed through to core, whose own zod schemas are the single source of
 * validation truth (the same contract the in-process MCP server relies on); malformed input
 * surfaces as a core ValidationError → 400 via mapError.
 *
 * Reads (listTasks / getTask / listWorkspaces) are NOT duplicated here — service tokens use the
 * existing /api/tasks and /api/workspaces routes behind the same guard.
 */
export function agentOpsRoutes(core: Core): Hono {
  const r = new Hono();
  const agentCore = core as AgentOpsCore;
  r.use('*', requireService);

  // ── identity probe ─────────────────────────────────────────────────────────
  // Lets a remote supervisor fail fast at STARTUP when its token lacks the supervisor
  // capability, instead of surfacing as a 403 mid-tick on release-claim/delivery (#46).
  r.get('/whoami', (c) => {
    const p = principalOf(c); // requireService guarantees kind === 'service'
    return c.json({ label: p.kind === 'service' ? p.label : '', supervisor: p.kind === 'service' && p.supervisor, capabilities: AGENT_CAPABILITIES });
  });

  const body = async <T = Record<string, unknown>>(c: { req: { json(): Promise<unknown> } }): Promise<T> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      throw new ValidationError('a JSON body is required');
    }
  };

  // ── claim / deliver ────────────────────────────────────────────────────────
  r.post('/claim', validated('json', claimBody), (c) => {
    const b = c.req.valid('json');
    const input: Parameters<Core['claimNextTask']>[0] = {};
    if (b.workspace !== undefined) input.workspace = b.workspace;
    if (b.claimedBy !== undefined) input.claimedBy = b.claimedBy;
    if (b.executionId !== undefined) input.executionId = b.executionId;
    const claim = core.claimNextTask(input);
    return c.json(claim); // null = queue empty (the caller's idle signal, not an error)
  });

  r.post('/tasks/:key/execution/reserve', async (c) => {
    const b = await body<{ operation: string; maxAttempts: number; owner?: string | null; startImmediately?: boolean }>(c);
    return c.json(agentCore.reserveExecution(c.req.param('key'), b));
  });

  r.post('/tasks/:key/submit', async (c) =>
    c.json(core.submitResult(c.req.param('key'), await body<Parameters<Core['submitResult']>[1]>(c))));

  // agent-proposed follow-up work — backlog-only by core rule; actor pinned server-side
  r.post('/tasks', async (c) => {
    const b = await body<Record<string, unknown>>(c);
    return c.json(core.createTask({ ...(b as object), actor: 'agent' } as Parameters<Core['createTask']>[0]), 201);
  });

  // ── in-flight narration ────────────────────────────────────────────────────
  r.post('/tasks/:key/progress', validated('json', progressBody), (c) => {
    const b = c.req.valid('json');
    const input: Parameters<AgentOpsCore['reportProgress']>[1] = { message: b.message }; // explicit build for exactOptionalPropertyTypes
    if (b.executionId !== undefined) input.executionId = b.executionId;
    if (b.tokensIn !== undefined) input.tokensIn = b.tokensIn;
    if (b.tokensOut !== undefined) input.tokensOut = b.tokensOut;
    agentCore.reportProgress(c.req.param('key'), input);
    return c.json({ ok: true });
  });

  r.post('/tasks/:key/comments', validated('json', agentCommentBody), (c) => {
    const b = c.req.valid('json');
    return c.json(agentCore.addComment(c.req.param('key'), { actor: 'agent', body: b.body, ...(b.executionId ? { executionId: b.executionId } : {}) }), 201);
  });

  r.post('/tasks/:key/status', validated('json', agentStatusBody), (c) => {
    const b = c.req.valid('json');
    return c.json(core.updateStatus(c.req.param('key'), b.status as Parameters<Core['updateStatus']>[1], 'agent', null, b.note, b.executionId));
  });
  r.post('/executions/reconcile', validated('json', executionReconcileBody), (c) =>
    c.json({ count: agentCore.reconcileExecutions(c.req.valid('json').graceMs) }));
  r.post('/executions/:id/touch', (c) => {
    return c.json({ touched: agentCore.touchExecution(c.req.param('id')) });
  });

  // ── transcript / session / metrics ─────────────────────────────────────────
  r.post('/tasks/:key/transcript', validated('json', transcriptAppendBody), (c) => {
    core.appendTranscript(c.req.param('key'), c.req.valid('json') as Parameters<Core['appendTranscript']>[1]);
    return c.json({ ok: true });
  });
  r.put('/tasks/:key/transcript', validated('json', transcriptSaveBody), (c) => {
    core.saveTranscript(c.req.param('key'), c.req.valid('json') as Parameters<Core['saveTranscript']>[1]);
    return c.json({ ok: true });
  });

  r.post('/tasks/:key/metrics', async (c) =>
    c.json(core.addTaskMetrics(c.req.param('key'), await body<Parameters<Core['addTaskMetrics']>[1]>(c)), 201));

  r.post('/tasks/:key/session/touch', (c) => {
    core.touchAgentSession(c.req.param('key'));
    return c.json({ ok: true });
  });
  r.post('/tasks/:key/session/end', (c) => {
    core.endAgentSession(c.req.param('key'));
    return c.json({ ok: true });
  });

  // ── durable retry accounting ─────────────────────────────────────────────
  // Reservation/settlement is service-scoped so the plain reviewer token can use its own budget;
  // the operation name is supplied by the supervisor and core stores the decision atomically.
  r.post('/tasks/:key/retry/reserve', validated('json', retryReserveBody), (c) =>
    c.json(agentCore.reserveRetry(c.req.param('key'), c.req.valid('json'))));
  r.post('/retry/:id/reconcile', validated('json', retryReconcileBody), (c) =>
    c.json(agentCore.reconcileRetry(c.req.param('id'), c.req.valid('json'))));
  r.post('/retry/reconcile-abandoned', validated('json', retryReconcileAbandonedBody), (c) =>
    c.json({ count: agentCore.reconcileAbandonedRetryReservations(c.req.valid('json').graceMs) }));
  r.get('/tasks/:key/retry', (c) => {
    const operation = c.req.query('operation');
    if (!operation) throw new ValidationError('retry operation query parameter is required');
    return c.json(agentCore.getRetryBudget(c.req.param('key'), operation));
  });
  r.post('/tasks/:key/retry/record-failure', validated('json', retryRecordFailureBody), (c) => {
    agentCore.recordRetryFailure(c.req.param('key'), c.req.valid('json'));
    return c.json({ ok: true });
  });
  r.post('/retry/:id/settle', validated('json', retrySettleBody), (c) =>
    c.json({ settled: agentCore.settleRetry(c.req.param('id'), c.req.valid('json')) }));

  // ── supervisor surface ─────────────────────────────────────────────────────
  // the system recovery edge (reaper) — NOT an agent in_progress→queued transition
  r.post('/tasks/:key/release-claim', requireSupervisor, validated('json', releaseClaimBody), (c) => {
    const executionId = c.req.valid('json').executionId;
    return c.json(agentCore.releaseClaim(c.req.param('key'), undefined, executionId));
  });

  r.post('/supervisors/heartbeat', validated('json', heartbeatBody), (c) => {
    core.recordSupervisorHeartbeat(c.req.valid('json') as Parameters<Core['recordSupervisorHeartbeat']>[0]);
    return c.json({ ok: true });
  });

  r.get('/live-agents', (c) => c.json(core.listLiveAgents()));

  r.get('/prompts/:key', (c) => {
    const workspace = c.req.query('workspace');
    if (!workspace) throw new ValidationError('workspace query parameter is required');
    return c.json({ prompt: core.resolveAgentPrompt(c.req.param('key') as Parameters<Core['resolveAgentPrompt']>[0], workspace) });
  });

  // ── secrets (service-only + audited) ───────────────────────────────────────
  // Workspace credentials leave the box here and nowhere else. Every read is logged with the
  // calling principal; a durable audit sink (workspace-scoped activity) belongs to #39.
  const audit = (c: { req: { path: string } }, what: string, workspace: string): void => {
    const p = principalOf(c as never);
    const label = p.kind === 'service' ? p.label : p.kind;
    console.log(`[audit] ${what} read for workspace '${workspace}' by service token '${label}'`);
  };

  r.get('/workspaces/:name/git-auth', (c) => {
    const name = c.req.param('name');
    audit(c, 'git-auth', name);
    return c.json(core.resolveGitAuth(name)); // GitAuth | null
  });

  r.get('/workspaces/:name/pat', requireSupervisor, (c) => {
    const name = c.req.param('name');
    audit(c, 'workspace PAT', name);
    return c.json({ pat: core.getWorkspacePat(name) });
  });

  // ── delivery (watcher) ─────────────────────────────────────────────────────
  r.post('/tasks/:key/delivery/begin', requireSupervisor, validated('json', deliveryBeginBody), (c) => {
    const b = c.req.valid('json');
    return c.json(core.beginDelivery(c.req.param('key'), { provider: b.provider, branch: b.branch, ...(b.prUrl !== undefined ? { prUrl: b.prUrl } : {}) }));
  });
  r.post('/tasks/:key/delivery/check', requireSupervisor, validated('json', deliveryCheckBody), (c) =>
    c.json(core.recordDeliveryCheck(c.req.param('key'), c.req.valid('json') as Parameters<Core['recordDeliveryCheck']>[1])));
  r.post('/tasks/:key/delivery/complete', requireSupervisor, validated('json', deliveryCompleteBody), (c) =>
    c.json(core.completeDelivery(c.req.param('key'), c.req.valid('json').note)));
  r.post('/tasks/:key/delivery/fail', requireSupervisor, validated('json', deliveryFailBody), (c) =>
    c.json(core.failDelivery(c.req.param('key'), c.req.valid('json') as Parameters<Core['failDelivery']>[1])));

  return r;
}
