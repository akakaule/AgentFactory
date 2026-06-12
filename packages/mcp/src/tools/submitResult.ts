import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import type { AddTaskMetricsInput } from '@agentfactory/core';
import { LinkSchema, MetricsSchema, taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';
import { checkSubmission } from '../git.js';

export function registerSubmitResult(server: McpServer, core: Core): void {
  server.registerTool(
    'submit_result',
    {
      title: 'Submit result',
      description:
        'Attach a result summary and links to the task you are working on and move it to In Review for human approval. Only valid while the task is In Progress. ' +
        'Before calling this, complete the `protocol.finish` steps from your claim payload — commit everything, push the branch to origin, and remove the worktree. ' +
        'This tool VERIFIES that protocol before accepting: it checks the claim branch exists on origin, that origin is not behind your local commits, and that the task worktree is gone. If a check fails it returns the exact command to run and leaves the task In Progress so you can fix it and resubmit. (Verification is skipped only where it cannot run: a legacy task with no recorded branch, or a workspace whose repo the server cannot reach.) ' +
        "Include links to where the work lives: the branch you worked in (kind 'branch', label = the branch name), plus a PR link if one exists. " +
        'If you know (or can estimate) your session usage, include best-effort `metrics` ({ model, tokensIn, tokensOut, costUsd }) — they power the board\'s analytics. Omit anything you don\'t know; unreported is shown as n/a, never zero.',
      inputSchema: { key: taskKey, summary: z.string().min(1), links: z.array(LinkSchema).default([]), metrics: MetricsSchema.optional() },
    },
    async ({ key, summary, links, metrics }) => {
      try {
        // Verify the finish protocol ran before core flips the status (git stays out of core).
        const detail = core.getTask(key);
        const guard = await checkSubmission({ repoPath: detail.repoPath, branch: detail.branch, key });
        if (!guard.ok) {
          return { isError: true as const, content: [{ type: 'text' as const, text: guard.message ?? 'Submission blocked.' }] };
        }
        let task = core.submitResult(key, { summary, links });
        if (metrics && Object.keys(metrics).length > 0) {
          const input: AddTaskMetricsInput = {};       // explicit build for exactOptionalPropertyTypes
          if (metrics.model !== undefined) input.model = metrics.model;
          if (metrics.tokensIn !== undefined) input.tokensIn = metrics.tokensIn;
          if (metrics.tokensOut !== undefined) input.tokensOut = metrics.tokensOut;
          if (metrics.costUsd !== undefined) input.costUsd = metrics.costUsd;
          task = core.addTaskMetrics(key, input);
        }
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
