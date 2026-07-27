#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openCore, createHttpCore, resolveOriginUrl, resolveBoardToken, assertAbsoluteOverrides, NotFoundError } from '@agentfactory/core';
import { loadConfig } from './config.js';
import { Watcher } from './watcher.js';
import { makeFetchJson } from './http.js';
import type { WatcherDeps, WatcherCore } from './types.js';

// All diagnostics go to stderr/stdout via console; this is a long-running supervisor.
const configPath = resolve(process.argv[2] ?? 'watcher.config.json');
const config = loadConfig(configPath, (p) => readFileSync(p, 'utf8'));

// Backend branch (#46): a board URL + supervisor token over HTTP — or the local SQLite file
// as always. The config schema guarantees exactly one of the two is set.
let core: WatcherCore;
if (config.board) {
  const token = resolveBoardToken(config.board, process.env, 'watcher board token');
  assertAbsoluteOverrides(config.repoPathOverrides, 'watcher');
  const http = createHttpCore(config.board.url, token);
  // Fail fast at startup — the delivery ops and workspace-PAT read are supervisor-gated.
  try {
    const id = await http.whoami();
    if (!id.supervisor) {
      console.error(`[watcher] board token '${id.label}' lacks the supervisor capability (delivery ops need it) — mint with: npm run token -- --supervisor`);
      process.exit(1);
    }
    console.log(`[watcher] board ${config.board.url} as '${id.label}' (supervisor)`);
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.error(`[watcher] board ${config.board.url} does not expose /api/agent/whoami — deploy a board build with #46`);
      process.exit(1);
    }
    throw err; // unreachable board / bad credentials — the raw error says which
  }
  core = http;
} else {
  // Absolutise the DB path (relative to the config file) — same convention as the dispatcher.
  // openCore also runs migrations — board mode must never touch schema (db branch only).
  config.db = resolve(dirname(configPath), config.db!);
  core = openCore(config.db);
}

const fetchJson = makeFetchJson();

const deps: WatcherDeps = {
  core,
  fetchJson,
  resolveOrigin: resolveOriginUrl,
  env: process.env,
  now: () => Date.now(),
  console,
};

const watcher = new Watcher(config, deps);

const ghToken = process.env[config.github.tokenEnv] ? 'set' : 'NOT SET';
const azdoPat = process.env[config.azdo.patEnv] ? 'set' : 'NOT SET';
const wsDesc = config.workspaces
  ? `[${config.workspaces.join(', ')}]`
  : `all${config.excludeWorkspaces.length ? ` except [${config.excludeWorkspaces.join(', ')}]` : ''}`;
console.log(
  `[watcher] starting — ${config.board ? `board ${config.board.url}` : `db ${config.db}`}, workspaces ${wsDesc}, ` +
    `poll ${config.pollSeconds}s, postMergeChecks ${config.postMergeChecks}, ` +
    `${config.github.tokenEnv} ${ghToken} (shared), ${config.azdo.patEnv} ${azdoPat} (shared)`,
);
console.log(
  `[watcher] credential precedence: a PAT set on the workspace in the board UI wins; else the ` +
    `per-workspace env var ${config.github.tokenEnv}_<WORKSPACE> / ${config.azdo.patEnv}_<WORKSPACE> ` +
    `(slug uppercased, non-alphanumerics → _); else the shared base var`,
);

watcher.start();

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`[watcher] ${signal} received; stopping`);
  watcher.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
