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
    core.updateStatus(task.key, 'delivering', 'human', null, undefined, undefined, { submissionId: core.getTask(task.key).submission!.id });
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

  it('keeps missing required checks and the ciMode of a delivery check over HTTP', async () => {
    const task = core.createTask({ title: 'Required checks', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(task.key, 'queued', 'human');
    const claim = core.claimNextTask({ claimedBy: 'worker' })!;
    core.submitResult(task.key, { summary: 'done', revision: { headSha: 'a'.repeat(40), source: 'origin' } });
    core.updateStatus(task.key, 'delivering', 'human', null, undefined, undefined, { submissionId: core.getTask(task.key).submission!.id });
    const seeded = await http.beginDelivery(task.key, { provider: 'github', branch: claim.branch! });
    const expected = { status: 'delivering' as const, branch: seeded.branch, prUrl: seeded.prUrl, stateChangedAt: seeded.stateChangedAt };
    await http.recordDeliveryCheck(task.key, { expected, prUrl: 'https://github.com/acme/widgets/pull/42', prId: '#42',
      prState: 'open', checksState: 'pending', ciMode: 'required', failing: [{ name: 'build', url: null, missing: true }] });
    expect((await http.getTask(task.key)).delivery).toMatchObject({ checksState: 'pending', ciMode: 'required',
      failing: [{ name: 'build', url: null, missing: true }] });
  });

  it('records a failed provider check over HTTP as unknown revision freshness', async () => {
    const task = core.createTask({ title: 'Delivery outage', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(task.key, 'queued', 'human');
    const claim = core.claimNextTask({ claimedBy: 'worker' })!;
    core.submitResult(task.key, { summary: 'done', revision: { headSha: 'a'.repeat(40), source: 'origin' } });
    core.updateStatus(task.key, 'delivering', 'human', null, undefined, undefined, { submissionId: core.getTask(task.key).submission!.id });
    const seeded = await http.beginDelivery(task.key, { provider: 'github', branch: claim.branch! });
    const episode = { status: 'delivering' as const, branch: seeded.branch, prUrl: seeded.prUrl, stateChangedAt: seeded.stateChangedAt };
    // a failure fenced to another episode or submission is ignored; the current one is recorded
    expect(await http.recordDeliveryCheckFailure(task.key, { error: 'GitHub 503', expected: { ...episode, stateChangedAt: '1970-01-01T00:00:00.000Z' } })).toEqual({ recorded: false });
    expect(await http.recordDeliveryCheckFailure(task.key, { error: 'GitHub 503', expected: episode, submissionId: (seeded.submissionId ?? 0) + 1 })).toEqual({ recorded: false });
    expect(await http.recordDeliveryCheckFailure(task.key, { error: 'GitHub 503', expected: episode, submissionId: seeded.submissionId ?? null })).toEqual({ recorded: true });
    expect((await http.getTask(task.key)).submission).toMatchObject({ freshness: 'unknown', lastObservation: { source: 'provider', error: 'GitHub 503' } });
  });

  it('issues revision read tickets over HTTP: a late answer under an older ticket cannot overwrite a newer git observation', async () => {
    const A = 'a'.repeat(40), B = 'b'.repeat(40);
    const task = core.createTask({ title: 'Read tickets', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(task.key, 'queued', 'human');
    const claim = core.claimNextTask({ claimedBy: 'worker' })!;
    const sub = core.submitResult(task.key, { summary: 'done', revision: { headSha: A, source: 'origin' } }).submission!;
    core.updateStatus(task.key, 'delivering', 'human', null, undefined, undefined, { submissionId: sub.id });
    const seeded = await http.beginDelivery(task.key, { provider: 'github', branch: claim.branch! });
    const episode = { status: 'delivering' as const, branch: seeded.branch, prUrl: seeded.prUrl, stateChangedAt: seeded.stateChangedAt };
    const ticket = await http.issueRevisionReadTicket(task.key, sub.id); // taken before the provider request ...
    expect(ticket).toEqual({ submissionId: sub.id, ticket: expect.any(Number) });
    const git = core.issueRevisionReadTicket(task.key, sub.id)!; // ... a git read starts later and sees the push
    core.observeRevision(task.key, { submissionId: sub.id, headSha: B, source: 'git', readTicket: git.ticket });
    const aheadStart = new Date(Date.now() + 60_000).toISOString(); // the watcher's clock runs ahead: irrelevant
    expect(await http.recordDeliveryCheckFailure(task.key, { error: 'GitHub 503', expected: episode, submissionId: sub.id, readStartedAt: aheadStart, readTicket: ticket! })).toEqual({ recorded: false });
    await http.recordDeliveryCheck(task.key, { expected: episode, prUrl: null, prId: null, prState: 'not_found', checksState: 'unknown', failing: [], headSha: A, readStartedAt: aheadStart, readTicket: ticket! });
    expect((await http.getTask(task.key)).submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, source: 'git', error: null } });
    // a fresh ticket records
    const next = await http.issueRevisionReadTicket(task.key, sub.id);
    const d = (await http.getTask(task.key)).delivery!;
    expect(await http.recordDeliveryCheckFailure(task.key, { error: 'GitHub 503', expected: { ...episode, stateChangedAt: d.stateChangedAt }, submissionId: sub.id, readTicket: next! })).toEqual({ recorded: true });
  });

  it('read tickets are supervisor-gated', async () => {
    const task = core.createTask({ title: 'Gate', spec: 's', acceptanceCriteria: 'a' });
    const plain = core.createApiToken({ label: 'plain', isService: true }).token;
    const app = buildApp(core, { auth: { mode: 'token' } });
    const res = await app.request(`http://board/api/agent/tasks/${task.key}/revision/read-ticket`, {
      method: 'POST', headers: { authorization: `Bearer ${plain}`, 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(403);
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

  it('agent model settings: read the board document and report file defaults', async () => {
    core.createWorkspace({ name: 'kl-dis', repoPath: '/r' });
    const doc = { global: { stages: { description: { engine: 'claude' as const, model: 'claude-opus-5-5', effort: 'high' as const } } },
      workspaces: { 'kl-dis': { reviewers: [{ engine: 'codex' as const, model: 'gpt-6.1-sol' }] } } };
    core.setAgentModels(doc);
    expect(await http.getAgentModels()).toEqual(core.getAgentModels());
    await http.reportAgentModelDefaults({ supervisor: 'remote-dispatcher', kind: 'dispatcher', roles: { stages: { implementation: { engine: 'claude', model: 'claude-opus-5-5' } } } });
    expect(core.getAgentModelDefaults()['remote-dispatcher']?.roles.stages?.implementation?.model).toBe('claude-opus-5-5');
    await expect(http.reportAgentModelDefaults({ supervisor: '', kind: 'dispatcher', roles: {} })).rejects.toBeInstanceOf(ValidationError);
  });

  it('importTask: idempotent create + queue over HTTP, attributed to the human-configured import', async () => {
    core.createWorkspace({ name: 'dis', repoPath: '/repo' });
    const input = {
      workspace: 'dis', title: 'AB#42: Export invoices', spec: 'ADO Work Item: AB#42', stage: 'description' as const,
      links: [{ kind: 'url' as const, label: 'AB#42', url: 'https://dev.azure.com/o/p/_workitems/edit/42' }],
      dedupPrefix: 'AB#42:', note: 'Imported from Azure DevOps work item AB#42.', queue: true,
    };
    const first = await http.importTask(input);
    expect(first.created).toBe(true);
    expect(first.task.status).toBe('queued');
    expect(core.getTask(first.task.key).activity.find((a) => a.toStatus === 'queued')?.actor).toBe('human');
    const again = await http.importTask(input);
    expect(again).toMatchObject({ created: false, task: { key: first.task.key } });
    await expect(http.importTask({ ...input, dedupPrefix: 'AB#7:' })).rejects.toBeInstanceOf(ValidationError);
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

  it('attachVisualization carries the depicted revision over HTTP and refuses a replaced submission', async () => {
    const A = 'a'.repeat(40), B = 'b'.repeat(40);
    const doc = '<!doctype html><html><body>viz</body></html>';
    const t = core.createTask({ title: 'Viz rev', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w' });
    const first = core.submitResult(t.key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }).submission!;
    await http.attachVisualization(t.key, { html: doc, revision: { submissionId: first.id, headSha: B } });
    expect(core.getTask(t.key).visualizationRevision).toEqual({ submissionId: first.id, headSha: B });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w' });
    core.submitResult(t.key, { summary: 'r2', revision: { headSha: B, source: 'origin' } });
    await expect(http.attachVisualization(t.key, { html: doc, revision: { submissionId: first.id, headSha: A } })).rejects.toBeInstanceOf(InvalidTransitionError);
  });

  it('whoami reports the token identity and supervisor capability', async () => {
    expect(await http.whoami()).toEqual({ label: 'remote-supervisor', supervisor: true, capabilities: ['execution-fence/v1'] });

    const plain = core.createApiToken({ label: 'plain-worker', isService: true }).token;
    const app = buildApp(core, { auth: { mode: 'token' } });
    const asPlain = createHttpCore('http://board', plain, {
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => app.request(url as string, init)) as typeof fetch,
    });
    expect(await asPlain.whoami()).toEqual({ label: 'plain-worker', supervisor: false, capabilities: ['execution-fence/v1'] });
  });

  it('whoami refuses user tokens (service-only surface)', async () => {
    const u = core.createUser({ email: 'h@x', displayName: 'H' });
    const userToken = core.createApiToken({ userId: u.id, label: 'human' }).token;
    const app = buildApp(core, { auth: { mode: 'token' } });
    const res = await app.request('/api/agent/whoami', { headers: { authorization: `Bearer ${userToken}` } });
    expect(res.status).toBe(403);
  });
});
