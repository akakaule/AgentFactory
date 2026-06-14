import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import type { Core } from '../types.js';

// External supervisors (future cloud runners) report liveness/milestones here; the local
// dispatcher and MCP agents write through Core directly. A message records a milestone; its
// absence is a plain liveness ping. Guarded by the same /api/* auth as every other write.
const heartbeatBody = z.object({
  key: z.string().min(1),
  message: z.string().min(1).max(200).optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
});

export function agentRoutes(core: Core): Hono {
  const r = new Hono();

  // every currently-running agent (fleet view + per-task drawer poll this)
  r.get('/', (c) => c.json(core.listLiveAgents()));

  r.post('/heartbeat', zValidator('json', heartbeatBody), (c) => {
    const b = c.req.valid('json');
    if (b.message !== undefined) {
      const input: { message: string; tokensIn?: number; tokensOut?: number } = { message: b.message };
      if (b.tokensIn !== undefined) input.tokensIn = b.tokensIn;
      if (b.tokensOut !== undefined) input.tokensOut = b.tokensOut;
      core.reportProgress(b.key, input);
    } else {
      core.touchAgentSession(b.key);
    }
    return c.body(null, 204);
  });

  r.post('/:key/end', (c) => {
    core.endAgentSession(c.req.param('key'));
    return c.body(null, 204);
  });

  return r;
}
