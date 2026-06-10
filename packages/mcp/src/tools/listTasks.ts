import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import type { ServerOptions } from '../server.js';
import { StatusEnum } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerListTasks(server: McpServer, core: Core, opts: ServerOptions = {}): void {
  server.registerTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        'List all tasks on the board, optionally filtered by status and/or workspace. When workspace is omitted, the server\'s pinned workspace (AGENTFACTORY_WORKSPACE) applies if configured, otherwise all workspaces are listed. Returns an array of task summaries.',
      inputSchema: { status: StatusEnum.optional(), workspace: z.string().min(1).optional() },
    },
    async ({ status, workspace }) => {
      try {
        const tasks = core.listTasks({ status, workspace: workspace ?? opts.defaultWorkspace });
        return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
