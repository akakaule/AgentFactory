import type { DB } from '../db.js';
import type { Workspace } from '../types.js';
import { NotFoundError } from '../errors.js';

export interface WorkspaceRow { id: number; name: string; repo_path: string; created_at: string; }

export function toWorkspace(r: WorkspaceRow): Workspace {
  return { id: r.id, name: r.name, repoPath: r.repo_path, createdAt: r.created_at };
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
  return { id: Number(info.lastInsertRowid), name, repoPath, createdAt: ts };
}
export function listAllWorkspaces(db: DB): Workspace[] {
  const rows = db.prepare('SELECT * FROM workspace ORDER BY id ASC').all() as unknown as WorkspaceRow[];
  return rows.map(toWorkspace);
}
