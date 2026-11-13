import type { DB } from '../db.js';
import type { User } from '../types.js';
import { nowIso } from '../time.js';
import { ValidationError } from '../errors.js';
import { generateToken, hashToken } from '../token.js';
import { findUserByEmail, findUserById, insertUser, toUser } from '../repo/users.js';
import { insertToken, findTokenByHash, touchToken } from '../repo/tokens.js';

/** Find-or-create a user by email (idempotent — email is UNIQUE). */
export function createUser(
  db: DB,
  input: { email: string; displayName?: string; oidcSubject?: string | null; isSystem?: boolean },
  now: () => string = nowIso,
): User {
  const existing = findUserByEmail(db, input.email);
  if (existing) return toUser(existing);
  const id = insertUser(db, {
    email: input.email,
    displayName: input.displayName ?? '',
    oidcSubject: input.oidcSubject ?? null,
    isSystem: input.isSystem ?? false,
    createdAt: now(),
  });
  return toUser(findUserById(db, id)!);
}

export interface CreatedApiToken {
  token: string; // raw bearer — shown once, never persisted
  id: number; label: string; userId: number | null; isService: boolean; isSupervisor: boolean; delegate: boolean;
}

/** Mint a bearer token (optionally bound to a user; otherwise a service token). `isSupervisor`
 *  grants the supervisor-only agent ops (release-claim, delivery, workspace PAT) — mint it only
 *  for dispatcher/reviewer/watcher processes, never for worker sessions. `delegate` marks a
 *  user-bound token an agent uses on that user's behalf (AF-202): it acts as the user on the human
 *  routes and its activity rows also record the token label — so it must name a user and can never
 *  carry the service or supervisor capability. */
export function createApiToken(
  db: DB,
  input: { label: string; userId?: number | null; isService?: boolean; isSupervisor?: boolean; delegate?: boolean },
  now: () => string = nowIso,
): CreatedApiToken {
  const token = generateToken();
  const userId = input.userId ?? null;
  const isService = input.isService ?? false;
  const isSupervisor = input.isSupervisor ?? false;
  const delegate = input.delegate ?? false;
  if (delegate && userId == null) throw new ValidationError('a delegate token must be bound to a user');
  if (delegate && (isService || isSupervisor)) throw new ValidationError('a delegate token cannot be a service or supervisor token');
  const id = insertToken(db, { tokenHash: hashToken(token), userId, label: input.label, isService, isSupervisor, delegate, createdAt: now() });
  return { token, id, label: input.label, userId, isService, isSupervisor, delegate };
}

export interface AuthedToken {
  tokenId: number; userId: number | null;
  email: string | null; displayName: string | null;
  label: string; isService: boolean; isSupervisor: boolean; delegate: boolean;
}

/** Resolve a raw bearer token to its owner, or null if unknown. Bumps last_used_at. */
export function authenticateToken(db: DB, rawToken: string, now: () => string = nowIso): AuthedToken | null {
  const row = findTokenByHash(db, hashToken(rawToken));
  if (!row) return null;
  touchToken(db, row.id, now());
  return {
    tokenId: row.id, userId: row.user_id,
    email: row.email, displayName: row.display_name,
    label: row.label, isService: row.is_service === 1, isSupervisor: row.is_supervisor === 1,
    delegate: row.delegate === 1,
  };
}
