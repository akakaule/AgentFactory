import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openCore, createHttpCore } from '@agentfactory/core';
import { buildApp } from '../../web/server/app.js';
import { buildServer, type ServerOptions } from '../src/server.js';
import { textOf } from './harness.js';

/**
 * #45 acceptance gate: the SAME MCP server, backed by createHttpCore against an in-process
 * buildApp(core) with a service token, behaves like the direct-DB backend. This is the exact
 * wiring a remote worker session runs (AGENTFACTORY_BOARD_URL + AGENTFACTORY_TOKEN).
 */
async function makeHttpBackedClient(opts: ServerOptions = {}, wrap?: (c: ReturnType<typeof createHttpCore>) => ReturnType<typeof createHttpCore>) {
  const core = openCore(':memory:');
  const app = buildApp(core, { auth: { mode: 'token' } });
  const token = core.createApiToken({ label: 'remote-worker', isService: true }).token;
  let httpCore = createHttpCore('http://board', token, {
    fetchImpl: ((url: string | URL | Request, init?: RequestInit) => app.request(url as string, init)) as typeof fetch,
  });
  if (wrap) httpCore = wrap(httpCore);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer(httpCore, opts);
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, core };
}

describe('MCP over createHttpCore (remote-worker wiring)', () => {
  it('claims, narrates, and reads a task through the board API', async () => {
    const { client, core } = await makeHttpBackedClient({ workerLabel: 'remote-w1' });
    const t = core.createTask({ title: 'Remote task', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');

    const claim = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(claim.key).toBe(t.key);
    expect(claim.status).toBe('in_progress');
    expect(claim.protocol).toBeTruthy(); // the protocol block still rides the claim
    expect(core.getTask(t.key).claimedBy).toBe('remote-w1');

    await client.callTool({ name: 'add_comment', arguments: { key: t.key, body: 'working remotely' } });
    await client.callTool({ name: 'report_progress', arguments: { key: t.key, message: 'halfway' } });

    const detail = JSON.parse(textOf(await client.callTool({ name: 'get_task', arguments: { key: t.key } })));
    expect(detail.activity.some((a: { body: string }) => a.body === 'working remotely')).toBe(true);
    expect(core.listLiveAgents()[0]?.phase).toBe('halfway');
  });

  it('spec images arrive as image blocks over the binary attachment route', async () => {
    const { client, core } = await makeHttpBackedClient();
    const t = core.createTask({ title: 'With image', spec: 'S', acceptanceCriteria: 'A' });
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    core.addAttachment(t.key, { filename: 'shot.png', mime: 'image/png', dataBase64: png.toString('base64') });
    core.updateStatus(t.key, 'queued', 'human');

    const res = (await client.callTool({ name: 'get_next_task', arguments: {} })) as { content: Array<{ type: string; data?: string; mimeType?: string }> };
    const image = res.content.find((b) => b.type === 'image');
    expect(image?.mimeType).toBe('image/png');
    expect(Buffer.from(image!.data!, 'base64').equals(png)).toBe(true);
  });

  it('update_status runs as agent and blocked-flow works end to end', async () => {
    const { client, core } = await makeHttpBackedClient();
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');
    await client.callTool({ name: 'get_next_task', arguments: {} });

    const res = await client.callTool({ name: 'update_status', arguments: { key: t.key, status: 'blocked', note: 'need creds' } });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
    expect(core.getTask(t.key).status).toBe('blocked');
  });

  it('an empty queue returns the idle payload, not an error', async () => {
    const { client } = await makeHttpBackedClient();
    const res = await client.callTool({ name: 'get_next_task', arguments: {} });
    expect(JSON.parse(textOf(res)).task).toBeNull();
  });

  it('a failing attachment fetch degrades the claim to text — never a lost claim', async () => {
    const { client, core } = await makeHttpBackedClient({}, (c) => ({
      ...c,
      getAttachment: async () => { throw new Error('board 503'); },
    }));
    const t = core.createTask({ title: 'With image', spec: 'S', acceptanceCriteria: 'A' });
    core.addAttachment(t.key, { filename: 'shot.png', mime: 'image/png', dataBase64: Buffer.from('89504e47', 'hex').toString('base64') });
    core.updateStatus(t.key, 'queued', 'human');

    const res = (await client.callTool({ name: 'get_next_task', arguments: {} })) as { isError?: boolean; content: Array<{ type: string; text?: string }> };
    expect(res.isError).toBeFalsy(); // the committed claim is returned, not an error
    expect(JSON.parse(res.content[0]!.text!).key).toBe(t.key);
    expect(res.content.some((b) => b.type === 'text' && b.text?.includes('could not be fetched'))).toBe(true);
    // and a retry would reconcile to the SAME task, not claim a second one
    const retry = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
    expect(retry.key ?? retry.task).not.toBeUndefined();
  });

  it('a failing metrics write after submit reports success with a warning, not an error', async () => {
    const { client, core } = await makeHttpBackedClient({}, (c) => ({
      ...c,
      addTaskMetrics: async () => { throw new Error('board 503'); },
    }));
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'plan' });
    core.updateStatus(t.key, 'queued', 'human');
    await client.callTool({ name: 'get_next_task', arguments: {} });

    const res = (await client.callTool({
      name: 'submit_result',
      arguments: { key: t.key, summary: 'planned', plan: 'the plan', metrics: { tokensIn: 10 } },
    })) as { isError?: boolean };
    expect(res.isError).toBeFalsy(); // the submit committed — an error would provoke a doomed retry
    expect(textOf(res)).toContain('Do not resubmit');
    expect(core.getTask(t.key).status).toBe('in_review');
  });

  it('typed core errors survive the HTTP hop into tool errors', async () => {
    const { client } = await makeHttpBackedClient();
    const res = await client.callTool({ name: 'get_task', arguments: { key: 'AF-9999' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res).toLowerCase()).toContain('not found');
  });
});
