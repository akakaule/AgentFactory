import { describe, it, expect } from 'vitest';
import { makeClient, textOf } from './harness.js';

describe('dispatched MCP claim', () => {
  it('honors the server task/stage pin rather than claiming the first queued row', async () => {
    const { core, client } = await makeClient({ taskKey: 'AF-2', stage: 'plan', workerLabel: 'plan-worker' });
    for (const stage of ['implementation', 'plan'] as const) {
      const task = core.createTask({ title: stage, spec: 's', acceptanceCriteria: 'a', stage });
      core.updateStatus(task.key, 'queued', 'human');
    }
    try {
      const result = textOf(await client.callTool({ name: 'get_next_task', arguments: {} }));
      expect(result).toContain('AF-2');
      expect(core.getTask('AF-1').status).toBe('queued');
      expect(core.getTask('AF-2').claimedBy).toBe('plan-worker');
    } finally { await client.close(); }
  });

  it('reports the host the worker runs on with its claim, so the board shows where it runs', async () => {
    const { core, client } = await makeClient({ workerLabel: 'w1', host: 'agentvm01' });
    const task = core.createTask({ title: 'T', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(task.key, 'queued', 'human');
    try {
      await client.callTool({ name: 'get_next_task', arguments: {} });
      expect(core.listLiveAgents().find((a) => a.key === task.key)?.host).toBe('agentvm01');
    } finally { await client.close(); }
  });
});
