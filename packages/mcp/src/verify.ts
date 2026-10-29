import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import type { VerificationStatus } from '@agentfactory/core';

export const VERIFY_TIMEOUT_MS = 20 * 60_000;
export const VERIFY_LOG_MAX_BYTES = 256 * 1024;
const TRUNCATED_MARKER = '[truncated]\n';
// Output kept past the cap before redaction, so a secret straddling the cut is still
// matched whole and the cut then lands in redacted text.
const REDACTION_SLACK_BYTES = 8 * 1024;

export interface VerifyRun {
  status: VerificationStatus;
  exitCode: number | null;
  log: string;
  truncated: boolean;
  startedAt: string;
  finishedAt: string;
}

export interface VerifyRunOptions {
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxBytes?: number;
  /** Literal values to strip from the log (PAT, managed auth headers). */
  secrets?: string[];
}

/** Replace every secret and every `scheme://userinfo@` with a marker. */
export function redact(text: string, secrets: string[]): string {
  // Bounded repeats: an unbounded scheme/userinfo run backtracks quadratically over long output.
  let out = text.replace(/([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]{1,2048}@/gi, '$1[redacted]@');
  // Longest first, so a header value is replaced whole before the PAT inside it.
  for (const secret of [...new Set(secrets)].filter(s => s.length >= 4).sort((a, b) => b.length - a.length)) {
    out = out.replaceAll(secret, '[redacted]');
  }
  return out;
}

/** Keep the tail of `buf` within `maxBytes`, prefixed with the truncation marker, on a UTF-8 boundary. */
function capTail(text: string, maxBytes: number, dropped: boolean): { log: string; truncated: boolean } {
  const buf = Buffer.from(text, 'utf8');
  if (!dropped && buf.length <= maxBytes) return { log: text, truncated: false };
  let start = buf.length - (maxBytes - Buffer.byteLength(TRUNCATED_MARKER));
  if (start < 0) start = 0;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++; // skip a split character's continuation bytes
  return { log: TRUNCATED_MARKER + buf.subarray(start).toString('utf8'), truncated: true };
}

/** Kill the shell and everything it started: a verify command is usually a process tree. */
function killTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// What the shell answers when the command itself cannot be found: the command never ran.
// cmd.exe /c answers 1 instead, so the leading executable is also resolved before the run.
const COMMAND_NOT_FOUND = process.platform === 'win32' ? 9009 : 127;
const SHELL_BUILTINS = new Set(['cd', 'chdir', 'pushd', 'popd', 'echo', 'set', 'export', 'call', 'if', 'for', 'exit',
  'true', 'false', 'test', '[', 'type', 'ver', 'cls', 'rem', 'command', 'exec', 'env', 'source', '.', 'setlocal', 'endlocal']);

/** The leading word of a shell command, or null when it is not a plain executable name. */
function leadingExecutable(command: string): string | null {
  const m = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s&|;<>()]+))/);
  const word = m?.[1] ?? m?.[2] ?? m?.[3];
  // Variable assignments, expansions and redirections are the shell's to interpret.
  return !word || /[=$%`*?]/.test(word) ? null : word;
}

/** Whether the shell could start `word`: a builtin, an existing path, or a file on PATH. */
function resolvable(word: string, cwd: string, env: NodeJS.ProcessEnv): boolean {
  if (SHELL_BUILTINS.has(word.toLowerCase())) return true;
  const win = process.platform === 'win32';
  const pathKey = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH';
  const exts = win ? ['', ...(env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)] : [''];
  const isFile = (p: string) => { try { return existsSync(p) && statSync(p).isFile(); } catch { return false; } };
  const tryBase = (base: string) => exts.some(ext => isFile(base + ext) || isFile(base + ext.toLowerCase()));
  if (isAbsolute(word) || /[\/]/.test(word)) return tryBase(resolve(cwd, word));
  const dirs = (env[pathKey] ?? '').split(delimiter).filter(Boolean);
  return (win && tryBase(join(cwd, word))) || dirs.some(dir => tryBase(join(dir, word)));
}

/**
 * Run a workspace verify command through the platform shell, capturing stdout and stderr
 * interleaved. Exit 0 → passed, other exit → failed, timeout → timed_out, a command that
 * could not be started (spawn error or the shell's command-not-found) → errored.
 */
export function runVerifyCommand(opts: VerifyRunOptions): Promise<VerifyRun> {
  const maxBytes = opts.maxBytes ?? VERIFY_LOG_MAX_BYTES;
  const keep = maxBytes + REDACTION_SLACK_BYTES;
  const startedAt = new Date().toISOString();
  const leading = leadingExecutable(opts.command);
  if (leading && !resolvable(leading, opts.cwd, opts.env)) {
    return Promise.resolve({ status: 'errored', exitCode: null, truncated: false, startedAt, finishedAt: new Date().toISOString(),
      log: redact(`verify command not found: ${leading}
`, opts.secrets ?? []) });
  }
  return new Promise((resolvePromise) => {
    let chunks: Buffer[] = [];
    let size = 0;
    let dropped = false;
    const append = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > keep * 2) {
        const all = Buffer.concat(chunks);
        const tail = all.subarray(all.length - keep);
        chunks = [tail]; size = tail.length; dropped = true;
      }
    };
    let timedOut = false;
    let spawnError: Error | null = null;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (spawnError) append(Buffer.from(`\n${spawnError.message}\n`));
      let all = Buffer.concat(chunks);
      if (all.length > keep) { all = all.subarray(all.length - keep); dropped = true; }
      const { log, truncated } = capTail(redact(all.toString('utf8'), opts.secrets ?? []), maxBytes, dropped);
      const status: VerificationStatus = timedOut ? 'timed_out'
        : spawnError || exitCode === null || exitCode === COMMAND_NOT_FOUND ? 'errored'
        : exitCode === 0 ? 'passed' : 'failed';
      resolvePromise({ status, exitCode: timedOut ? null : exitCode, log, truncated, startedAt, finishedAt: new Date().toISOString() });
    };
    const child = spawn(opts.command, {
      cwd: opts.cwd, env: opts.env, shell: true, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    });
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) killTree(child.pid);
    }, opts.timeoutMs ?? VERIFY_TIMEOUT_MS);
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => { spawnError = err; finish(null); });
    child.on('close', (code) => finish(code));
  });
}
