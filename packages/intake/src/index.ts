#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createHttpCore, openCore, resolveBoardToken, assertAbsoluteOverrides, NotFoundError } from '@agentfactory/core';
import { loadConfig } from './config.js';
import { FixtureTaskIntakeDecisionProvider } from './provider.js';
import { JevTaskIntakeDecisionProvider } from './providers/jev.js';
import { IntakeSupervisor } from './supervisor.js';

const configPath = resolve(process.argv[2] ?? 'intake.config.json');
const config = loadConfig(configPath, (p) => readFileSync(p, 'utf8'));
if (!config.provider) {
  console.error('[intake] no provider configured; set provider.name to fixture or jev');
  process.exit(1);
}

let core: import('./supervisor.js').IntakeCore;
if (config.board) {
  const token = resolveBoardToken(config.board, process.env, 'intake board token');
  assertAbsoluteOverrides(config.repoPathOverrides, 'intake');
  const http = createHttpCore(config.board.url, token);
  try { await http.whoami(); }
  catch (err) {
    if (err instanceof NotFoundError) { console.error(`[intake] board ${config.board.url} does not expose /api/agent/whoami`); process.exit(1); }
    throw err;
  }
  core = http;
} else {
  core = openCore(resolve(dirname(configPath), config.db!));
}

const provider = config.provider.name === 'fixture'
  ? new FixtureTaskIntakeDecisionProvider((config.provider.fixtures ?? {}) as Record<string, never>)
  : new JevTaskIntakeDecisionProvider({
    endpoint: config.provider.endpoint ?? 'https://api.typesafe.ai/v1/systemone',
    apiKey: process.env[config.provider.apiKeyEnv]?.trim() ?? '', model: config.provider.model,
    // The supervisor removes policy text unless the live board setting permits it.
    sendWorkspacePolicy: true,
  });
if (config.provider.name === 'jev' && !process.env[config.provider.apiKeyEnv]?.trim()) {
  console.error(`[intake] provider API key missing: export ${config.provider.apiKeyEnv}`);
  process.exit(1);
}

const supervisor = new IntakeSupervisor(config, { core, provider, console, exit: (code) => process.exit(code) });
console.log(`[intake] starting — ${config.board ? `board ${config.board.url}` : `db ${config.db}`}, provider ${provider.name}, poll ${config.pollSeconds}s`);
supervisor.start();
let stopping = false;
const shutdown = (signal: string): void => { if (stopping) return; stopping = true; console.log(`[intake] ${signal} received; stopping`); supervisor.stop(); process.exit(0); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
