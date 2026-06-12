import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import { taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';
import { detailContent } from '../content.js';

export function registerGetTask(server: McpServer, core: Core): void {
  server.registerTool(
    'get_task',
    {
      title: 'Get task',
      description:
        'Fetch the full detail of a specific task by key (e.g. AF-42), including its activity log and result links. Spec images attached to the task arrive as image content blocks after the JSON.',
      inputSchema: { key: taskKey },
    },
    async ({ key }) => {
      try {
        const task = core.getTask(key);
        return { content: detailContent(core, task) };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
