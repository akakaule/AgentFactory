import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openCore } from '@agentfactory/core';
import { buildServer } from '../src/server.js';

export async function makeClient() {
  const core = openCore(':memory:');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer(core);
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, core };
}

/** helper to read a tool result's text payload */
export function textOf(res: any): string {
  return res.content?.[0]?.text ?? '';
}
