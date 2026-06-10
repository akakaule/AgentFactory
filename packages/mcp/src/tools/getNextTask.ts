import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import { toToolError } from '../errors.js';

export function registerGetNextTask(server: McpServer, core: Core): void {
  server.registerTool(
    'get_next_task',
    {
      title: 'Get next task',
      description:
        'Claim the next queued task and move it to In Progress. Returns the full task detail, or { task: null } if the queue is empty. Call this when you are ready to start work. ' +
        'Before changing any code for the claimed task, create a dedicated git worktree in the repository you will modify (`git worktree add .worktrees/<task-key> -b task/<task-key>`) and do all work inside it. Record the worktree and branch via submit_result links when you deliver.',
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
