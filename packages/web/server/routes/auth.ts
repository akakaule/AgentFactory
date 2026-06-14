import { Hono } from 'hono';
import type { Core } from '../types.js';
import { resolvePrincipal, type AuthConfig } from '../auth.js';

/**
 * Public auth surface. `whoami` reports the caller's identity (anon when no/invalid
 * credential) and never 401s — the SPA uses it to decide whether to prompt for a token.
 * Token minting is intentionally NOT an endpoint; it is a CLI operation (mintToken.ts).
 */
export function authRoutes(core: Core, config: AuthConfig): Hono {
  const r = new Hono();
  r.get('/whoami', (c) => c.json(resolvePrincipal(core, config, c) ?? { kind: 'anon' }));
  return r;
}
