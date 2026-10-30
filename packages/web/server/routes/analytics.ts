import { Hono } from 'hono';
import type { Core } from '../types.js';

export function analyticsRoutes(core: Core) {
  const r = new Hono();
  // all-time per-task metric rows + stranded releases; the client filters/aggregates
  r.get('/', (c) => c.json(core.analyticsRows()));
  // one UTC month of reported usage by day × workspace × model (core rejects a malformed month)
  r.get('/spend', (c) => {
    const month = c.req.query('month');
    const workspace = c.req.query('workspace');
    return c.json(core.spendByDay({
      ...(month !== undefined ? { month } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
    }));
  });
  return r;
}
