import { EventEmitter } from 'node:events';
import { openCore, type Core, type Stage, type BranchDiff } from '@agentfactory/core';
import type { ReviewerConfig } from '../src/config.js';
import type { ReviewerDeps, LogWriter, SpawnFn, SpawnRequest } from '../src/types.js';

/** A fake engine child the test drives: push stdout/stderr, then exit or fail. */
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

const SPEC = 'the spec';
const AC = 'the acceptance criteria';

/**
 * Create a task at `stage` and legally walk it to `in_review`, submitting that stage's
 * deliverable (a branch link for implementation, so the diff is resolvable). Returns its key.
 */
export function seedInReview(
  core: Core,
  workspace: string,
  title: string,
  stage: Stage = 'implementation',
  branchLabel = 'feature/af-x',
): string {
  const t =
    stage === 'description'
      ? core.createTask({ title, spec: SPEC, workspace, stage }) // description writes its own AC
      : core.createTask({ title, spec: SPEC, acceptanceCriteria: AC, workspace, stage });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ workspace, claimedBy: 'worker' });
  if (stage === 'description') {
    core.submitResult(t.key, { summary: 'wrote description', spec: 'the rewritten spec', acceptanceCriteria: 'AC1; AC2' });
  } else if (stage === 'plan') {
    core.submitResult(t.key, { summary: 'wrote plan', plan: 'step 1; step 2' });
  } else {
    core.submitResult(t.key, {
      summary: 'implemented the feature',
      links: [{ kind: 'branch', label: branchLabel, url: 'https://example.test/branch' }],
    });
  }
  return t.key;
}

/** An `ai-review/v1` comment body with N findings (N=0 → clean). */
export function aiReviewBody(n: number, reviewer = 'codex'): string {
  const findings = Array.from({ length: n }, (_, i) => ({
    severity: 'warning',
    file: 'a.ts',
    line: i + 1,
    title: `finding ${i + 1}`,
    detail: 'why it matters',
  }));
  return [
    `ai-review/v1 - ${n === 0 ? 'clean' : `${n} findings`} (${reviewer})`,
    'a one-paragraph summary',
    '```json',
    JSON.stringify({ reviewer, verdict: n === 0 ? 'clean' : 'findings', findings }),
    '```',
  ].join('\n');
}

export function makeConfig(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return {
    db: ':memory:',
    workspaces: ['ws'],
    engine: 'codex',
    pollSeconds: 60,
    maxConcurrent: 1,
    reviewMinutes: 10,
    maxDiffChars: 120000,
    maxAttempts: 2,
    ...overrides,
  };
}

export interface DepsOverrides {
  now?: () => number;
  console?: FakeConsole;
  computeDiff?: (repoPath: string, branch: string) => Promise<BranchDiff>;
  readOutput?: (path: string) => string;
}

export function makeDeps(core: Core, spawn: SpawnFn, overrides: DepsOverrides = {}): ReviewerDeps {
  return {
    core,
    spawn,
    resolveEngine: (engine) => `${engine}.exe`,
    computeDiff:
      overrides.computeDiff ?? (async () => ({ baseRef: 'main', diff: 'diff --git a/a.ts b/a.ts\n+code', commits: 1 })),
    openLog: () => noopLog(),
    readOutput: overrides.readOutput ?? (() => ''),
    logDir: '/logs',
    now: overrides.now ?? (() => 0),
    baseEnv: {},
    console: overrides.console,
  };
}
