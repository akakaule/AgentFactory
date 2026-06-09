import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import { StatusEnum } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerListTasks(server: McpServer, core: Core): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List all tasks on the board, optionally filtered by status. Returns an array of task summaries.',
      inputSchema: { status: StatusEnum.optional() },
    },
    async ({ status }) => {
      try {
        const tasks = core.listTasks({ status });
        return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
