import { createHash, randomBytes } from 'node:crypto';

/**
 * Bearer-token helpers. The raw token is shown to the operator exactly once (at mint);
 * only its sha256 hash is ever stored, so a DB leak does not expose usable credentials.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
