import type { DB } from '../db.js';
import type { Workspace, UpdateWorkspaceInput } from '../types.js';
import { transaction } from '../transaction.js';
import { updateWorkspaceSchema, parse } from '../validate.js';
import { requireWorkspaceByName, updateWorkspaceFields, toWorkspace } from '../repo/workspaces.js';
import { nowIso } from '../time.js';

/**
 * Patch a workspace's engineering-discipline fields (policy / verify command). null clears a
 * field, an omitted key leaves it untouched. Returns the full updated workspace.
 */
export function updateWorkspace(db: DB, name: string, input: UpdateWorkspaceInput, now: () => string = nowIso): Workspace {
  const fields = parse(updateWorkspaceSchema, input);
  return transaction(db, () => {
    const row = requireWorkspaceByName(db, name);
    updateWorkspaceFields(db, row.id, fields, now());
    return toWorkspace(requireWorkspaceByName(db, name));
  });
}
