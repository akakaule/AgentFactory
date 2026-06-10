import type { DB } from '../db.js';
import type { Workspace } from '../types.js';
import { listAllWorkspaces } from '../repo/workspaces.js';

export function listWorkspaces(db: DB): Workspace[] {
  return listAllWorkspaces(db);
}
