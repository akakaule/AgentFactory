import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import { taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerAddComment(server: McpServer, core: Core): void {
  server.registerTool(
    'add_comment',
    {
      title: 'Add comment',
      description:
        'Append a comment to a task\'s activity log. Use this to record progress updates, decisions, or blockers while working on a task.',
      inputSchema: { key: taskKey, body: z.string().min(1) },
    },
    async ({ key, body }) => {
      try {
        const activity = core.addComment(key, { actor: 'agent', body });
        return { content: [{ type: 'text', text: JSON.stringify(activity, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
