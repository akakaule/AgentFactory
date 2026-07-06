import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Core } from '../types.js';
import { agentPromptsBody } from '../schemas.js';

/** Global default agent system prompts (app_kv). The effective prompt an agent runs with is the
 *  per-workspace override (PATCH /api/workspaces/:name) falling back to these globals. */
export function agentPromptRoutes(core: Core) {
  const r = new Hono();

  r.get('/', (c) => c.json(core.getGlobalPrompts()));

  // PUT merges the posted keys into the global set (a blank value clears that key); unknown keys are
  // ignored by core. Returns the resulting set.
  r.put('/', zValidator('json', agentPromptsBody), (c) => c.json(core.setGlobalPrompts(c.req.valid('json'))));

  return r;
}
