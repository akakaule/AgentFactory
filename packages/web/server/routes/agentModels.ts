import { Hono } from 'hono';
import { MODEL_CATALOG, ValidationError } from '@agentfactory/core';
import type { Core } from '../types.js';
import { rejectService } from '../auth.js';

/** Board-editable agent model settings (app_kv): per-role engine/model/effort, globally and per
 *  workspace. Supervisors read them every tick (GET /api/agent/agent-models) — see core/agentModels.ts. */
export function agentModelRoutes(core: Core) {
  const r = new Hono();

  const view = () => ({ settings: core.getAgentModels(), defaults: core.getAgentModelDefaults(), catalog: MODEL_CATALOG });

  r.get('/', (c) => c.json(view()));

  // Human-only: an agent must never choose its own model or effort. The body is the WHOLE document;
  // core validates it (ValidationError → 400).
  r.put('/', rejectService, async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new ValidationError('a JSON body is required'); }
    core.setAgentModels(body);
    return c.json(view());
  });

  return r;
}
