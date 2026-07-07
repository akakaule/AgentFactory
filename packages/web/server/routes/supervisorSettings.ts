import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { isSupervisorKind } from '@agentfactory/core';
import type { Core } from '../types.js';
import { supervisorSettingsBody } from '../schemas.js';

/**
 * Board-editable supervisor settings (app_kv). The three supervisors still boot from their JSON
 * files (db path + secrets); these override the tunable knobs live — each supervisor re-reads them
 * every tick. GET returns all three kinds; PUT replaces one kind's settings (core validates fields).
 */
export function supervisorSettingsRoutes(core: Core) {
  const r = new Hono();

  r.get('/', (c) => c.json(core.getAllSupervisorSettings()));

  r.put('/:kind', zValidator('json', supervisorSettingsBody), (c) => {
    const kind = c.req.param('kind');
    if (!isSupervisorKind(kind)) return c.json({ error: `unknown supervisor kind '${kind}'` }, 404);
    return c.json(core.setSupervisorSettings(kind, c.req.valid('json')));
  });

  return r;
}
