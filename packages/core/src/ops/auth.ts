import type { DB } from '../db.js';
import type { User } from '../types.js';
import { nowIso } from '../time.js';
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
  id: number; label: string; userId: number | null; isService: boolean;
}

/** Mint a bearer token (optionally bound to a user; otherwise a service token). */
export function createApiToken(
  db: DB,
  input: { label: string; userId?: number | null; isService?: boolean },
  now: () => string = nowIso,
): CreatedApiToken {
  const token = generateToken();
  const userId = input.userId ?? null;
  const isService = input.isService ?? false;
  const id = insertToken(db, { tokenHash: hashToken(token), userId, label: input.label, isService, createdAt: now() });
  return { token, id, label: input.label, userId, isService };
}

export interface AuthedToken {
  tokenId: number; userId: number | null;
  email: string | null; displayName: string | null;
  label: string; isService: boolean;
}

/** Resolve a raw bearer token to its owner, or null if unknown. Bumps last_used_at. */
export function authenticateToken(db: DB, rawToken: string, now: () => string = nowIso): AuthedToken | null {
  const row = findTokenByHash(db, hashToken(rawToken));
  if (!row) return null;
  touchToken(db, row.id, now());
  return {
    tokenId: row.id, userId: row.user_id,
    email: row.email, displayName: row.display_name,
    label: row.label, isService: row.is_service === 1,
  };
}
