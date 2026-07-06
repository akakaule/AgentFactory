import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import type { AddTaskMetricsInput, SubmitResultInput } from '@agentfactory/core';
import { LinkSchema, MetricsSchema, taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';
import { checkSubmission } from '../git.js';

export function registerSubmitResult(server: McpServer, core: Core): void {
  server.registerTool(
    'submit_result',
    {
      title: 'Submit result',
      description:
        'Attach your deliverable to the task you are working on and move it to In Review. Only valid while the task is In Progress. ' +
        'The payload depends on the task\'s stage (see `protocol.stage` in your claim): a `description`-stage task takes { summary, spec, acceptanceCriteria } (the rewritten feature description); a `plan`-stage task takes { summary, plan } (the implementation plan); an `implementation`-stage task takes { summary, links } as below. Wrong-shape payloads are rejected with the expected fields named. ' +
        'For the implementation stage, complete the `protocol.finish` steps first — commit everything, run the verify command, push the branch to origin, and remove the worktree. ' +
        'If the workspace configures a verify command (it appears in `protocol.finish`), pass its reported outcome as `verification` (e.g. "all tests + build green"); the submit is rejected without it. ' +
        'This tool VERIFIES that protocol before accepting: it checks the claim branch exists on origin, that origin is not behind your local commits, and that the task worktree is gone. If a check fails it returns the exact command to run and leaves the task In Progress so you can fix it and resubmit. (Verification is skipped only where it cannot run: a legacy task with no recorded branch, or a workspace whose repo the server cannot reach. Doc stages skip it entirely — they never touch the repo.) ' +
        "Include links to where the work lives: the branch you worked in (kind 'branch', label = the branch name), plus a PR link if one exists. " +
        'If you know (or can estimate) your session usage, include best-effort `metrics` ({ model, tokensIn, tokensOut, costUsd }) — they power the board\'s analytics. Omit anything you don\'t know; unreported is shown as n/a, never zero.',
      inputSchema: {
        key: taskKey,
        summary: z.string().min(1),
        spec: z.string().min(1).optional(),
        acceptanceCriteria: z.string().min(1).optional(),
        plan: z.string().min(1).optional(),
        verification: z.string().min(1).optional(),
        links: z.array(LinkSchema).default([]),
        metrics: MetricsSchema.optional(),
      },
    },
    async ({ key, summary, spec, acceptanceCriteria, plan, verification, links, metrics }) => {
      try {
        // Verify the finish protocol ran before core flips the status (git stays out of
        // core). Doc stages never touch the repo — nothing to verify.
        const detail = core.getTask(key);
        const guard =
          detail.stage === 'implementation'
            ? await checkSubmission({ repoPath: detail.repoPath, branch: detail.branch, key, auth: core.resolveGitAuth(detail.workspace) })
            : { ok: true as const };
        if (!guard.ok) {
          return { isError: true as const, content: [{ type: 'text' as const, text: guard.message ?? 'Submission blocked.' }] };
        }
        const input: SubmitResultInput = { summary, links }; // explicit build for exactOptionalPropertyTypes
        if (spec !== undefined) input.spec = spec;
        if (acceptanceCriteria !== undefined) input.acceptanceCriteria = acceptanceCriteria;
        if (plan !== undefined) input.plan = plan;
        if (verification !== undefined) input.verification = verification;
        let task = core.submitResult(key, input);
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
