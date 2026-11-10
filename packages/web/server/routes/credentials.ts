import { Hono } from 'hono';
import type { Core } from '../types.js';

/** Recorded git-credential health per workspace (the board banner and the workspace badges). */
export function credentialRoutes(core: Core): Hono {
  const r = new Hono();
  r.get('/', (c) => c.json(core.listCredentialHealth()));
  return r;
}
