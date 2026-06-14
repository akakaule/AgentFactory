import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Core } from '../types.js';
import { taskKey } from '../schemas.js';
import { toToolError } from '../errors.js';

export function registerReportProgress(server: McpServer, core: Core): void {
  server.registerTool(
    'report_progress',
    {
      title: 'Report progress',
      description:
        'Report a short, live progress milestone for the task you are working on so a human can follow along on the board (e.g. "reading the spec", "writing tests", "running the build"). Call it as you start each step. This is ephemeral live status — it does NOT replace add_comment (durable notes) or submit_result. Optionally include tokensIn/tokensOut consumed so far.',
      inputSchema: {
        key: taskKey,
        message: z.string().min(1).max(200),
        tokensIn: z.number().int().nonnegative().optional(),
        tokensOut: z.number().int().nonnegative().optional(),
      },
    },
    async ({ key, message, tokensIn, tokensOut }) => {
      try {
        // explicit build for exactOptionalPropertyTypes (never pass an explicit undefined)
        const input: { message: string; tokensIn?: number; tokensOut?: number } = { message };
        if (tokensIn !== undefined) input.tokensIn = tokensIn;
        if (tokensOut !== undefined) input.tokensOut = tokensOut;
        core.reportProgress(key, input);
        return { content: [{ type: 'text', text: 'ok' }] };
      } catch (err) {
        return toToolError(err);
      }
    },
  );
}
