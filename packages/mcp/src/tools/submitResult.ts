import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import { LinkSchema, taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerSubmitResult(server: McpServer, core: Core): void {
  server.registerTool(
    'submit_result',
    {
      title: 'Submit result',
      description:
        'Attach a result summary and links to the task you are working on and move it to In Review for human approval. Only valid while the task is In Progress. ' +
        "Include links to where the work lives: the git worktree and branch you worked in (kinds 'worktree' and 'branch'), plus a PR link if one exists.",
      inputSchema: { key: taskKey, summary: z.string().min(1), links: z.array(LinkSchema).default([]) },
    },
    async ({ key, summary, links }) => {
      try {
        const task = core.submitResult(key, { summary, links });
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
