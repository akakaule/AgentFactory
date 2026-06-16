import { describe, it, expect } from 'vitest';
import { featureBranch } from '@agentfactory/core';
import { makeClient, textOf } from './harness.js';

// Helper to create a task with non-empty required fields
function makeTaskInput(title: string) {
  return { title, spec: 'some spec', acceptanceCriteria: 'some criteria' };
}

// ---------------------------------------------------------------------------
// list_tasks
// ---------------------------------------------------------------------------
describe('list_tasks', () => {
  it('returns all tasks when no filter applied', async () => {
    const { client, core } = await makeClient();
    const t1 = core.createTask(makeTaskInput('Alpha'));
    const t2 = core.createTask(makeTaskInput('Beta'));

    const res = await client.callTool({ name: 'list_tasks', arguments: {} });
    const tasks = JSON.parse(textOf(res));
    expect(Array.isArray(tasks)).toBe(true);
    expect(tasks.length).toBe(2);
    const keys = tasks.map((t: any) => t.key);
    expect(keys).toContain(t1.key);
    expect(keys).toContain(t2.key);
  });

  it('filters by status', async () => {
    const { client, core } = await makeClient();
    const t1 = core.createTask(makeTaskInput('Alpha'));
    core.createTask(makeTaskInput('Beta'));
    // move t1 to queued
    core.updateStatus(t1.key, 'queued', 'human');

    const res = await client.callTool({ name: 'list_tasks', arguments: { status: 'queued' } });
    const tasks = JSON.parse(textOf(res));
    expect(tasks.length).toBe(1);
    expect(tasks[0].key).toBe(t1.key);
  });
});

