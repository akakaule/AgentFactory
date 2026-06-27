#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createWriteStream, mkdirSync, readFileSync, writeFileSync, statSync, existsSync, readdirSync, openSync, readSync, closeSync, type Dirent } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { openCore } from '@agentfactory/core';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { resolveClaudeCommand, pickFromWhich } from './claude.js';
import { encodeProjectDir } from './transcript.js';
import type { DispatcherDeps, LogWriter, McpServerSpec, SpawnFn } from './types.js';

// All diagnostics go to stderr/stdout via console; this is a long-running supervisor.
const configPath = resolve(process.argv[2] ?? 'dispatcher.config.json');
const config = loadConfig(configPath, (p) => readFileSync(p, 'utf8'));

// Absolutise the DB path (relative to the config file) so the dispatcher's poller AND
// each worker's MCP server — whose cwd is the workspace repo, not here — open the SAME DB.
config.db = resolve(dirname(configPath), config.db);
const core = openCore(config.db);

// Resolve the agentfactory MCP server entry from the installed @agentfactory/mcp package
// (no "exports" map → subpath resolution of dist/index.js is allowed). Launched per
// session with node, so a fresh build's tool descriptions and protocol always apply.
const requireFrom = createRequire(import.meta.url);
const mcpEntry = requireFrom.resolve('@agentfactory/mcp/dist/index.js');
const mcp: McpServerSpec = { command: process.execPath, args: [mcpEntry] };

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

const realSpawn: SpawnFn = ({ command, args, cwd, env }) => {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // Modern Node refuses to spawn a .cmd/.bat without a shell (CVE-2024-27980), and
    // shell:true does NOT quote args (it only concatenates). So drive cmd.exe ourselves
    // with a hand-quoted command line and verbatim args. The argv here is quote-free
    // (prompt) and file paths only — the MCP JSON went to a file — so this survives intact.
    const line = [command, ...args].map(winQuote).join(' ');
    return spawn(process.env['ComSpec'] ?? 'cmd.exe', ['/d', '/s', '/c', line], {
      cwd,
      env,
      windowsVerbatimArguments: true,
    });
  }
  // POSIX, or a Windows .exe — spawn directly; Node applies correct argument quoting.
  return spawn(command, args, { cwd, env });
};

const openLog = (path: string): LogWriter => {
  const stream = createWriteStream(path, { flags: 'a' });
  return { write: (chunk) => void stream.write(chunk), end: () => stream.end() };
};

const writeMcp = (path: string, contents: string): void => writeFileSync(path, contents);

// -- transcript capture ------------------------------------------------------
// Claude writes each session's transcript to <config>/projects/<encoded-cwd>/<session-id>.jsonl.
const claudeConfigDir = process.env['CLAUDE_CONFIG_DIR']?.trim() || join(homedir(), '.claude');
const projectsDir = join(claudeConfigDir, 'projects');

/** Find the file `name` under `dir` (bounded depth) — the unique-uuid fallback when the
 *  encoded-cwd guess misses (drive-letter case, trailing dot, CLAUDE_CONFIG_DIR drift). */
function findFileRec(dir: string, name: string, depth: number): string | null {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) if (e.isFile() && e.name === name) return join(dir, e.name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFileRec(join(dir, e.name), name, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Resolve a session's transcript path: the deterministic encoded-cwd guess, else a uuid glob. */
function findTranscript(cwd: string, sessionId: string): string | null {
  const guess = join(projectsDir, encodeProjectDir(resolve(cwd)), `${sessionId}.jsonl`);
  if (existsSync(guess)) return guess;
  return findFileRec(projectsDir, `${sessionId}.jsonl`, 5);
}

/** Read new transcript bytes from `offset` up to the last COMPLETE line (so a chunk never splits
 *  a JSONL line or a multibyte char — the next tail picks up the partial tail line). */
function tailFile(path: string, offset: number): { chunk: string; offset: number } | null {
  try {
    const size = statSync(path).size;
    if (size <= offset) return { chunk: '', offset };
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.allocUnsafe(size - offset);
      readSync(fd, buf, 0, size - offset, offset);
      const lastNl = buf.lastIndexOf(0x0a);
      if (lastNl === -1) return { chunk: '', offset }; // no complete line yet
      const slice = buf.subarray(0, lastNl + 1);
      return { chunk: slice.toString('utf8'), offset: offset + slice.length };
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function readTranscript(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** PATH lookup for the claude shim via `where` (Windows) / `which` (POSIX). */
function lookupClaude(name: string): string | null {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(finder, [name], { encoding: 'utf8' });
    return pickFromWhich(process.platform, out);
  } catch {
    return null;
  }
}

const deps: DispatcherDeps = {
  core,
  spawn: realSpawn,
  resolveClaude: () => resolveClaudeCommand({ platform: process.platform, env: process.env, lookup: lookupClaude }),
  mcp,
  openLog,
  writeMcp,
  logDir,
  now: () => Date.now(),
  baseEnv: process.env,
  console,
  uuid: () => randomUUID(),
  findTranscript,
  tailFile,
  readFile: readTranscript,
};

const dispatcher = new Dispatcher(config, deps);

console.log(
  `[dispatcher] starting — db ${config.db}, workspaces [${config.workspaces.join(', ')}], ` +
    `maxConcurrent ${config.maxConcurrent}, poll ${config.pollSeconds}s, permission ${config.permissionMode}`,
);
console.log(`[dispatcher] mcp entry ${mcpEntry}; logs ${logDir}`);

dispatcher.start();

let stopping = false;
const shutdown = (signal: string): void => {
  if (stopping) return;
  stopping = true;
  console.log(`[dispatcher] ${signal} received; stopping (in-flight sessions are killed)`);
  dispatcher.stop();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
