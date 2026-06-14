import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from './types.js';
import { registerListTasks } from './tools/listTasks.js';
import { registerGetNextTask } from './tools/getNextTask.js';
import { registerGetTask } from './tools/getTask.js';
import { registerAddComment } from './tools/addComment.js';
import { registerSubmitResult } from './tools/submitResult.js';
import { registerUpdateStatus } from './tools/updateStatus.js';
import { registerReportProgress } from './tools/reportProgress.js';

/** Deploy-time defaults; env is read at the entry point, not in tools. */
export interface ServerOptions {
  defaultWorkspace?: string | undefined;
  workerLabel?: string | undefined; // recorded as claimed_by on every claim
}

export function buildServer(core: Core, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: 'agentfactory', version: '0.1.0' });
  registerListTasks(server, core, opts);
  registerGetNextTask(server, core, opts);
  registerGetTask(server, core);
  registerAddComment(server, core);
  registerSubmitResult(server, core);
  registerUpdateStatus(server, core);
  registerReportProgress(server, core);
  return server;
}
