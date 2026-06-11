import { describe, it, expect } from 'vitest';
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