// ---------------------------------------------------------------------------
// report_progress
// ---------------------------------------------------------------------------
describe('report_progress', () => {
  it('claim starts a live session and report_progress records a milestone + tokens', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Live one'));
    core.updateStatus(t.key, 'queued', 'human');

    // claiming via MCP starts a live agent session
    await client.callTool({ name: 'get_next_task', arguments: {} });
    expect(core.listLiveAgents().map((a: any) => a.key)).toContain(t.key);

    const res = await client.callTool({ name: 'report_progress', arguments: { key: t.key, message: 'running build', tokensIn: 1200 } });
    expect(textOf(res)).toContain('ok');
    const live = core.listLiveAgents().find((a: any) => a.key === t.key);
    expect(live.phase).toBe('running build');
    expect(live.tokensIn).toBe(1200);

    // submit ends the session (core op — no git guardrail, that is the MCP submit tool's job)
    core.submitResult(t.key, { summary: 'done' });
    expect(core.listLiveAgents().find((a: any) => a.key === t.key)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// get_next_task
// ---------------------------------------------------------------------------
describe('get_next_task', () => {
  it('claims the first queued task and returns it', async () => {
    const { client, core } = await makeClient();
    const t1 = core.createTask(makeTaskInput('First'));
    const t2 = core.createTask(makeTaskInput('Second'));
    core.updateStatus(t1.key, 'queued', 'human');
    core.updateStatus(t2.key, 'queued', 'human');

    const res = await client.callTool({ name: 'get_next_task', arguments: {} });
    const text = textOf(res);
    expect(text).toContain(t1.key);
    // task is now in_progress
    expect(core.getTask(t1.key).status).toBe('in_progress');
  });

  it('returns task:null (not isError) when queue is empty', async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: 'get_next_task', arguments: {} });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(textOf(res));
    expect(payload.task).toBeNull();
    expect(payload.message).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// get_next_task — claim-time protocol payload
// ---------------------------------------------------------------------------
describe('claim protocol payload', () => {
  it('first claim returns a protocol block with the server-named branch and create-form setup', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Barcode scanner intake form'));
    core.updateStatus(t.key, 'queued', 'human');

    const payload = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    const branch = featureBranch(t.key, 'Barcode scanner intake form');

    // task detail still sits at the top level (back-compat) and now carries `branch`
    expect(payload.key).toBe(t.key);
    expect(payload.branch).toBe(branch);
    // the create-vs-reuse signal must NOT leak into the serialized task payload
    expect(payload.branchCreated).toBeUndefined();

    expect(payload.protocol).toBeTruthy();
    expect(payload.protocol.version).toBe(4);
    expect(payload.protocol.stage).toBe('implementation');
    expect(payload.protocol.branch).toBe(branch);
    expect(payload.protocol.worktree).toMatch(new RegExp(`[\\\\/]\\.worktrees[\\\\/]${t.key}$`));
    // first claim → create with -b
    expect(payload.protocol.setup.join('\n')).toMatch(new RegExp(`git worktree add .*-b ${branch.replace(/\//g, '\\/')}`));
    expect(payload.protocol.finish.join('\n')).toMatch(new RegExp(`git push -u origin ${branch.replace(/\//g, '\\/')}`));
    expect(payload.protocol.finish.join('\n')).toMatch(/git worktree remove/);
  });

  it('reclaim returns the SAME branch with the reuse-form setup (no -b)', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Original title'));
    core.updateStatus(t.key, 'queued', 'human');

    const first = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    const branch = first.protocol.branch;
    expect(first.protocol.setup.join('\n')).toMatch(/-b /); // create form

    // human round-trip back to queued
    core.submitResult(t.key, { summary: 'done' });
    core.reviewRequestChanges(t.key, { feedback: 'again' });

    const second = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(second.protocol.branch).toBe(branch);              // stable
    expect(second.protocol.setup.join('\n')).not.toMatch(/-b /); // reuse form
    expect(second.protocol.setup.join('\n')).toContain(branch);
  });

  it('empty queue still returns task:null with no protocol', async () => {
    const { client } = await makeClient();
    const payload = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(payload.task).toBeNull();
    expect(payload.protocol).toBeUndefined();
  });

  it('a description-stage claim gets a doc protocol: stage discriminator, no git setup, no branch', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask({ title: 'Pipeline task', spec: 'raw idea', stage: 'description' });
    core.updateStatus(t.key, 'queued', 'human');

    const payload = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(payload.stage).toBe('description');
    expect(payload.branch).toBeNull(); // named at the first implementation-stage claim
    expect(payload.protocol.stage).toBe('description');
    expect(payload.protocol.setup).toEqual([]);
    expect(payload.protocol.branch).toBeUndefined();
    expect(payload.protocol.finish.join('\n')).toContain('submit_result');
  });
});

// ---------------------------------------------------------------------------
// get_task
// ---------------------------------------------------------------------------
describe('get_task', () => {
  it('returns full detail for a known task', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask({ title: 'My task', spec: 'do it', acceptanceCriteria: 'done done' });
    const res = await client.callTool({ name: 'get_task', arguments: { key: t.key } });
    const text = textOf(res);
    expect(text).toContain(t.key);
    // detail includes activity array
    const detail = JSON.parse(text);
    expect(Array.isArray(detail.activity)).toBe(true);
  });

  it('returns isError for unknown key', async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: 'get_task', arguments: { key: 'AF-999' } });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('not found');
  });
});

// ---------------------------------------------------------------------------
// ai-review/v1 strip — uncurated findings must not reach the implementing agent
// ---------------------------------------------------------------------------
describe('ai-review activity strip', () => {
  const REVIEW = 'ai-review/v1 — 1 finding (codex)\n```json\n{"reviewer":"codex","verdict":"findings","findings":[{"title":"Unbounded loop"}]}\n```';

  type Core = Awaited<ReturnType<typeof makeClient>>['core'];
  function reviewedTask(core: Core) {
    const t = core.createTask(makeTaskInput('Reviewed'));
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask();
    core.submitResult(t.key, { summary: 'done', links: [] });
    core.addComment(t.key, { actor: 'agent', body: REVIEW });
    core.addComment(t.key, { actor: 'human', body: 'a plain human note' });
    return t;
  }

  it('get_task hides ai-review/v1 comments but keeps plain comments', async () => {
    const { client, core } = await makeClient();
    const t = reviewedTask(core);

    const detail = JSON.parse(textOf(await client.callTool({ name: 'get_task', arguments: { key: t.key } })));
    const bodies = detail.activity.map((a: any) => a.body);
    expect(bodies).toContain('a plain human note');
    expect(detail.activity.some((a: any) => a.type === 'comment' && a.body.startsWith('ai-review/v1'))).toBe(false);
  });

  it('get_next_task strips ai-review on reclaim but the curated feedback rides through', async () => {
    const { client, core } = await makeClient();
    const t = reviewedTask(core);
    // human curates feedback and sends it back → task re-queues
    core.reviewRequestChanges(t.key, { feedback: '[reviewer-codex] Unbounded loop\n\n[human] also add a test' });

    const payload = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(payload.key).toBe(t.key);
    expect(payload.activity.some((a: any) => a.type === 'comment' && a.body.startsWith('ai-review/v1'))).toBe(false);
    const feedback = payload.activity.find((a: any) => a.type === 'feedback');
    expect(feedback).toBeTruthy();
    expect(feedback.body).toContain('[reviewer-codex]');
    expect(feedback.body).toContain('[human]');
  });
});

