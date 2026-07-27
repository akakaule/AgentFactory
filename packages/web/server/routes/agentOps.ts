import { Hono } from 'hono';
import { z } from 'zod';
import { ValidationError } from '@agentfactory/core';
import type { Core } from '../types.js';
import { validated } from '../validate.js';
import { requireService, requireSupervisor, principalOf } from '../auth.js';

// Wire shapes for the ops core does NOT re-validate itself (heartbeat, progress, transcript,
// delivery observations) — without these a malformed body surfaced as a 500, not a 400.
// `.passthrough()` keeps core the authority on any extra fields it knows about.
const claimBody = z.object({ workspace: z.string().min(1).optional(), claimedBy: z.string().min(1).optional() });
const progressBody = z.object({
  message: z.string().min(1).max(500),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
});
const agentCommentBody = z.object({ body: z.string().min(1) });
const agentStatusBody = z.object({ status: z.string().min(1), note: z.string().optional() });
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
  r.use('*', requireService);

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
    const claim = core.claimNextTask({ workspace: b.workspace, claimedBy: b.claimedBy });
    return c.json(claim); // null = queue empty (the caller's idle signal, not an error)
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
    const input: Parameters<Core['reportProgress']>[1] = { message: b.message }; // explicit build for exactOptionalPropertyTypes
    if (b.tokensIn !== undefined) input.tokensIn = b.tokensIn;
    if (b.tokensOut !== undefined) input.tokensOut = b.tokensOut;
    core.reportProgress(c.req.param('key'), input);
    return c.json({ ok: true });
  });

  r.post('/tasks/:key/comments', validated('json', agentCommentBody), (c) =>
    c.json(core.addComment(c.req.param('key'), { actor: 'agent', body: c.req.valid('json').body }), 201));

  r.post('/tasks/:key/status', validated('json', agentStatusBody), (c) => {
    const b = c.req.valid('json');
    return c.json(core.updateStatus(c.req.param('key'), b.status as Parameters<Core['updateStatus']>[1], 'agent', null, b.note));
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

  // ── supervisor surface ─────────────────────────────────────────────────────
  // the system recovery edge (reaper) — NOT an agent in_progress→queued transition
  r.post('/tasks/:key/release-claim', requireSupervisor, (c) => c.json(core.releaseClaim(c.req.param('key'))));

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
