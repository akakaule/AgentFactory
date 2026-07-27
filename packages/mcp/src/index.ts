#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openCore, createHttpCore } from '@agentfactory/core';
import { buildServer } from './server.js';
import type { McpCore } from './types.js';

// stdout is reserved for the MCP JSON-RPC transport. ALL diagnostics go to stderr.
const boardUrl = process.env['AGENTFACTORY_BOARD_URL'];
const boardToken = process.env['AGENTFACTORY_TOKEN'];
const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
const defaultWorkspace = process.env['AGENTFACTORY_WORKSPACE'];
// the workspace pin doubles as the worker label unless an explicit one is given
const workerLabel = process.env['AGENTFACTORY_WORKER'] ?? defaultWorkspace;

// #45: with a board URL + service token the server speaks authenticated HTTP to the board
// (remote workers, no SQLite on this machine); otherwise the local direct-DB path as always.
let core: McpCore;
let backend: string;
if (boardUrl && boardToken) {
  core = createHttpCore(boardUrl, boardToken);
  backend = `board: ${boardUrl}`;
} else if (boardUrl || boardToken) {
  // Fail FAST: a half-configured remote worker silently falling back to a local (empty/wrong)
  // SQLite file would "work" against the wrong board. Refuse to start instead.
  console.error(
    `[agentfactory-mcp] AGENTFACTORY_BOARD_URL and AGENTFACTORY_TOKEN must be set together ` +
      `(got ${boardUrl ? 'URL without TOKEN' : 'TOKEN without URL'}) — refusing to fall back to a local DB`,
  );
  process.exit(1);
} else {
  core = openCore(dbPath);
  backend = `db: ${dbPath}`;
}

const server = buildServer(core, { defaultWorkspace, workerLabel });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[agentfactory-mcp] connected over stdio (${backend}${defaultWorkspace ? `, workspace: ${defaultWorkspace}` : ''}${workerLabel ? `, worker: ${workerLabel}` : ''})`,
);
