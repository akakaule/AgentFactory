import { Hono } from 'hono';
import type { Core } from '../types.js';

export function analyticsRoutes(core: Core) {
  const r = new Hono();
  // all-time per-task metric rows + stranded releases; the client filters/aggregates
  r.get('/', (c) => c.json(core.analyticsRows()));
  r.get('/token-trend', (c) => {
    const workspace = c.req.query('workspace');
    return c.json(core.tokenTrend(workspace !== undefined ? { workspace } : {}));
  });
  return r;
}
