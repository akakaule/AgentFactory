#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openCore, createHttpCore } from '@agentfactory/core';
import { buildServer } from './server.js';
import type { McpCore } from './types.js';

// stdout is reserved for the MCP JSON-RPC transport. ALL diagnostics go to stderr.
// Blank counts as UNSET everywhere: a board-mode dispatcher deliberately writes the unused
// backend's vars as '' (#46) so an inherited shell export can never flip a worker's backend
// or trip the half-configured fail-fast below.
const norm = (v: string | undefined): string | undefined => (v?.trim() ? v.trim() : undefined);
const boardUrl = norm(process.env['AGENTFACTORY_BOARD_URL']);
const boardToken = norm(process.env['AGENTFACTORY_TOKEN']);
const dbPath = norm(process.env['AGENTFACTORY_DB']) ?? './agentfactory.db';
const defaultWorkspace = norm(process.env['AGENTFACTORY_WORKSPACE']);
// the workspace pin doubles as the worker label unless an explicit one is given
const workerLabel = norm(process.env['AGENTFACTORY_WORKER']) ?? defaultWorkspace;
// machine-local clone override for the pinned workspace (#46 remote workers)
const repoPath = norm(process.env['AGENTFACTORY_REPO_PATH']);

if (repoPath && !defaultWorkspace) {
  // An unpinned server could claim from ANY workspace and map a foreign task onto this
  // machine's clone — refuse the ambiguous configuration outright.
  console.error('[agentfactory-mcp] AGENTFACTORY_REPO_PATH requires AGENTFACTORY_WORKSPACE (the override applies to the pinned workspace only)');
  process.exit(1);
}

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

const server = buildServer(core, { defaultWorkspace, workerLabel, repoPath });
const transport = new StdioServerTransport();
await server.connect(transport);
console.error(
  `[agentfactory-mcp] connected over stdio (${backend}${defaultWorkspace ? `, workspace: ${defaultWorkspace}` : ''}${workerLabel ? `, worker: ${workerLabel}` : ''}${repoPath ? `, repo: ${repoPath}` : ''})`,
);
