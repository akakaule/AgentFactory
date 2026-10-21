import { Hono } from 'hono';
import { z } from 'zod';
import type { Core } from '../types.js';
import { validated } from '../validate.js';
import { rejectService } from '../auth.js';

const settingsBody = z.record(z.unknown());

export function intakeRoutes(core: Core): Hono {
  const r = new Hono();
  r.get('/', rejectService, (c) => c.json(core.getIntakeSettings()));
  r.put('/', rejectService, validated('json', settingsBody), (c) => c.json(core.setIntakeSettings(c.req.valid('json'))));
  // Keep the nested spelling as a compatibility alias for early clients.
  r.get('/settings', rejectService, (c) => c.json(core.getIntakeSettings()));
  r.put('/settings', rejectService, validated('json', settingsBody), (c) => c.json(core.setIntakeSettings(c.req.valid('json'))));
  return r;
}
