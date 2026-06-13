import { EventEmitter } from 'node:events';
import { openCore, type Core, type Stage } from '@agentfactory/core';
import type { DispatcherConfig } from '../src/config.js';
import type { DispatcherDeps, LogWriter, SpawnFn, SpawnRequest } from '../src/types.js';

/** A fake `claude` child the test drives: push stdout/stderr, then exit or fail. */
export class FakeChild extends EventEmitter {
  readonly pid = 4321;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  killed = false;
  killSignal: NodeJS.Signals | number | undefined;
  private exited = false;

  emitStdout(text: string): void {
    this.stdout.emit('data', text);
  }
  emitStderr(text: string): void {
    this.stderr.emit('data', text);
  }
  exit(code: number | null, signal: NodeJS.Signals | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.emit('exit', code, signal);
  }
  fail(err: Error): void {
    this.emit('error', err);
  }
  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed = true;
    this.killSignal = signal;
    // a real SIGKILL terminates the child → 'exit' fires; mirror that so the
    // supervisor's timeout path runs to completion within one tick.
    this.exit(null, typeof signal === 'string' ? signal : 'SIGKILL');
    return true;
  }
}

export interface SpawnRecord {
  req: SpawnRequest;
  child: FakeChild;
}

/** A spawn fn that records every launch and hands back a controllable child. */
export function makeFakeSpawn(): { spawn: SpawnFn; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  const spawn: SpawnFn = (req) => {
    const child = new FakeChild();
    calls.push({ req, child });
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { spawn, calls };
}

export interface FakeConsole {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  logs: string[];
  warnings: string[];
  errors: string[];
}

export function makeFakeConsole(): FakeConsole {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    log: (...a) => void logs.push(a.map(String).join(' ')),
    warn: (...a) => void warnings.push(a.map(String).join(' ')),
    error: (...a) => void errors.push(a.map(String).join(' ')),
    logs,
    warnings,
    errors,
  };
}

export function noopLog(): LogWriter {
  return { write: () => {}, end: () => {} };
}

/** Open a fresh in-memory core with one workspace seeded. */
export function makeCore(workspace = 'ws', repoPath = '/repo/ws'): Core {
  const core = openCore(':memory:');
  core.createWorkspace({ name: workspace, repoPath });
  return core;
}

/** Create a task and move it to queued; returns its key. */
export function seedQueued(core: Core, workspace: string, title: string): string {
  const t = core.createTask({ title, spec: 'spec', acceptanceCriteria: 'criteria', workspace });
  core.updateStatus(t.key, 'queued', 'human');
  return t.key;
}

/** Create a queued task pinned to a specific pipeline stage; returns its key. */
export function seedQueuedStage(core: Core, workspace: string, title: string, stage: Stage): string {
  const t = core.createTask({ title, spec: 'spec', acceptanceCriteria: 'criteria', workspace, stage });
  core.updateStatus(t.key, 'queued', 'human');
  return t.key;
}

export function makeConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    db: ':memory:',
    workspaces: ['ws'],
    maxConcurrent: 1,
    pollSeconds: 15,
    permissionMode: 'acceptEdits',
    claudeArgs: [],
    maxSessionMinutes: 60,
    maxAttempts: 2,
    ...overrides,
  };
}

export interface DepsOverrides {
  now?: () => number;
  console?: FakeConsole;
  spawn?: SpawnFn;
  writeMcp?: (path: string, contents: string) => void;
}

export function makeDeps(core: Core, spawn: SpawnFn, overrides: DepsOverrides = {}): DispatcherDeps {
  return {
    core,
    spawn,
    resolveClaude: () => 'claude.exe',
    mcp: { command: 'node', args: ['/abs/mcp/dist/index.js'] },
    openLog: () => noopLog(),
    writeMcp: overrides.writeMcp ?? (() => {}),
    logDir: '/logs',
    now: overrides.now ?? (() => 0),
    baseEnv: {},
    console: overrides.console,
  };
}
