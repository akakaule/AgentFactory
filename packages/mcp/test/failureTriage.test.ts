import { describe, it, expect } from 'vitest';
import { buildFailureComment } from '@agentfactory/core';
import { makeClient, textOf } from './harness.js';

const crash = buildFailureComment({
  reason: 'crashed', source: 'dispatcher', attempt: 1, maxAttempts: 3, detail: 'session `w` exited with code 1 with the task still in progress',
  body: 'Releasing the claim for retry.\n\nLog tail:\n```\nfatal: Authentication failed\n```',
});

/** A queued task with a current failure that a human has already labeled. */
async function labeled() {
  const { client, core } = await makeClient();
  const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  core.updateStatus(t.key, 'queued', 'human');
  const source = core.addComment(t.key, { actor: 'agent', body: crash }).id;
  core.recordFailureTriageFeedback(t.key, { sourceActivityId: source, action: 'correct', category: 'infrastructure', shownCategory: 'access', note: 'operator note' });
  expect(core.getTask(t.key).failureTriage).toMatchObject({ classifier: 'human' }); // precondition: the board has it
  return { client, core, key: t.key };
}

type Payload = { failureTriage?: unknown; failure: unknown; activity?: Array<{ body: string }> };
const assertStripped = (p: Payload) => {
  expect(p.failureTriage).toBeNull();
  expect(p.failure).toMatchObject({ reason: 'crashed' }); // the original failure stays as retry context
  if (p.activity) {
    expect(p.activity.some((a) => a.body.startsWith('failure/v1'))).toBe(true);
    expect(p.activity.some((a) => a.body.startsWith('failure-triage'))).toBe(false);
  }
  expect(JSON.stringify(p)).not.toContain('operator note');
};

describe('failure triage never reaches workers', () => {
  it('list_tasks', async () => {
    const { client } = await labeled();
    const tasks = JSON.parse(textOf(await client.callTool({ name: 'list_tasks', arguments: {} }))) as Payload[];
    assertStripped(tasks[0]!);
  });

  it('get_task', async () => {
    const { client, key } = await labeled();
    assertStripped(JSON.parse(textOf(await client.callTool({ name: 'get_task', arguments: { key } }))) as Payload);
  });

  it('get_next_task (the claim payload)', async () => {
    const { client } = await labeled();
    assertStripped(JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} }))) as Payload);
  });

  it('update_status', async () => {
    const { client, key } = await labeled();
    await client.callTool({ name: 'get_next_task', arguments: {} });
    const res = await client.callTool({ name: 'update_status', arguments: { key, status: 'blocked', note: 'stuck' } });
    assertStripped(JSON.parse(textOf(res)) as Payload);
  });
});
