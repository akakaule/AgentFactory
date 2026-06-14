import type { Status, Actor, Task, Workspace, TaskDetail, Activity, AddTaskMetricsInput } from '@agentfactory/core';

/**
 * The slice of `@agentfactory/core` the dispatcher drives. Declaring the surface
 * (instead of importing the concrete `Core`) lets tests pass a real in-memory core
 * OR a fake — and documents exactly which ops the supervisor touches.
 */
export interface DispatcherCore {
  listTasks(opts: { status?: Status | undefined; workspace?: string | undefined }): Task[];
  listWorkspaces(): Workspace[];
  updateStatus(key: string, status: Status, actor: Actor): TaskDetail;
  addComment(key: string, input: { actor: Actor; body: string }): Activity;
  addTaskMetrics(key: string, input: AddTaskMetricsInput): TaskDetail;
  // live agent status: keep a running session warm, and end it when the process exits
  touchAgentSession(key: string): void;
  endAgentSession(key: string): void;
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
}

export type SpawnFn = (req: SpawnRequest) => SpawnedChild;

/** A per-session log file sink (stdout+stderr streamed in). */
export interface LogWriter {
  write(chunk: string): void;
  end(): void;
}

/** How to launch the agentfactory MCP server inside each worker session. */
export interface McpServerSpec {
  command: string;
  args: string[];
}

/** Everything the supervisor needs from the outside world — all injectable for tests. */
export interface DispatcherDeps {
  core: DispatcherCore;
  spawn: SpawnFn;
  /** Resolves the `claude` CLI command (cached after first call). */
  resolveClaude: () => string;
  /** The agentfactory MCP server launch spec, inlined into each session's --mcp-config. */
  mcp: McpServerSpec;
  /** Opens a per-session log file. */
  openLog: (path: string) => LogWriter;
  /** Writes a per-session MCP config file (passed to `claude --mcp-config <path>`). */
  writeMcp: (path: string, contents: string) => void;
  /** Directory for per-session log + MCP config files. */
  logDir: string;
  /** Epoch milliseconds — injected so session timeouts are testable without real time. */
  now: () => number;
  /** Base environment merged into each spawned session (production: `process.env`). */
  baseEnv?: NodeJS.ProcessEnv | undefined;
  /** Console sink (injectable so tests can assert skip-list warnings). */
  console?: Pick<Console, 'log' | 'warn' | 'error'> | undefined;
}
