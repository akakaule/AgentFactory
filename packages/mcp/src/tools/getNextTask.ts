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
        'Before changing any code for the claimed task, create a dedicated git worktree under the task\'s workspace repository on a conventional feature branch: `git worktree add <repoPath>/.worktrees/<task-key> -b feature/<task-key>-<kebab-title>` (a repoPath of "." resolves against your current working directory) and do all work inside it. ' +
        '`<kebab-title>` is the task title lowercased with every run of non-alphanumeric characters replaced by "-", edge dashes trimmed, truncated to 40 characters — e.g. AF-12 "Barcode scanner intake form" → `feature/AF-12-barcode-scanner-intake-form`. ' +
        'If that branch already exists (the task came back to you via review feedback or a reopen), add the worktree from it without `-b` — continue on the existing branch so pushes update the same PR. The task\'s activity log carries the prior attempt and the feedback; read it before coding.',
      inputSchema: { workspace: z.string().min(1).optional() },
    },
    async ({ workspace }) => {
      try {
        const task = core.claimNextTask({ workspace: workspace ?? opts.defaultWorkspace, claimedBy: opts.workerLabel });
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
