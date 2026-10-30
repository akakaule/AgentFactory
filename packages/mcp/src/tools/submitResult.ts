import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { McpCore } from '../types.js';
import type { AddTaskMetricsInput } from '@agentfactory/core';
import { LinkSchema, MetricsSchema, taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';
import { forAgent } from '../content.js';
import { NO_HARD_WRAP } from '../protocol.js';
import { checkSubmission } from '../git.js';
import { localizeRepo, type ServerOptions } from '../server.js';

export function registerSubmitResult(server: McpServer, core: McpCore, opts: ServerOptions = {}): void {
  server.registerTool(
    'submit_result',
    {
      title: 'Submit result',
      description:
        'Attach your deliverable to the task you are working on and move it to In Review. Only valid while the task is In Progress. ' +
        'The payload depends on the task\'s stage (see `protocol.stage` in your claim): a `description`-stage task takes { summary, spec, acceptanceCriteria } (the rewritten feature description); a `plan`-stage task takes { summary, plan } (the implementation plan); an `implementation`-stage task takes { summary, links } as below. Wrong-shape payloads are rejected with the expected fields named. ' +
        `${NO_HARD_WRAP} ` +
        'For the implementation stage, complete the `protocol.finish` steps first — commit everything, run the verify command, push the branch to origin, and remove the worktree. ' +
        'If the workspace configures a verify command (it appears in `protocol.finish`), pass its reported outcome as `verification` (e.g. "all tests + build green"); the submit is rejected without it unless a task_git verify run passed on the submitted commit. ' +
        'For the implementation stage, also pass `criteria`: one { id, claim } per acceptance criterion, using the ids listed in `protocol.finish` (AC1, AC2, …) — a sentence on how the change meets it and which test proves it (at most 600 characters). An unknown or repeated id is rejected with the valid ids named. ' +
        'If your claim says the task skipped the spec stage, also pass `acceptanceCriteria` (the numbered criteria you wrote) and claim against their ids; it is rejected on a task that already has criteria. ' +
        'This tool VERIFIES that protocol before accepting: it checks the claim branch exists on origin, that origin is not behind your local commits, and that the task worktree is gone. If a check fails it returns the exact command to run and leaves the task In Progress so you can fix it and resubmit. (Verification is skipped only where it cannot run: a legacy task with no recorded branch, or a workspace whose repo the server cannot reach. Doc stages skip it entirely — they never touch the repo.) ' +
        "Include links to where the work lives: the branch you worked in (kind 'branch', label = the branch name). Do not open a pull request — the board opens it after the implementation review is approved. " +
        'If you know (or can estimate) your session usage, include best-effort `metrics` ({ model, tokensIn, tokensOut, costUsd }) — they power the board\'s analytics. Omit anything you don\'t know; unreported is shown as n/a, never zero.',
      inputSchema: {
        key: taskKey,
        summary: z.string().min(1),
        claimAt: z.string().min(1).optional(),
        spec: z.string().min(1).optional(),
        acceptanceCriteria: z.string().min(1).optional(),
        plan: z.string().min(1).optional(),
        verification: z.string().min(1).optional(),
        criteria: z.array(z.object({ id: z.string().min(1), claim: z.string().min(1).max(600) })).optional(),
        links: z.array(LinkSchema).default([]),
        metrics: MetricsSchema.optional(),
      },
    },
    async ({ key, summary, claimAt, spec, acceptanceCriteria, plan, verification, criteria, links, metrics }) => {
      try {
        // Verify the finish protocol ran before core flips the status (git stays out of
        // core). Doc stages never touch the repo — nothing to verify. The repoPath override
        // matters here: a remote worker's guard must inspect the LOCAL clone, not the
        // board's path (which doesn't exist on this machine and would degrade to skip).
        const detail = localizeRepo(await core.getTask(key), opts);
        const guard =
          detail.stage === 'implementation'
            ? await checkSubmission({ repoPath: detail.repoPath, branch: detail.branch, key, auth: await core.resolveGitAuth(detail.workspace) })
            : { ok: true as const, revision: undefined };
        if (!guard.ok) {
          return { isError: true as const, content: [{ type: 'text' as const, text: guard.message ?? 'Submission blocked.' }] };
        }
        const input: Parameters<McpCore['submitResult']>[1] & { executionId?: string } = { summary, links }; // explicit build for exactOptionalPropertyTypes
        const executionId = opts.executionContext?.get() ?? opts.executionId;
        if (executionId !== undefined) input.executionId = executionId;
        if (claimAt !== undefined) input.claimAt = claimAt;
        if (spec !== undefined) input.spec = spec;
        if (acceptanceCriteria !== undefined) input.acceptanceCriteria = acceptanceCriteria;
        if (plan !== undefined) input.plan = plan;
        if (verification !== undefined) input.verification = verification;
        if (criteria !== undefined) input.criteria = criteria;
        // the revision the guard verified on origin — core records it so a later push can't inherit this review
        if (guard.revision) input.revision = guard.revision;
        let task = await core.submitResult(key, input);
        let metricsNote = '';
        if (metrics && Object.keys(metrics).length > 0) {
          const input: AddTaskMetricsInput & { executionId?: string } = {};       // explicit build for exactOptionalPropertyTypes
          if (executionId !== undefined) input.executionId = executionId;
          if (metrics.model !== undefined) input.model = metrics.model;
          if (metrics.tokensIn !== undefined) input.tokensIn = metrics.tokensIn;
          if (metrics.tokensOut !== undefined) input.tokensOut = metrics.tokensOut;
          if (metrics.costUsd !== undefined) input.costUsd = metrics.costUsd;
          // Best-effort: the submit is already committed — a transient metrics failure must not
          // report the whole call as an error (the task is in_review; a retry would be rejected).
          try {
            task = await core.addTaskMetrics(key, input);
          } catch (err) {
            metricsNote = `\n\n(note: the submit SUCCEEDED — the task is in review — but recording metrics failed: ${(err as Error).message}. Do not resubmit.)`;
          }
        }
        return { content: [{ type: 'text', text: JSON.stringify(forAgent(task), null, 2) + metricsNote }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
