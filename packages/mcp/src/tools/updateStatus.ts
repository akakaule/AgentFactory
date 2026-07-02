import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import { AgentStatusEnum, taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerUpdateStatus(server: McpServer, core: Core): void {
  server.registerTool(
    'update_status',
    {
      title: 'Update status',
      description:
        'Move a task to a new status. As an agent, the sane uses are: move a task to "blocked" when you are stuck waiting on something, or move it from "blocked" back to "in_progress" when the blocker is resolved. When moving to "blocked", ALWAYS pass `note` with a one-line reason for why you are stuck (e.g. "needs a DB password", "ADO work item lacks acceptance criteria") — it is shown to the human as the focused block reason. Do NOT use this to move a task to "in_review" or "done" — use submit_result to hand off for review; humans approve.',
      inputSchema: {
        key: taskKey,
        status: AgentStatusEnum,
        note: z.string().optional().describe('One-line reason for the status change; required in spirit when moving to "blocked" — surfaced to the human as the block reason.'),
      },
    },
    async ({ key, status, note }) => {
      try {
        // A 'delivering' task is owned by the watcher supervisor — an agent must not touch it
        // (its edges into/out of delivery exist in core only for the watcher, which drives core
        // directly). Guard here so the agent gets a clear message rather than a raw transition error.
        const current = core.getTask(key);
        if (current.status === 'delivering') {
          return {
            isError: true as const,
            content: [{ type: 'text' as const, text: 'this task is in delivery verification — the watcher owns it; a human can force-complete or re-queue from the board' }],
          };
        }
        const task = core.updateStatus(key, status, 'agent', null, note);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
