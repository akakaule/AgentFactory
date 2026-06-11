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
        'Finish protocol — run it before calling this tool: (1) commit all work in the worktree, (2) `git push -u origin task/<task-key>`, (3) remove the worktree from the main repo: `git worktree remove <repoPath>/.worktrees/<task-key>` then `git worktree prune` (remove refuses on uncommitted changes — that is your signal something is not committed). The branch is the durable record of the work; the worktree must not outlive the submission. ' +
        "Include links to where the work lives: the branch you worked in (kind 'branch', label = the branch name), plus a PR link if one exists.",
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
