import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from './types.js';
import { registerListTasks } from './tools/listTasks.js';
import { registerGetNextTask } from './tools/getNextTask.js';
import { registerGetTask } from './tools/getTask.js';
import { registerAddComment } from './tools/addComment.js';
import { registerSubmitResult } from './tools/submitResult.js';
import { registerUpdateStatus } from './tools/updateStatus.js';

export function buildServer(core: Core): McpServer {
  const server = new McpServer({ name: 'agentfactory', version: '0.1.0' });
  registerListTasks(server, core);
  registerGetNextTask(server, core);
  registerGetTask(server, core);
  registerAddComment(server, core);
  registerSubmitResult(server, core);
  registerUpdateStatus(server, core);
  return server;
}
