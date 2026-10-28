import { Hono } from 'hono';
import { ValidationError } from '@agentfactory/core';
import type { Core } from '../types.js';
import { rejectService } from '../auth.js';

/** Board-editable model prices (app_kv): USD per 1M tokens, used by the OTLP receiver to price
 *  usage a CLI reports without a cost (Codex) — see core/modelPrices.ts. */
export function modelPriceRoutes(core: Core) {
  const r = new Hono();

  r.get('/', (c) => c.json({ prices: core.getModelPrices() }));

  // Human-only. The body is the WHOLE table; core validates it (ValidationError → 400).
  r.put('/', rejectService, async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { throw new ValidationError('a JSON body is required'); }
    return c.json({ prices: core.setModelPrices(body) });
  });

  return r;
}
