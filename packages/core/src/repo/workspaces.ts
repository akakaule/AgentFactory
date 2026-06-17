import type { DB } from '../db.js';
import type { Workspace } from '../types.js';
import { NotFoundError } from '../errors.js';

export interface WorkspaceRow {
  id: number; name: string; repo_path: string; created_at: string;
  policy: string | null; verify_command: string | null;
}

export function toWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id, name: r.name, repoPath: r.repo_path, createdAt: r.created_at,
    policy: r.policy, verifyCommand: r.verify_command,
  };
}
export function findWorkspaceByName(db: DB, name: string): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspace WHERE name = ?').get(name) as WorkspaceRow | undefined;
}
export function requireWorkspaceByName(db: DB, name: string): WorkspaceRow {
  const row = findWorkspaceByName(db, name);
  if (!row) throw new NotFoundError(`workspace not found: ${name}`);
  return row;
}
export function insertWorkspace(db: DB, name: string, repoPath: string, ts: string): Workspace {
  const info = db.prepare('INSERT INTO workspace(name, repo_path, created_at) VALUES (?, ?, ?)').run(name, repoPath, ts);
  return { id: Number(info.lastInsertRowid), name, repoPath, createdAt: ts, policy: null, verifyCommand: null };
}

/** Patch the discipline fields (policy / verify_command). Only keys present in `fields` are written. */
export function updateWorkspaceFields(
  db: DB,
  id: number,
  fields: { policy?: string | null | undefined; verifyCommand?: string | null | undefined },
): void {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if ('policy' in fields) { sets.push('policy = ?'); vals.push(fields.policy ?? null); }
  if ('verifyCommand' in fields) { sets.push('verify_command = ?'); vals.push(fields.verifyCommand ?? null); }
  if (sets.length === 0) return;
  vals.push(String(id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE workspace SET ${sets.join(', ')} WHERE id = ?`).run as (...a: any[]) => unknown)(...vals);
}
export function listAllWorkspaces(db: DB): Workspace[] {
  const rows = db.prepare('SELECT * FROM workspace ORDER BY id ASC').all() as unknown as WorkspaceRow[];
  return rows.map(toWorkspace);
}
