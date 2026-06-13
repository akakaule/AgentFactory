import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Core } from './types.js';

export type AuthMode = 'none' | 'token';
export interface AuthConfig { mode: AuthMode; }

/**
 * The authenticated caller. `anon` is local-dev (AUTH_MODE=none) and maps to no user;
 * `service` is a non-user bearer token (e.g. the ado-bridge loops); `user` is a real human.
 * Distinct from core's `Actor` machine axis — this is identity, not human-vs-agent.
 */
export type Principal =
  | { kind: 'user'; userId: number; email: string; displayName: string }
  | { kind: 'service'; label: string }
  | { kind: 'anon' };

declare module 'hono' {
  interface ContextVariableMap { principal: Principal; }
}

const ANON: Principal = { kind: 'anon' };

function bearerFrom(c: Context): string | null {
  const h = c.req.header('authorization');
  if (h && /^Bearer\s+/i.test(h)) return h.replace(/^Bearer\s+/i, '').trim();
  // EventSource cannot set an Authorization header, so /events also accepts ?access_token=.
  const q = c.req.query('access_token');
  return q ? q.trim() : null;
}

/** Resolve the caller to a Principal. null = a credential is required but missing/invalid. */
export function resolvePrincipal(core: Core, config: AuthConfig, c: Context): Principal | null {
  if (config.mode === 'none') return ANON;
  const raw = bearerFrom(c);
  if (!raw) return null;
  const authed = core.authenticateToken(raw);
  if (!authed) return null;
  if (authed.userId != null) {
    return { kind: 'user', userId: authed.userId, email: authed.email ?? '', displayName: authed.displayName ?? '' };
  }
  return { kind: 'service', label: authed.label };
}

/** Sets c.var.principal; 401s when a credential is required (token mode) but missing/invalid. */
export function authMiddleware(core: Core, config: AuthConfig): MiddlewareHandler {
  return async (c, next) => {
    const principal = resolvePrincipal(core, config, c);
    if (!principal) throw new HTTPException(401, { message: 'authentication required' });
    c.set('principal', principal);
    await next();
  };
}

export function principalOf(c: Context): Principal {
  return c.get('principal') ?? ANON;
}

/** The user id behind a request, or null for service/anon callers (the value core records). */
export function actorUserIdOf(c: Context): number | null {
  const p = principalOf(c);
  return p.kind === 'user' ? p.userId : null;
}
