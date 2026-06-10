import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import type { ServerOptions } from '../server.js';
import { toToolError } from '../errors.js';

export function registerGetNextTask(server: McpServer, core: Core, opts: ServerOptions = {}): void {
  server.registerTool(
    'get_next_task',
    {
      title: 'Get next task',
      description:
        'Claim the next queued task and move it to In Progress. Returns the full task detail — including its workspace and the repoPath of the repository the task targets — or { task: null } if the queue is empty. ' +
        'Pass `workspace` to claim only from that workspace; when omitted, the server\'s pinned workspace (AGENTFACTORY_WORKSPACE) applies if configured, otherwise the claim is global. Call this when you are ready to start work. ' +
        'Before changing any code for the claimed task, create a dedicated git worktree under the task\'s workspace repository (`git worktree add <repoPath>/.worktrees/<task-key> -b task/<task-key>`; a repoPath of "." resolves against your current working directory) and do all work inside it. Record the worktree and branch via submit_result links when you deliver.',
      inputSchema: { workspace: z.string().min(1).optional() },
    },
    async ({ workspace }) => {
      try {
        const task = core.claimNextTask({ workspace: workspace ?? opts.defaultWorkspace });
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
