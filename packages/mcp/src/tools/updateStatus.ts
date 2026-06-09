import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import { StatusEnum, taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerUpdateStatus(server: McpServer, core: Core): void {
  server.registerTool(
    'update_status',
    {
      title: 'Update status',
      description:
        'Move a task to a new status. As an agent, the sane uses are: move a task to "blocked" when you are stuck waiting on something, or move it from "blocked" back to "in_progress" when the blocker is resolved. Do NOT use this to move a task to "in_review" or "done" — use submit_result to hand off for review; humans approve.',
      inputSchema: { key: taskKey, status: StatusEnum },
    },
    async ({ key, status }) => {
      try {
        const task = core.updateStatus(key, status, 'agent');
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
