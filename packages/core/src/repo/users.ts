import type { DB } from '../db.js';
import type { User } from '../types.js';

export interface UserRow {
  id: number; email: string; display_name: string;
  oidc_subject: string | null; is_system: number; created_at: string;
}

export function toUser(r: UserRow): User {
  return {
    id: r.id, email: r.email, displayName: r.display_name,
    oidcSubject: r.oidc_subject, isSystem: r.is_system === 1, createdAt: r.created_at,
  };
}

export function findUserById(db: DB, id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM app_user WHERE id = ?').get(id) as UserRow | undefined;
}

export function findUserByEmail(db: DB, email: string): UserRow | undefined {
  return db.prepare('SELECT * FROM app_user WHERE email = ?').get(email) as UserRow | undefined;
}

export function insertUser(
  db: DB,
  u: { email: string; displayName: string; oidcSubject: string | null; isSystem: boolean; createdAt: string },
): number {
  const r = db.prepare(
    'INSERT INTO app_user(email, display_name, oidc_subject, is_system, created_at) VALUES (?,?,?,?,?)',
  ).run(u.email, u.displayName, u.oidcSubject, u.isSystem ? 1 : 0, u.createdAt);
  return Number(r.lastInsertRowid);
}
