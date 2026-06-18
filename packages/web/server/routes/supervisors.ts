import { Hono } from 'hono';
import type { Core } from '../types.js';

/**
 * Supervisor health: every dispatcher/reviewer with a derived `healthy` flag. The Live view
 * polls this (like /api/agents) so an operator can tell at a glance the loop is alive without
 * reading a console. Read-only; guarded by the same /api/* auth as every other read.
 */
export function supervisorRoutes(core: Core): Hono {
  const r = new Hono();
  r.get('/', (c) => c.json(core.listSupervisors()));
  return r;
}
