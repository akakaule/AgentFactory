import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import { taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerGetTask(server: McpServer, core: Core): void {
  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description:
        'Fetch the full detail of a specific task by key (e.g. AF-42), including its activity log and result links.',
      inputSchema: { key: taskKey },
    },
    async ({ key }) => {
      try {
        const task = core.getTask(key);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
