import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Core } from '../types.js';
import type { ServerOptions } from '../server.js';
import { toToolError } from '../errors.js';
import { detailContent } from '../content.js';
import { buildProtocol } from '../protocol.js';

export function registerGetNextTask(server: McpServer, core: Core, opts: ServerOptions = {}): void {
  server.registerTool(
    'get_next_task',
    {
      title: 'Get next task',
      description:
        'Claim the next queued task and move it to In Progress. Returns the full task detail — its workspace, the repoPath of the repository the task targets, and a `protocol` block — or { task: null } if the queue is empty. Spec images attached to the task arrive as image content blocks after the JSON; treat them as part of the brief. ' +
        'Pass `workspace` to claim only from that workspace; when omitted, the server\'s pinned workspace (AGENTFACTORY_WORKSPACE) applies if configured, otherwise the claim is global. Call this when you are ready to start work. ' +
        'The `protocol` block is the source of truth for how to work this task — computed fresh by the server on every claim, so it never goes stale the way this text can. Follow it verbatim. ' +
        '`protocol.stage` tells you what kind of deliverable this claim wants: `description` (write the feature description — no repository work at all), `plan` (write the implementation plan from a read-only look at the repo), or `implementation` (code). Doc stages have no git setup; their deliverable goes through submit_result fields per `protocol.finish`. ' +
        'For the implementation stage: `protocol.branch` is the server-named feature branch, `protocol.worktree` is where to work, `protocol.setup` is the exact `git worktree add` command to run before touching any code (it already encodes create-with-`-b` for a first claim vs. reuse-the-existing-branch for a reclaim, so do not improvise the branch name), and `protocol.finish` lists the steps to run before submit_result. ' +
        'The task\'s activity log carries any prior attempt and review feedback; read it before coding.',
      inputSchema: { workspace: z.string().min(1).optional() },
    },
    async ({ workspace }) => {
      try {
        const claimed = core.claimNextTask({ workspace: workspace ?? opts.defaultWorkspace, claimedBy: opts.workerLabel });
        if (claimed === null) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ task: null, message: 'No queued tasks.' }),
              },
            ],
          };
        }
        // branchCreated is the create-vs-reuse signal for the protocol; it must not
        // ride along in the serialized task detail.
        const { branchCreated, ...task } = claimed;
        // Doc stages always get a protocol (no branch involved); the implementation
        // stage keeps the legacy guard for pre-branch-feature rows left NULL.
        const protocol =
          task.stage !== 'implementation'
            ? buildProtocol({ stage: task.stage, repoPath: task.repoPath, key: task.key })
            : task.branch
              ? buildProtocol({ stage: task.stage, repoPath: task.repoPath, key: task.key, branch: task.branch, branchCreated })
              : undefined;
        return { content: detailContent(core, task, protocol ? { protocol } : undefined) };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
