import type { DB } from '../db.js';
import type { Workspace, CreateWorkspaceInput } from '../types.js';
import { transaction } from '../transaction.js';
import { createWorkspaceSchema, parse } from '../validate.js';
import { findWorkspaceByName, insertWorkspace } from '../repo/workspaces.js';
import { ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

export function createWorkspace(db: DB, input: CreateWorkspaceInput, now: () => string = nowIso): Workspace {
  const { name, repoPath } = parse(createWorkspaceSchema, input);
  return transaction(db, () => {
    if (findWorkspaceByName(db, name)) throw new ValidationError(`workspace already exists: ${name}`);
    return insertWorkspace(db, name, repoPath, now());
  });
}
