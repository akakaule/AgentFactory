import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpCore } from './types.js';
import { registerListTasks } from './tools/listTasks.js';
import { registerGetNextTask } from './tools/getNextTask.js';
import { registerGetTask } from './tools/getTask.js';
import { registerCreateTask } from './tools/createTask.js';
import { registerAddComment } from './tools/addComment.js';
import { registerSubmitResult } from './tools/submitResult.js';
import { registerUpdateStatus } from './tools/updateStatus.js';
import { registerReportProgress } from './tools/reportProgress.js';

/** Deploy-time defaults; env is read at the entry point, not in tools. */
export interface ServerOptions {
  defaultWorkspace?: string | undefined;
  workerLabel?: string | undefined; // recorded as claimed_by on every claim
  /** Machine-local clone of the PINNED workspace (#46 remote workers): replaces the
   *  board-central task.repoPath in every path handed to the agent (protocol worktree,
   *  serialized detail) and in the submit guard, which must inspect THIS machine's repo. */
  repoPath?: string | undefined;
}

/** Swap the board-central repoPath for the machine-local clone — only for the pinned
 *  workspace; a task claimed from another workspace keeps its board path (no local clone
 *  is known for it, and the guard's cannot-reach fallback handles that as before). */
export function localizeRepo<T extends { workspace: string; repoPath: string }>(task: T, opts: ServerOptions): T {
  return opts.repoPath && task.workspace === opts.defaultWorkspace ? { ...task, repoPath: opts.repoPath } : task;
}

export function buildServer(core: McpCore, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'agentfactory', version: '0.1.0' });
  registerListTasks(server, core, opts);
  registerGetNextTask(server, core, opts);
  registerGetTask(server, core, opts);
  registerCreateTask(server, core, opts);
  registerAddComment(server, core);
  registerSubmitResult(server, core, opts);
  registerUpdateStatus(server, core);
  registerReportProgress(server, core);
  return server;
}
