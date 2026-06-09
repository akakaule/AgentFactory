import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import { toToolError } from '../errors.js';

export function registerGetNextTask(server: McpServer, core: Core): void {
  server.registerTool(
    'get_next_task',
    {
      title: 'Get next task',
      description:
        'Claim the next queued task and move it to In Progress. Returns the full task detail, or { task: null } if the queue is empty. Call this when you are ready to start work.',
      inputSchema: {},
    },
    async () => {
      try {
        const task = core.claimNextTask();
        if (task === null) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ task: null, message: 'No queued tasks.' }),
              },
            ],
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
