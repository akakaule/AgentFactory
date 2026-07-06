import type { DB } from '../db.js';
import type { Workspace } from '../types.js';
import { NotFoundError } from '../errors.js';

export interface WorkspaceRow {
  id: number; name: string; repo_path: string; created_at: string;
  policy: string | null; verify_command: string | null;
  pat: string | null; // the git-host credential — SECRET; never leaves core (masked to hasPat below)
}

/** Map a row to the public shape. Deliberately drops `pat`: the raw credential must never be
 *  serialized to a client — only whether one is set (`hasPat`) is exposed. */
export function toWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id, name: r.name, repoPath: r.repo_path, createdAt: r.created_at,
    policy: r.policy, verifyCommand: r.verify_command,
    hasPat: r.pat != null && r.pat !== '',
  };
}
/** The raw stored PAT for a workspace, or null. Internal-only (git-auth resolution / watcher) —
 *  never route this through toWorkspace or any API response. */
export function getWorkspacePat(db: DB, name: string): string | null {
  const row = findWorkspaceByName(db, name);
  return row?.pat ?? null;
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
  return { id: Number(info.lastInsertRowid), name, repoPath, createdAt: ts, policy: null, verifyCommand: null, hasPat: false };
}

/** Patch a workspace's editable fields: repoPath (defining, non-null), the discipline fields
 *  (policy / verify_command), and/or the git PAT (null clears it). Only keys present in `fields`
 *  are written. */
export function updateWorkspaceFields(
  db: DB,
  id: number,
  fields: { repoPath?: string | undefined; policy?: string | null | undefined; verifyCommand?: string | null | undefined; pat?: string | null | undefined },
): void {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if ('repoPath' in fields && fields.repoPath !== undefined) { sets.push('repo_path = ?'); vals.push(fields.repoPath); }
  if ('policy' in fields) { sets.push('policy = ?'); vals.push(fields.policy ?? null); }
  if ('verifyCommand' in fields) { sets.push('verify_command = ?'); vals.push(fields.verifyCommand ?? null); }
  if ('pat' in fields) { sets.push('pat = ?'); vals.push(fields.pat ?? null); }
  if (sets.length === 0) return;
  vals.push(String(id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE workspace SET ${sets.join(', ')} WHERE id = ?`).run as (...a: any[]) => unknown)(...vals);
}
export function listAllWorkspaces(db: DB): Workspace[] {
  const rows = db.prepare('SELECT * FROM workspace ORDER BY id ASC').all() as unknown as WorkspaceRow[];
  return rows.map(toWorkspace);
}
