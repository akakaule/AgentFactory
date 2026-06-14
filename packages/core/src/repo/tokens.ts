import type { DB } from '../db.js';

/** A token row joined to its owner (LEFT JOIN — service tokens have no user). */
export interface TokenAuthRow {
  id: number; user_id: number | null; label: string; is_service: number;
  email: string | null; display_name: string | null;
}

export function insertToken(
  db: DB,
  t: { tokenHash: string; userId: number | null; label: string; isService: boolean; createdAt: string },
): number {
  const r = db.prepare(
    'INSERT INTO api_token(token_hash, user_id, label, is_service, created_at) VALUES (?,?,?,?,?)',
  ).run(t.tokenHash, t.userId, t.label, t.isService ? 1 : 0, t.createdAt);
  return Number(r.lastInsertRowid);
}

export function findTokenByHash(db: DB, tokenHash: string): TokenAuthRow | undefined {
  return db.prepare(
    `SELECT t.id, t.user_id, t.label, t.is_service, u.email, u.display_name
     FROM api_token t LEFT JOIN app_user u ON u.id = t.user_id
     WHERE t.token_hash = ?`,
  ).get(tokenHash) as TokenAuthRow | undefined;
}

export function touchToken(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE api_token SET last_used_at = ? WHERE id = ?').run(ts, id);
}
