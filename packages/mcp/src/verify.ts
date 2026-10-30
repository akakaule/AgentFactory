import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { VerificationStatus } from '@agentfactory/core';

export const VERIFY_TIMEOUT_MS = 20 * 60_000;
export const VERIFY_LOG_MAX_BYTES = 256 * 1024;
const TRUNCATED_MARKER = '[truncated]\n';
// Longest text a URL-userinfo match can span (scheme + `://` + userinfo + `@`): unredacted
// output this close to the end is held back until more arrives, so a match is seen whole.
const URL_MATCH_MAX = 32 + 3 + 2048 + 1;

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

const USERINFO = /([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/@]{1,2048}@/gi;

const usableSecrets = (secrets: string[]) =>
  // Longest first, so a header value is replaced whole before the PAT inside it.
  [...new Set(secrets)].filter(s => s.length >= 4).sort((a, b) => b.length - a.length);

/** Replace every secret and every `scheme://userinfo@` with a marker. */
export function redact(text: string, secrets: string[]): string {
  // Bounded repeats: an unbounded scheme/userinfo run backtracks quadratically over long output.
  let out = text.replace(USERINFO, '$1[redacted]@');
  for (const secret of usableSecrets(secrets)) out = out.replaceAll(secret, '[redacted]');
  return out;
}

/**
 * Redacts output as it streams, so only redacted text is ever evicted by the tail cap: raw text
 * is committed only up to a point no secret or URL-userinfo match crosses, and the last stretch
 * that a match could still be growing into is held back until more output (or the end) arrives.
 */
export class StreamRedactor {
  private readonly secrets: string[];
  private readonly hold: number;
  private pending = '';

  constructor(secrets: string[]) {
    this.secrets = usableSecrets(secrets);
    this.hold = Math.max(URL_MATCH_MAX, ...this.secrets.map(s => s.length));
  }

  /** Add raw text; returns the redacted text now safe to commit. */
  push(text: string): string {
    this.pending += text;
    if (this.pending.length < this.hold * 4) return '';
    let cut = this.pending.length - this.hold;
    // Every match ends within the hold, so one starting before `cut` is complete: move the cut
    // back to its start until no match straddles it.
    const spans = this.matchSpans();
    for (let moved = true; moved;) {
      moved = false;
      for (const [start, end] of spans) if (start < cut && cut < end) { cut = start; moved = true; }
    }
    if (/[\udc00-\udfff]/.test(this.pending[cut] ?? '')) cut--; // keep a surrogate pair together
    const out = redact(this.pending.slice(0, cut), this.secrets);
    this.pending = this.pending.slice(cut);
    return out;
  }

  /** Redact and release everything held back. */
  end(): string {
    const out = redact(this.pending, this.secrets);
    this.pending = '';
    return out;
  }

  private matchSpans(): Array<[number, number]> {
    const spans: Array<[number, number]> = [];
    for (const m of this.pending.matchAll(USERINFO)) spans.push([m.index, m.index + m[0].length]);
    for (const secret of this.secrets) {
      for (let i = this.pending.indexOf(secret); i !== -1; i = this.pending.indexOf(secret, i + 1)) spans.push([i, i + secret.length]);
    }
    return spans;
  }
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

const SHELL_BUILTINS = new Set(['cd', 'chdir', 'pushd', 'popd', 'echo', 'set', 'export', 'call', 'if', 'for', 'exit',
  'true', 'false', 'test', '[', 'type', 'ver', 'cls', 'rem', 'command', 'exec', 'env', 'source', '.', 'setlocal', 'endlocal']);

/**
 * Whether `command` is one simple command: no unquoted control operator (`&`, `|`, `;`,
 * newline, grouping parens or substitution) that could run anything after its first word.
 */
function isSimpleCommand(command: string): boolean {
  let quote: string | null = null;
  for (const ch of command.trim()) {
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if ('&|;\n\r()`'.includes(ch)) return false;
  }
  return true;
}

/**
 * The leading word of a simple shell command, or null when it is not a plain executable
 * name or the command is compound (the shell then decides, e.g. running a `||` fallback).
 */
function leadingExecutable(command: string): string | null {
  if (!isSimpleCommand(command)) return null;
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
 * could not be started (a simple command whose executable does not resolve, or a spawn
 * error) → errored. A compound command always runs; its final exit code decides.
 * A command that ran is judged by its exit code alone, even one equal to the shell's
 * command-not-found code (127, or 9009 from cmd).
 */
export function runVerifyCommand(opts: VerifyRunOptions): Promise<VerifyRun> {
  const maxBytes = opts.maxBytes ?? VERIFY_LOG_MAX_BYTES;
  const startedAt = new Date().toISOString();
  const leading = leadingExecutable(opts.command);
  if (leading && !resolvable(leading, opts.cwd, opts.env)) {
    return Promise.resolve({ status: 'errored', exitCode: null, truncated: false, startedAt, finishedAt: new Date().toISOString(),
      log: redact(`verify command not found: ${leading}\n`, opts.secrets ?? []) });
  }
  return new Promise((resolvePromise) => {
    // Raw output is redacted before anything is evicted; only redacted bytes are dropped by the cap.
    const redactor = new StreamRedactor(opts.secrets ?? []);
    const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };
    let chunks: Buffer[] = [];
    let size = 0;
    let dropped = false;
    const commit = (text: string) => {
      if (!text) return;
      const chunk = Buffer.from(text, 'utf8');
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes * 2) {
        const all = Buffer.concat(chunks);
        let start = all.length - maxBytes;
        while (start < all.length && (all[start]! & 0xc0) === 0x80) start++; // keep whole characters
        const tail = all.subarray(start);
        chunks = [tail]; size = tail.length; dropped = true;
      }
    };
    const append = (stream: keyof typeof decoders) => (chunk: Buffer) => commit(redactor.push(decoders[stream].write(chunk)));
    let timedOut = false;
    let spawnError: Error | null = null;
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      commit(redactor.push(decoders.stdout.end() + decoders.stderr.end()));
      if (spawnError) commit(redactor.push(`\n${spawnError.message}\n`));
      commit(redactor.end());
      const { log, truncated } = capTail(Buffer.concat(chunks).toString('utf8'), maxBytes, dropped);
      const status: VerificationStatus = timedOut ? 'timed_out'
        : spawnError || exitCode === null ? 'errored'
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
    child.stdout?.on('data', append('stdout'));
    child.stderr?.on('data', append('stderr'));
    child.on('error', (err) => { spawnError = err; finish(null); });
    child.on('close', (code) => finish(code));
  });
}
