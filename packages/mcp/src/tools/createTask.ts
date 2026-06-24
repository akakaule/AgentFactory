import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import type { CreateTaskInput } from '@agentfactory/core';
import type { ServerOptions } from '../server.js';
import { toToolError } from '../errors.js';

const stageSchema = z.enum(['description', 'plan', 'implementation']);

export function registerCreateTask(server: McpServer, core: Core, opts: ServerOptions = {}): void {
  server.registerTool(
    'create_task',
    {
      title: 'Create task',
      description:
        'File a NEW task onto the board to propose follow-up work you discover (e.g. a bug or refactor ' +
        'outside the task you are on). The task is created in BACKLOG, not queued: it will NOT run until a ' +
        'human triages and queues it, so this never auto-spawns another agent. It lands in the server\'s ' +
        'pinned workspace unless you pass `workspace`. Provide `title` and `spec` (what needs doing and why). ' +
        '`acceptanceCriteria` is required unless `stage` is `description` (that stage writes them); `stage` ' +
        'defaults to `implementation`. This does not touch the task you are currently working — submit that ' +
        'with submit_result as usual.',
      inputSchema: {
        title: z.string().min(1),
        spec: z.string().min(1),
        acceptanceCriteria: z.string().min(1).optional(),
        stage: stageSchema.optional(),
        workspace: z.string().min(1).optional(),
      },
    },
    async ({ title, spec, acceptanceCriteria, stage, workspace }) => {
      try {
        // explicit build for exactOptionalPropertyTypes; actor attributes the seed activity as the agent
        const input: CreateTaskInput = { title, spec, actor: 'agent' };
        if (acceptanceCriteria !== undefined) input.acceptanceCriteria = acceptanceCriteria;
        if (stage !== undefined) input.stage = stage;
        const ws = workspace ?? opts.defaultWorkspace; // pin to the server's workspace by default
        if (ws !== undefined) input.workspace = ws;
        const task = core.createTask(input);
        return { content: [{ type: 'text', text: JSON.stringify(task, null, 2) }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
