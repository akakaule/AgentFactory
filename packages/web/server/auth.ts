import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Actor } from '@agentfactory/core';
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
  | { kind: 'service'; label: string; supervisor: boolean }
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

/** Resolve the caller to a Principal. null = a credential is required but missing/invalid.
 *  Classification is EXPLICIT: a token is a service principal only when minted `isService` —
 *  a userless token without the flag is malformed and rejected, never silently promoted. */
export function resolvePrincipal(core: Core, config: AuthConfig, c: Context): Principal | null {
  if (config.mode === 'none') return ANON;
  const raw = bearerFrom(c);
  if (!raw) return null;
  const authed = core.authenticateToken(raw);
  if (!authed) return null;
  if (authed.userId != null) {
    return { kind: 'user', userId: authed.userId, email: authed.email ?? '', displayName: authed.displayName ?? '' };
  }
  if (authed.isService) return { kind: 'service', label: authed.label, supervisor: authed.isSupervisor };
  return null; // neither a user nor a declared service token — refuse rather than guess
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

/**
 * The #45 actor-from-token rule, enforced in one place: the `human|agent` machine axis is DERIVED
 * from the authenticated principal, never caller-asserted over the network. `service` ⇒ 'agent',
 * `user` ⇒ 'human'. `anon` (AUTH_MODE=none, local single-operator) ⇒ 'human' — preserving today's
 * local UX where the browser is the only caller.
 */
export function actorOf(c: Context): Actor {
  return principalOf(c).kind === 'service' ? 'agent' : 'human';
}

/** Route guard for the agent-ops surface (/api/agent/*): service tokens only. A user token must
 *  never claim/submit/report as an agent, and anon has the human board for everything it needs. */
export const requireService: MiddlewareHandler = async (c, next) => {
  if (principalOf(c).kind !== 'service')
    throw new HTTPException(403, { res: Response.json({ message: 'agent ops require a service token' }, { status: 403 }) });
  await next();
};

/** Route guard for supervisor-only agent ops (release-claim, delivery, workspace PAT): requires
 *  a service token minted with the supervisor capability. A worker session's token must never
 *  release another worker's claim or drive delivery state. */
export const requireSupervisor: MiddlewareHandler = async (c, next) => {
  const p = principalOf(c);
  if (p.kind !== 'service' || !p.supervisor)
    throw new HTTPException(403, { res: Response.json({ message: 'this op requires a supervisor service token (mint with --supervisor)' }, { status: 403 }) });
  await next();
};

/** Route guard for human lifecycle actions (approve, request-changes, status moves, …): reject
 *  service principals — an agent must never reach a human-only transition by calling the human
 *  route. anon passes (AUTH_MODE=none local operator). */
export const rejectService: MiddlewareHandler = async (c, next) => {
  if (principalOf(c).kind === 'service')
    throw new HTTPException(403, { res: Response.json({ message: 'this is a human action — service tokens use the /api/agent surface' }, { status: 403 }) });
  await next();
};
