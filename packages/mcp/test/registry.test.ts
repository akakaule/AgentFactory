import { describe, it, expect } from 'vitest';
import { makeClient } from './harness.js';

describe('tool registry', () => {
  it('exposes exactly the seven agent-facing tools', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ['add_comment', 'get_next_task', 'get_task', 'list_tasks', 'report_progress', 'submit_result', 'update_status'].sort(),
    );
  });

  it('report_progress advertises live, ephemeral milestones (distinct from add_comment)', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const rp = tools.find((t) => t.name === 'report_progress');
    expect(rp?.description).toMatch(/live/i);
    expect(rp?.description).toMatch(/milestone/i);
    expect(rp?.description).toMatch(/add_comment/); // tells the agent it is NOT a durable note
  });

  it('does NOT expose create_task', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'create_task')).toBeUndefined();
  });

  it('get_next_task defers to the protocol payload as the source of truth', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const next = tools.find((t) => t.name === 'get_next_task');
    // the description points at the payload rather than restating a (freezable) convention
    expect(next?.description).toMatch(/`protocol`/);
    expect(next?.description).toMatch(/source of truth/);
    expect(next?.description).toMatch(/protocol\.setup/);
    expect(next?.description).toMatch(/protocol\.finish/);
    // it must NOT hard-code a branch name the server now owns
    expect(next?.description).not.toMatch(/feature\/<task-key>-<kebab-title>/);
    expect(next?.description).not.toMatch(/-b task\//);
  });

  it('get_next_task tells the agent the protocol encodes create-vs-reuse (do not improvise)', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const next = tools.find((t) => t.name === 'get_next_task');
    expect(next?.description).toMatch(/reclaim/);
    expect(next?.description).toMatch(/do not improvise/i);
  });

  it('submit_result advertises that it verifies the finish protocol (push + worktree removal)', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const submit = tools.find((t) => t.name === 'submit_result');
    expect(submit?.description).toMatch(/protocol\.finish/);
    expect(submit?.description).toMatch(/verif/i);   // "VERIFIES"
    expect(submit?.description).toMatch(/origin/);
    expect(submit?.description).toMatch(/worktree/);
  });

  it('tells the agent spec images arrive as image content', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const next = tools.find((t) => t.name === 'get_next_task');
    expect(next?.description).toMatch(/image content/);
  });

  it('invites best-effort usage metrics on submit', async () => {
    const { client } = await makeClient();
    const { tools } = await client.listTools();
    const submit = tools.find((t) => t.name === 'submit_result');
    expect(submit?.description).toMatch(/metrics/);
    expect(submit?.description).toMatch(/best-effort/);
  });
});
