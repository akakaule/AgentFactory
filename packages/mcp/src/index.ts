#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openCore } from '@agentfactory/core';
import { buildServer } from './server.js';

// stdout is reserved for the MCP JSON-RPC transport. ALL diagnostics go to stderr.
const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
const defaultWorkspace = process.env['AGENTFACTORY_WORKSPACE'];
// the workspace pin doubles as the worker label unless an explicit one is given
const workerLabel = process.env['AGENTFACTORY_WORKER'] ?? defaultWorkspace;
const core = openCore(dbPath);
const server = buildServer(core, { defaultWorkspace, workerLabel });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[agentfactory-mcp] connected over stdio (db: ${dbPath}${defaultWorkspace ? `, workspace: ${defaultWorkspace}` : ''}${workerLabel ? `, worker: ${workerLabel}` : ''})`,
);
