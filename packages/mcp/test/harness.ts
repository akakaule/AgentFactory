import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openCore, type Core } from '@agentfactory/core';
import { buildServer, type ServerOptions } from '../src/server.js';
import type { McpCore } from '../src/types.js';

/** `wrap` lets a test stub individual ops the server sees while it still seeds the real core. */
export async function makeClient(opts: ServerOptions = {}, wrap: (core: Core) => McpCore = (core) => core) {
  const core = openCore(':memory:');
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = buildServer(wrap(core), opts);
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, core };
}

/** helper to read a tool result's text payload */
export function textOf(res: any): string {
  return res.content?.[0]?.text ?? '';
}