// ---------------------------------------------------------------------------
// add_comment
// ---------------------------------------------------------------------------
describe('add_comment', () => {
  it('appends a comment with actor=agent', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task'));

    const res = await client.callTool({ name: 'add_comment', arguments: { key: t.key, body: 'Hello from agent' } });

    // result shape: not an error, and the returned text is the created activity
    expect(res.isError).toBeFalsy();
    const activity = JSON.parse(textOf(res));
    expect(activity.body).toBe('Hello from agent');

    const detail = core.getTask(t.key);
    const comment = detail.activity.find(
      (a: any) => a.type === 'comment' && a.actor === 'agent' && a.body === 'Hello from agent',
    );
    expect(comment).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// spec image attachments — handed over as MCP image content blocks
// ---------------------------------------------------------------------------
describe('attachment hand-over', () => {
  const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6]);
  const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');

  it('get_task carries one image block per attachment, bytes intact', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task with screenshot'));
    core.addAttachment(t.key, { filename: 'shot.png', mime: 'image/png', dataBase64: PNG_B64 });

    const res = await client.callTool({ name: 'get_task', arguments: { key: t.key } });
    expect(res.isError).toBeFalsy();
    const content = res.content as Array<{ type: string; data?: string; mimeType?: string }>;
    expect(content[0]!.type).toBe('text');
    expect(content[1]).toMatchObject({ type: 'image', mimeType: 'image/png', data: PNG_B64 });
  });

  it('get_next_task hands the claimed task its images', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Claim me'));
    core.addAttachment(t.key, { filename: 'shot.png', mime: 'image/png', dataBase64: PNG_B64 });
    core.updateStatus(t.key, 'queued', 'human');

    const res = await client.callTool({ name: 'get_next_task', arguments: {} });
    const content = res.content as Array<{ type: string; mimeType?: string }>;
    expect(content.some((c) => c.type === 'image' && c.mimeType === 'image/png')).toBe(true);
  });

  it('tasks without attachments are unchanged (single text block)', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Plain task'));
    const res = await client.callTool({ name: 'get_task', arguments: { key: t.key } });
    expect((res.content as unknown[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// submit_result
// ---------------------------------------------------------------------------
describe('submit_result', () => {
  it('moves an in_progress task to in_review and persists links', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task'));
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask(); // moves to in_progress

    const link = { kind: 'pr' as const, label: 'My PR', url: 'https://github.com/org/repo/pull/1' };
    const res = await client.callTool({
      name: 'submit_result',
      arguments: { key: t.key, summary: 'Done!', links: [link] },
    });
    expect(res.isError).toBeFalsy();

    const detail = core.getTask(t.key);
    expect(detail.status).toBe('in_review');
    expect(JSON.stringify(detail)).toContain(link.url);
  });

  it('records optional usage metrics alongside the result', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task'));
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask();

    const res = await client.callTool({
      name: 'submit_result',
      arguments: {
        key: t.key, summary: 'Done!', links: [],
        metrics: { model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92 },
      },
    });
    expect(res.isError).toBeFalsy();

    const detail = core.getTask(t.key);
    expect(detail.status).toBe('in_review');
    expect(detail.metrics).toMatchObject({ model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92 });
  });

  it('submitting without metrics leaves the task unreported (null, not zero)', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task'));
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask();

    const res = await client.callTool({
      name: 'submit_result',
      arguments: { key: t.key, summary: 'Done!', links: [] },
    });
    expect(res.isError).toBeFalsy();
    expect(core.getTask(t.key).metrics).toMatchObject({ tokensIn: null, tokensOut: null, costUsd: null, model: null });
  });

  it('returns isError when submitting result on a backlog task', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Backlog task'));

    const res = await client.callTool({
      name: 'submit_result',
      arguments: { key: t.key, summary: 'premature', links: [] },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('invalid transition');
  });

  it('description stage accepts { spec, acceptanceCriteria } and persists them', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask({ title: 'T', spec: 'raw', stage: 'description' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask();

    const res = await client.callTool({
      name: 'submit_result',
      arguments: { key: t.key, summary: 'described', spec: 'polished spec', acceptanceCriteria: '- works' },
    });
    expect(res.isError).toBeFalsy();

    const detail = core.getTask(t.key);
    expect(detail.status).toBe('in_review');
    expect(detail.spec).toBe('polished spec');
    expect(detail.acceptanceCriteria).toBe('- works');
  });

  it('plan stage accepts { plan }; a wrong-shape payload fails with a stage-naming error', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask({ title: 'T', spec: 's', acceptanceCriteria: 'a', stage: 'plan' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask();

    const wrong = await client.callTool({
      name: 'submit_result',
      arguments: { key: t.key, summary: 'planned', spec: 'not allowed here' },
    });
    expect(wrong.isError).toBe(true);
    expect(textOf(wrong)).toContain('plan stage');
    expect(core.getTask(t.key).status).toBe('in_progress');

    const ok = await client.callTool({
      name: 'submit_result',
      arguments: { key: t.key, summary: 'planned', plan: '1. change x\n2. test y' },
    });
    expect(ok.isError).toBeFalsy();
    expect(core.getTask(t.key).plan).toBe('1. change x\n2. test y');
  });
});

// ---------------------------------------------------------------------------
// update_status
// ---------------------------------------------------------------------------
describe('update_status', () => {
  it('moves in_progress task to blocked', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task'));
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask(); // in_progress

    const res = await client.callTool({
      name: 'update_status',
      arguments: { key: t.key, status: 'blocked' },
    });
    expect(res.isError).toBeFalsy();
    expect(core.getTask(t.key).status).toBe('blocked');
  });

  it('returns isError when agent tries in_review -> done', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task'));
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask(); // in_progress
    core.submitResult(t.key, { summary: 'done', links: [] }); // in_review

    const res = await client.callTool({
      name: 'update_status',
      arguments: { key: t.key, status: 'done' },
    });
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// workspace scoping
// ---------------------------------------------------------------------------
describe('workspace scoping', () => {
  type Core = Awaited<ReturnType<typeof makeClient>>['core'];
  function seedTwoWorkspaces(core: Core) {
    core.createWorkspace({ name: 'a', repoPath: '/repo-a' });
    core.createWorkspace({ name: 'b', repoPath: '/repo-b' });
    const a1 = core.createTask({ ...makeTaskInput('A1'), workspace: 'a' });
    const b1 = core.createTask({ ...makeTaskInput('B1'), workspace: 'b' });
    core.updateStatus(a1.key, 'queued', 'human');
    core.updateStatus(b1.key, 'queued', 'human');
    return { a1, b1 };
  }

  it('get_next_task with a workspace param claims only from that workspace; payload carries workspace + repoPath', async () => {
    const { client, core } = await makeClient();
    const { b1 } = seedTwoWorkspaces(core);

    const res = await client.callTool({ name: 'get_next_task', arguments: { workspace: 'b' } });
    expect(res.isError).toBeFalsy();
    const payload = JSON.parse(textOf(res));
    expect(payload.key).toBe(b1.key);
    expect(payload.workspace).toBe('b');
    expect(payload.repoPath).toBe('/repo-b');

    // nothing queued in 'b' anymore — a1 must not leak across
    const empty = await client.callTool({ name: 'get_next_task', arguments: { workspace: 'b' } });
    expect(JSON.parse(textOf(empty)).task).toBeNull();
  });

  it('AGENTFACTORY_WORKSPACE pin applies when the param is omitted', async () => {
    const { client, core } = await makeClient({ defaultWorkspace: 'b' });
    const { b1 } = seedTwoWorkspaces(core);

    const res = await client.callTool({ name: 'get_next_task', arguments: {} });
    expect(JSON.parse(textOf(res)).key).toBe(b1.key);
    // a1 is still queued in 'a' but invisible to the pinned worker
    const empty = await client.callTool({ name: 'get_next_task', arguments: {} });
    expect(JSON.parse(textOf(empty)).task).toBeNull();
  });

  it('an explicit param overrides the pin', async () => {
    const { client, core } = await makeClient({ defaultWorkspace: 'b' });
    const { a1 } = seedTwoWorkspaces(core);

    const res = await client.callTool({ name: 'get_next_task', arguments: { workspace: 'a' } });
    expect(JSON.parse(textOf(res)).key).toBe(a1.key);
  });

  it('an unknown workspace surfaces as a tool error', async () => {
    const { client } = await makeClient();
    const res = await client.callTool({ name: 'get_next_task', arguments: { workspace: 'nope' } });
    expect(res.isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('workspace not found');
  });

  it('list_tasks filters by workspace, with the same pin fallback and override', async () => {
    const { client, core } = await makeClient({ defaultWorkspace: 'a' });
    const { a1, b1 } = seedTwoWorkspaces(core);

    const pinned = JSON.parse(textOf(await client.callTool({ name: 'list_tasks', arguments: {} })));
    expect(pinned.map((t: any) => t.key)).toEqual([a1.key]);

    const overridden = JSON.parse(textOf(await client.callTool({ name: 'list_tasks', arguments: { workspace: 'b' } })));
    expect(overridden.map((t: any) => t.key)).toEqual([b1.key]);
  });
});

// ---------------------------------------------------------------------------
// worker label → claim metadata
// ---------------------------------------------------------------------------
describe('worker label → claimedBy', () => {
  it('claimed payload carries claimedBy/claimedAt when the server has a worker label', async () => {
    const { client, core } = await makeClient({ workerLabel: 'worker-7' });
    const t = core.createTask(makeTaskInput('T'));
    core.updateStatus(t.key, 'queued', 'human');

    const payload = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(payload.claimedBy).toBe('worker-7');
    expect(typeof payload.claimedAt).toBe('string');
  });

  it('claimedBy is null when no label is configured (claimedAt still set)', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('T'));
    core.updateStatus(t.key, 'queued', 'human');

    const payload = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(payload.claimedBy).toBeNull();
    expect(typeof payload.claimedAt).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// input-schema rejection
// ---------------------------------------------------------------------------
describe('input-schema rejection', () => {
  it('rejects submit_result with a malformed link URL and does not move the task', async () => {
    const { client, core } = await makeClient();
    const t = core.createTask(makeTaskInput('Task'));
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask(); // in_progress

    // bad url — not a valid URL string
    let caught: unknown;
    let res: any;
    try {
      res = await client.callTool({
        name: 'submit_result',
        arguments: { key: t.key, summary: 'ok', links: [{ kind: 'pr', label: 'x', url: 'not-a-url' }] },
      });
    } catch (err) {
      caught = err;
    }

    // v1.29 surfaces input-schema violations as isError:true on the result
    // (it does NOT throw — the error is carried in the tool result envelope).
    if (caught !== undefined) {
      // If the SDK DID throw, the call was rejected before hitting the handler.
      expect(caught).toBeTruthy();
    } else {
      expect(res.isError).toBe(true);
    }

    // Either way, the task must NOT have advanced to in_review.
    expect(core.getTask(t.key).status).toBe('in_progress');
  });
});
