import type { Status, Actor, Task, TaskDetail, Activity, BranchDiff } from '@agentfactory/core';
import type { ReviewEngine } from './config.js';

/**
 * The slice of `@agentfactory/core` the reviewer drives. Declaring the surface (instead of
 * importing the concrete `Core`) lets tests pass a real in-memory core OR a fake, and
 * documents exactly which ops the supervisor touches. The reviewer is ADVISORY: it reads
 * tasks and posts one agent comment per review; it never approves, requests changes, or
 * changes status (a clean doc-stage verdict auto-advances via core's add_comment hook).
 */
export interface ReviewerCore {
  listTasks(opts: { status?: Status | undefined; workspace?: string | undefined }): Task[];
  getTask(key: string): TaskDetail;
  addComment(key: string, input: { actor: Actor; body: string }): Activity;
}

/** Minimal readable-stream surface (node's `Readable` satisfies it). */
export interface StreamLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
}

/** Minimal child-process surface the supervisor needs (node's `ChildProcess` satisfies it). */
export interface SpawnedChild {
  readonly pid?: number | undefined;
  stdout: StreamLike | null;
  stderr: StreamLike | null;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface SpawnRequest {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The review prompt, fed to the engine on STDIN (diffs are large/arbitrary — not argv). */
  stdin?: string | undefined;
}

export type SpawnFn = (req: SpawnRequest) => SpawnedChild;

/** A per-review log file sink (engine stdout+stderr streamed in for the transcript). */
export interface LogWriter {
  write(chunk: string): void;
  end(): void;
}

/** Everything the supervisor needs from the outside world — all injectable for tests. */
export interface ReviewerDeps {
  core: ReviewerCore;
  spawn: SpawnFn;
  /** Resolves a review engine CLI command (cached per engine after first call). */
  resolveEngine: (engine: ReviewEngine) => string;
  /** Computes a branch's merge-base diff (production: core's `branchDiff`). */
  computeDiff: (repoPath: string, branch: string) => Promise<BranchDiff>;
  /** Opens a per-review transcript log file. */
  openLog: (path: string) => LogWriter;
  /** Reads an engine's captured final message (codex `--output-last-message` file); '' if absent. */
  readOutput: (path: string) => string;
  /** Directory for per-review log + engine output files. */
  logDir: string;
  /** Epoch milliseconds — injected so review timeouts are testable without real time. */
  now: () => number;
  /** Base environment merged into each spawned review (production: `process.env`). */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  /** Console sink (injectable so tests can assert skip-list warnings). */
  console?: Pick<Console, 'log' | 'warn' | 'error'> | undefined;
}
