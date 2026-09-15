import { Hono } from 'hono';
import { validated } from '../validate.js';
import type { Core } from '../types.js';
import { engineSettingsBody } from '../schemas.js';
import { rejectService } from '../auth.js';

/** Board-wide agent engine availability (app_kv). Supervisors read it every tick and route a
 *  disabled engine's stages to the other engine — see core/engineSettings.ts. */
export function engineRoutes(core: Core) {
  const r = new Hono();

  r.get('/', (c) => c.json(core.getEngineSettings()));

  // Human-only: an agent must never switch its own engine off or on.
  r.put('/', rejectService, validated('json', engineSettingsBody), (c) => c.json(core.setEngineSettings(c.req.valid('json'))));

  return r;
}
