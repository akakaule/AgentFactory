import type { DB } from '../db.js';
import type { CiMode, Workspace } from '../types.js';
import { parseRequiredChecks } from '../workspaceProfile.js';
import type { AgentPrompts } from '../agentPrompts.js';
import { parseAdoSyncSettings, type AdoSyncSettings } from '../adoSync.js';
import { NotFoundError } from '../errors.js';

export interface WorkspaceRow {
  id: number; name: string; repo_path: string; created_at: string;
  updated_at: string | null; // stamped on every field edit (#23); null only pre-migration in-flight
  policy: string | null; verify_command: string | null;
  pat: string | null; // the git-host credential — SECRET; never leaves core (masked to hasPat below)
  prompt_overrides: string | null; // JSON map of per-workspace agent system-prompt overrides (#20)
  ado_sync: string | null; // JSON AdoSyncSettings — Azure DevOps work-item import (#27)
  // repository profile (AF-151); NULL = not configured
  base_branch: string | null; required_checks: string | null /* JSON string[] */; ci_mode: CiMode | null;
}

/** Parse the stored prompt-overrides JSON (written already-cleaned by updateWorkspaceFields). */
function parseOverrides(raw: string | null): AgentPrompts {
  if (!raw) return {};
  try { const o = JSON.parse(raw); return o && typeof o === 'object' ? (o as AgentPrompts) : {}; } catch { return {}; }
}

/** Map a row to the public shape. Deliberately drops `pat`: the raw credential must never be
 *  serialized to a client — only whether one is set (`hasPat`) is exposed. */
export function toWorkspace(r: WorkspaceRow): Workspace {
  return {
    id: r.id, name: r.name, repoPath: r.repo_path, createdAt: r.created_at,
    policy: r.policy, verifyCommand: r.verify_command,
    hasPat: r.pat != null && r.pat !== '',
    promptOverrides: parseOverrides(r.prompt_overrides),
    adoSync: parseAdoSyncSettings(r.ado_sync),
    baseBranch: r.base_branch ?? null, requiredChecks: parseRequiredChecks(r.required_checks ?? null), ciMode: r.ci_mode ?? null,
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
  return { id: Number(info.lastInsertRowid), name, repoPath, createdAt: ts, policy: null, verifyCommand: null, hasPat: false, promptOverrides: {}, adoSync: null, baseBranch: null, requiredChecks: null, ciMode: null };
}

/** Patch a workspace's editable fields: repoPath (defining, non-null), the discipline fields
 *  (policy / verify_command), the git PAT (null clears it), and/or the agent prompt overrides
 *  (a cleaned map — empty ⇒ stored NULL), and/or the ADO work-item import settings (null clears),
 *  and/or the repository profile (baseBranch / requiredChecks / ciMode; null clears).
 *  Only keys present in `fields` are written.
 *  Every write stamps updated_at (#23) — getVersion() folds it in, so edits reach open clients. */
export function updateWorkspaceFields(
  db: DB,
  id: number,
  fields: {
    repoPath?: string | undefined; policy?: string | null | undefined; verifyCommand?: string | null | undefined;
    pat?: string | null | undefined; promptOverrides?: AgentPrompts | undefined;
    adoSync?: AdoSyncSettings | null | undefined;
    baseBranch?: string | null | undefined; requiredChecks?: string[] | null | undefined; ciMode?: CiMode | null | undefined;
  },
  ts: string,
): void {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  if ('repoPath' in fields && fields.repoPath !== undefined) { sets.push('repo_path = ?'); vals.push(fields.repoPath); }
  if ('policy' in fields) { sets.push('policy = ?'); vals.push(fields.policy ?? null); }
  if ('verifyCommand' in fields) { sets.push('verify_command = ?'); vals.push(fields.verifyCommand ?? null); }
  if ('pat' in fields) { sets.push('pat = ?'); vals.push(fields.pat ?? null); }
  if ('promptOverrides' in fields && fields.promptOverrides !== undefined) {
    const o = fields.promptOverrides;
    sets.push('prompt_overrides = ?'); vals.push(Object.keys(o).length > 0 ? JSON.stringify(o) : null);
  }
  if ('adoSync' in fields && fields.adoSync !== undefined) {
    sets.push('ado_sync = ?'); vals.push(fields.adoSync === null ? null : JSON.stringify(fields.adoSync));
  }
  if ('baseBranch' in fields) { sets.push('base_branch = ?'); vals.push(fields.baseBranch ?? null); }
  if ('requiredChecks' in fields) {
    const c = fields.requiredChecks;
    sets.push('required_checks = ?'); vals.push(c && c.length > 0 ? JSON.stringify(c) : null);
  }
  if ('ciMode' in fields) { sets.push('ci_mode = ?'); vals.push(fields.ciMode ?? null); }
  if (sets.length === 0) return;
  sets.push('updated_at = ?'); vals.push(ts);
  vals.push(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE workspace SET ${sets.join(', ')} WHERE id = ?`).run as (...a: any[]) => unknown)(...vals);
}
export function listAllWorkspaces(db: DB): Workspace[] {
  const rows = db.prepare('SELECT * FROM workspace ORDER BY id ASC').all() as unknown as WorkspaceRow[];
  return rows.map(toWorkspace);
}
