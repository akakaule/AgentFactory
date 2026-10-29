import type { DB } from '../db.js';
import type { Workspace } from '../types.js';
import { requireWorkspaceByName, toWorkspace } from '../repo/workspaces.js';

/** One workspace by name (NotFoundError if missing), in the public shape — never the PAT. */
export function getWorkspace(db: DB, name: string): Workspace {
  return toWorkspace(requireWorkspaceByName(db, name));
}
