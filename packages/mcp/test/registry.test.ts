import { describe, it, expect } from 'vitest';
import { makeClient } from './harness.js';

describe('tool registry', () => {
  it('exposes exactly the six agent-facing tools', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['add_comment', 'get_next_task', 'get_task', 'list_tasks', 'submit_result', 'update_status'].sort(),
    );
  });

  it('does NOT expose create_task', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'create_task')).toBeUndefined();
  });

  it('instructs the agent to work in a dedicated git worktree under the workspace repo', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const next = tools.find((t) => t.name === 'get_next_task');
    expect(next?.description).toMatch(/git worktree add/);
    expect(next?.description).toMatch(/<repoPath>\/\.worktrees\//);
    const submit = tools.find((t) => t.name === 'submit_result');
    expect(submit?.description).toMatch(/worktree/);
  });
});
