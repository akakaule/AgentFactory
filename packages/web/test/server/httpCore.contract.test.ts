import { describe, it, expect, beforeEach } from 'vitest';
import { openCore, createHttpCore, NotFoundError, InvalidTransitionError, ValidationError, type HttpCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

/**
 * #45 acceptance: createHttpCore against an in-process buildApp(core) behaves like the local core —
 * same results, same typed errors. This is the contract the remote MCP server and Phase 2
 * supervisors depend on.
 */

type Core = ReturnType<typeof openCore>;

describe('createHttpCore ⇄ buildApp contract', () => {
  let core: Core;
  let http: HttpCore;

  beforeEach(() => {
    core = openCore(':memory:');
    const app = buildApp(core, { auth: { mode: 'token' } });
    // supervisor-scoped: the contract covers the full HttpCore surface incl. release/PAT ops
    const token = core.createApiToken({ label: 'remote-supervisor', isService: true, isSupervisor: true }).token;
    http = createHttpCore('http://board', token, {
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => app.request(url as string, init)) as typeof fetch,
    });
  });

  it('preserves dispatched task and stage constraints over HTTP', async () => {
    const first = core.createTask({ title: 'First', spec: 's', acceptanceCriteria: 'a' });
    const plan = core.createTask({ title: 'Plan', spec: 's', acceptanceCriteria: 'a', stage: 'plan' });
    core.updateStatus(first.key, 'queued', 'human');
    core.updateStatus(plan.key, 'queued', 'human');
    expect(await http.claimNextTask({ taskKey: plan.key, stage: 'implementation' })).toBeNull();
    expect((await http.claimNextTask({ taskKey: plan.key, stage: 'plan' }))?.key).toBe(plan.key);
    expect(core.getTask(first.key).status).toBe('queued');
  });

  it('claims, narrates, and submits a task exactly like a local core', async () => {
    const t = core.createTask({ title: 'Remote work', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');

    const claim = await http.claimNextTask({ claimedBy: 'remote-1' });
    expect(claim?.key).toBe(t.key);
    expect(claim?.status).toBe('in_progress');
    expect(claim?.branchCreated).toBe(true);

    await http.reportProgress(t.key, { message: 'working' });
    await http.addComment(t.key, { actor: 'agent', body: 'halfway' });
    await http.touchAgentSession(t.key);

    const detail = await http.submitResult(t.key, { summary: 'done', links: [{ kind: 'branch', label: 'feature/x', url: 'http://x' }] });
    expect(detail.status).toBe('in_review');
    expect(detail.resultSummary).toBe('done');

    // the same rows are visible to the local core — one DB, one truth
    expect(core.getTask(t.key).status).toBe('in_review');
  });

  it('an empty queue resolves null', async () => {
    expect(await http.claimNextTask()).toBeNull();
  });

  it('completes a merged blocked delivery over HTTP and preserves the stale-observation guard', async () => {
    const task = core.createTask({ title: 'Delivery repair', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(task.key, 'queued', 'human');
    const claim = core.claimNextTask({ claimedBy: 'repair-worker' })!;
    core.submitResult(task.key, { summary: 'done' });
    core.updateStatus(task.key, 'delivering', 'human');
    core.beginDelivery(task.key, { provider: 'github', branch: claim.branch! });
    core.failDelivery(task.key, { reason: 'ci_failed', detail: 'formatting' });
    core.claimNextTask({ claimedBy: 'repair-worker' });
    core.updateStatus(task.key, 'blocked', 'agent', 'setup failed');
    const before = core.getTask(task.key);
    const expected = { status: before.status, branch: before.delivery!.branch,
      prUrl: before.delivery!.prUrl, stateChangedAt: before.delivery!.stateChangedAt };
    const observation = { expected, prUrl: 'https://github.com/acme/widgets/pull/42', prId: '#42',
      prState: 'merged' as const, checksState: 'failing' as const, failing: [{ name: 'verify', url: null }] };
    expect((await http.recordDeliveryCheck(task.key, observation)).changed).toBe(true);
    expect((await http.getTask(task.key)).status).toBe('done');
    // Old poll still has a null PR URL. It must not overwrite the observation just stored.
    expect(await http.recordDeliveryCheck(task.key, { ...observation, prState: 'open' })).toMatchObject({ skipped: true });
    expect((await http.getTask(task.key)).delivery?.prState).toBe('merged');
  });

  it('reads round-trip: listTasks filters, getTask, listWorkspaces', async () => {
    core.createWorkspace({ name: 'shop', repoPath: '/repo' });
    const a = core.createTask({ title: 'A', spec: 'S', acceptanceCriteria: 'A', workspace: 'shop' });
    core.updateStatus(a.key, 'queued', 'human');
    core.createTask({ title: 'B', spec: 'S', acceptanceCriteria: 'A' });

    expect((await http.listTasks({ status: 'queued', workspace: 'shop' })).map((t) => t.key)).toEqual([a.key]);
    expect((await http.getTask(a.key)).title).toBe('A');
    expect((await http.listWorkspaces()).map((w) => w.name)).toContain('shop');
  });

  it('surfaces core errors as the same typed errors', async () => {
    await expect(http.getTask('AF-9999')).rejects.toBeInstanceOf(NotFoundError);
    await expect(http.releaseClaim('AF-9999')).rejects.toBeInstanceOf(NotFoundError);

    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    await expect(http.releaseClaim(t.key)).rejects.toBeInstanceOf(InvalidTransitionError); // backlog, not in_progress
    await expect(http.updateStatus(t.key, 'done', 'agent')).rejects.toBeInstanceOf(InvalidTransitionError);
    await expect(http.createTask({ title: '', spec: '' } as never)).rejects.toBeInstanceOf(ValidationError);
  });

  it('supervisor surface: heartbeat, prompt, git-auth, PAT, release', async () => {
    core.createWorkspace({ name: 'shop', repoPath: '/repo' });
    core.updateWorkspace('shop', { pat: 'sekret' });

    await http.recordSupervisorHeartbeat({ name: 'remote-d', kind: 'dispatcher', workspaces: ['shop'], inFlight: 0, capacity: 2, pollSeconds: 15 });
    expect(core.listSupervisors().map((s) => s.name)).toContain('remote-d');

    expect(typeof (await http.resolveAgentPrompt('worker', 'shop'))).toBe('string');
    core.setEngineSettings({ codex: { enabled: false } });
    expect(await http.getEngineSettings()).toEqual({ claude: { enabled: true }, codex: { enabled: false } });
    expect(await http.getWorkspacePat('shop')).toBe('sekret');
    await http.resolveGitAuth('shop'); // GitAuth | null — must not throw

    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', workspace: 'shop' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ workspace: 'shop', claimedBy: 'w1' });
    const released = await http.releaseClaim(t.key);
    expect(released.status).toBe('queued');
  });

  it('transcript + metrics land in the same stores the board reads', async () => {
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');
    await http.claimNextTask({ claimedBy: 'w1' });

    await http.appendTranscript(t.key, { attempt: 1, sessionId: 's1', engine: 'claude', chunk: '{"type":"x"}\n' });
    await http.saveTranscript(t.key, { attempt: 1, sessionId: 's1', engine: 'claude', raw: '{"type":"x"}\n' });
    await http.addTaskMetrics(t.key, { model: 'claude-fable-5', tokensIn: 100, tokensOut: 50 });

    const detail = core.getTask(t.key);
    expect(detail.metrics.tokensIn).toBe(100);
  });

  it('attachVisualization posts raw text/html and round-trips typed errors', async () => {
    const doc = '<!doctype html>\n<html><body>viz</body></html>';
    const t = core.createTask({ title: 'Viz', spec: 'S', acceptanceCriteria: 'A' });

    const meta = await http.attachVisualization(t.key, { html: doc });
    expect(meta.bytes).toBe(doc.length);
    expect(typeof meta.generatedAt).toBe('string');
    expect(core.getVisualizationHtml(t.key)).toBe(doc); // same store the board reads

    await expect(http.attachVisualization('AF-9999', { html: doc })).rejects.toBeInstanceOf(NotFoundError);
    await expect(http.attachVisualization(t.key, { html: '   ' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('whoami reports the token identity and supervisor capability', async () => {
    expect(await http.whoami()).toEqual({ label: 'remote-supervisor', supervisor: true });

    const plain = core.createApiToken({ label: 'plain-worker', isService: true }).token;
    const app = buildApp(core, { auth: { mode: 'token' } });
    const asPlain = createHttpCore('http://board', plain, {
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => app.request(url as string, init)) as typeof fetch,
    });
    expect(await asPlain.whoami()).toEqual({ label: 'plain-worker', supervisor: false });
  });

  it('whoami refuses user tokens (service-only surface)', async () => {
    const u = core.createUser({ email: 'h@x', displayName: 'H' });
    const userToken = core.createApiToken({ userId: u.id, label: 'human' }).token;
    const app = buildApp(core, { auth: { mode: 'token' } });
    const res = await app.request('/api/agent/whoami', { headers: { authorization: `Bearer ${userToken}` } });
    expect(res.status).toBe(403);
  });
});
