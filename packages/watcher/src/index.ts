#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openCore, resolveOriginUrl } from '@agentfactory/core';
import { loadConfig } from './config.js';
import { Watcher } from './watcher.js';
import type { FetchJson, WatcherDeps } from './types.js';

// All diagnostics go to stderr/stdout via console; this is a long-running supervisor.
const configPath = resolve(process.argv[2] ?? 'watcher.config.json');
const config = loadConfig(configPath, (p) => readFileSync(p, 'utf8'));

// Absolutise the DB path (relative to the config file) — same convention as the dispatcher.
config.db = resolve(dirname(configPath), config.db);
const core = openCore(config.db);

/** Node's global fetch, folded to the providers' JSON shape (headers lower-cased by undici). */
const fetchJson: FetchJson = async (url, init) => {
  const res = await fetch(url, { headers: init.headers });
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
  let body: unknown = null;
  try { body = await res.json(); } catch { /* non-JSON error bodies are fine — status carries it */ }
  return { status: res.status, headers, body };
};

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
  `[watcher] starting — db ${config.db}, workspaces ${wsDesc}, ` +
    `poll ${config.pollSeconds}s, postMergeChecks ${config.postMergeChecks}, ` +
    `${config.github.tokenEnv} ${ghToken}, ${config.azdo.patEnv} ${azdoPat}`,
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
