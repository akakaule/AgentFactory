#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { openCore, branchDiff, fetchRemoteRef } from '@agentfactory/core';
import { loadConfig } from './config.js';
import { Reviewer } from './reviewer.js';
import { resolveEngineCommand, pickFromWhich } from './engine.js';
import type { ReviewerDeps, LogWriter, SpawnFn } from './types.js';

// All diagnostics go to stderr/stdout via console; this is a long-running supervisor.
const configPath = resolve(process.argv[2] ?? 'reviewer.config.json');
const config = loadConfig(configPath, (p) => readFileSync(p, 'utf8'));

// Absolutise the DB path (relative to the config file) so the reviewer's poller opens the
// SAME DB the dispatcher and web server use.
config.db = resolve(dirname(configPath), config.db);
const core = openCore(config.db);

const logDir = resolve(dirname(configPath), 'logs');
mkdirSync(logDir, { recursive: true });

/**
 * Quote one argv token for a `cmd.exe /c "<line>"` invocation (cross-spawn style). Only
 * tokens with whitespace or a quote need wrapping; backslashes preceding a quote (and at
 * the end) are doubled per the Windows CommandLineToArgvW rules.
 */
function winQuote(s: string): string {
  if (s === '') return '""';
  if (!/[ \t"]/.test(s)) return s;
  const escaped = s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  return `"${escaped}"`;
}

const realSpawn: SpawnFn = ({ command, args, cwd, env, stdin }) => {
  const child =
    process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
      ? // Modern Node refuses to spawn a .cmd/.bat without a shell (CVE-2024-27980), and
        // shell:true does not quote args. Drive cmd.exe ourselves with a hand-quoted line.
        // The argv here is only flags + file paths (the prompt rides stdin), so it survives.
        spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].map(winQuote).join(' ')], {
          cwd,
          env,
          windowsVerbatimArguments: true,
        })
      : // POSIX, or a Windows .exe — spawn directly; Node applies correct argument quoting.
        spawn(command, args, { cwd, env });
  // The review prompt is fed on STDIN (diffs exceed command-line limits); end() sends EOF
  // so codex's `-` / claude's `-p` know the prompt is complete.
  if (stdin !== undefined) {
    child.stdin?.write(stdin);
    child.stdin?.end();
  }
  return child;
};

const openLog = (path: string): LogWriter => {
  const stream = createWriteStream(path, { flags: 'a' });
  return { write: (chunk) => void stream.write(chunk), end: () => stream.end() };
};

const readOutput = (path: string): string => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return ''; // codex never wrote the file (crash / empty review) — treated as no verdict
  }
};

/** PATH lookup for an engine shim via `where` (Windows) / `which` (POSIX). */
function lookupEngine(name: string): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    return pickFromWhich(process.platform, execFileSync(finder, [name], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

const deps: ReviewerDeps = {
  core,
  spawn: realSpawn,
  resolveEngine: (engine) => resolveEngineCommand(engine, { platform: process.platform, env: process.env, lookup: lookupEngine }),
  computeDiff: (repoPath, branch) => branchDiff(repoPath, branch),
  fetchRef: (repoPath, ref) => fetchRemoteRef(repoPath, ref),
  openLog,
  readOutput,
  logDir,
  now: () => Date.now(),
  baseEnv: process.env,
  console,
};

const reviewer = new Reviewer(config, deps);

console.log(
  `[reviewer] starting — db ${config.db}, workspaces [${config.workspaces.join(', ')}], ` +
    `engine ${config.engine}${config.model ? ` (${config.model})` : ''}, ` +
    `maxConcurrent ${config.maxConcurrent}, poll ${config.pollSeconds}s`,
);
console.log(`[reviewer] logs ${logDir}`);

reviewer.start();

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`[reviewer] ${signal} received; stopping (in-flight reviews are killed)`);
  reviewer.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
