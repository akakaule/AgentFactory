import { Hono } from 'hono';
import { ValidationError } from '@agentfactory/core';
import type { Core } from '../types.js';
import { requireService, principalOf } from '../auth.js';

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
  r.post('/claim', async (c) => {
    const b = await body<{ workspace?: string; claimedBy?: string }>(c);
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
  r.post('/tasks/:key/progress', async (c) => {
    core.reportProgress(c.req.param('key'), await body<Parameters<Core['reportProgress']>[1]>(c));
    return c.json({ ok: true });
  });

  r.post('/tasks/:key/comments', async (c) => {
    const b = await body<{ body: string }>(c);
    return c.json(core.addComment(c.req.param('key'), { actor: 'agent', body: b.body }), 201);
  });

  r.post('/tasks/:key/status', async (c) => {
    const b = await body<{ status: string; note?: string }>(c);
    return c.json(core.updateStatus(c.req.param('key'), b.status as Parameters<Core['updateStatus']>[1], 'agent', null, b.note));
  });

  // ── transcript / session / metrics ─────────────────────────────────────────
  r.post('/tasks/:key/transcript', async (c) => {
    core.appendTranscript(c.req.param('key'), await body<Parameters<Core['appendTranscript']>[1]>(c));
    return c.json({ ok: true });
  });
  r.put('/tasks/:key/transcript', async (c) => {
    core.saveTranscript(c.req.param('key'), await body<Parameters<Core['saveTranscript']>[1]>(c));
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
  r.post('/tasks/:key/release-claim', (c) => c.json(core.releaseClaim(c.req.param('key'))));

  r.post('/supervisors/heartbeat', async (c) => {
    core.recordSupervisorHeartbeat(await body<Parameters<Core['recordSupervisorHeartbeat']>[0]>(c));
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

  r.get('/workspaces/:name/pat', (c) => {
    const name = c.req.param('name');
    audit(c, 'workspace PAT', name);
    return c.json({ pat: core.getWorkspacePat(name) });
  });

  // ── delivery (watcher) ─────────────────────────────────────────────────────
  r.post('/tasks/:key/delivery/begin', async (c) =>
    c.json(core.beginDelivery(c.req.param('key'), await body<Parameters<Core['beginDelivery']>[1]>(c))));
  r.post('/tasks/:key/delivery/check', async (c) =>
    c.json(core.recordDeliveryCheck(c.req.param('key'), await body<Parameters<Core['recordDeliveryCheck']>[1]>(c))));
  r.post('/tasks/:key/delivery/complete', async (c) => {
    const b = await body<{ note: string }>(c);
    return c.json(core.completeDelivery(c.req.param('key'), b.note));
  });
  r.post('/tasks/:key/delivery/fail', async (c) =>
    c.json(core.failDelivery(c.req.param('key'), await body<Parameters<Core['failDelivery']>[1]>(c))));

  return r;
}
