import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openCore } from '@agentfactory/core';
import { buildServer, localizeRepo, type ServerOptions } from '../src/server.js';
import { textOf } from './harness.js';

/**
 * #46: a remote worker's MCP server maps the board-central workspace repoPath onto the
 * machine-local clone (AGENTFACTORY_REPO_PATH) — for the pinned workspace only. The
 * protocol block, the serialized detail, and the submit guard must all see local paths.
 */

const LOCAL = process.platform === 'win32' ? 'C:\\clones\\shop' : '/clones/shop';
const LOCAL_FWD = LOCAL.replace(/\\/g, '/');

async function makeClient(opts: ServerOptions) {
  const core = openCore(':memory:');
  core.createWorkspace({ name: 'shop', repoPath: '/board-machine/shop' });
  core.createWorkspace({ name: 'other', repoPath: '/board-machine/other' });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer(core, opts);
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, core };
}

describe('repoPath override (remote worker clone mapping)', () => {
  it('claim serializes the local clone path and a local protocol worktree', async () => {
    const { client, core } = await makeClient({ defaultWorkspace: 'shop', workerLabel: 'w1', repoPath: LOCAL });
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', workspace: 'shop' });
    core.updateStatus(t.key, 'queued', 'human');

    const claim = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(claim.repoPath).toBe(LOCAL);
    expect(claim.protocol.worktree).toBe(`${LOCAL_FWD}/.worktrees/${t.key}`);
    // the board keeps its own truth — the override never leaks back
    expect(core.getTask(t.key).repoPath).toBe('/board-machine/shop');
  });

  it('get_task maps the pinned workspace; a foreign workspace keeps its board path', async () => {
    const { client, core } = await makeClient({ defaultWorkspace: 'shop', repoPath: LOCAL });
    const mine = core.createTask({ title: 'M', spec: 'S', acceptanceCriteria: 'A', workspace: 'shop' });
    const foreign = core.createTask({ title: 'F', spec: 'S', acceptanceCriteria: 'A', workspace: 'other' });

    expect(JSON.parse(textOf(await client.callTool({ name: 'get_task', arguments: { key: mine.key } }))).repoPath).toBe(LOCAL);
    expect(JSON.parse(textOf(await client.callTool({ name: 'get_task', arguments: { key: foreign.key } }))).repoPath).toBe('/board-machine/other');
  });

  it('localizeRepo is inert without an override or outside the pinned workspace', () => {
    const task = { workspace: 'shop', repoPath: '/board-machine/shop' };
    expect(localizeRepo(task, {})).toBe(task);
    expect(localizeRepo(task, { defaultWorkspace: 'other', repoPath: LOCAL })).toBe(task);
    expect(localizeRepo(task, { defaultWorkspace: 'shop', repoPath: LOCAL }).repoPath).toBe(LOCAL);
  });
});
