import type { DB } from '../db.js';
import type { Task, CreateTaskInput } from '../types.js';
import { transaction } from '../transaction.js';
import { ValidationError, InvalidTransitionError } from '../errors.js';
import { createTaskWithinTransaction } from './createTask.js';
import { queueWithIntakeAcknowledgment } from './intake.js';
import { appendActivity } from '../repo/activity.js';
import { findByKey } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { ADO_IMPORT_MARKER } from '../adoSync.js';
import { nowIso } from '../time.js';

export interface ImportTaskInput extends Omit<CreateTaskInput, 'actor' | 'kind' | 'workspace'> {
  workspace: string;
  /** Literal title prefix that identifies the source item (`AB#42:`) — the dedup key. */
  dedupPrefix: string;
  /** One line for the `ado-import/v1` comment (where the task came from). */
  note: string;
  /** Queue it for the dispatcher (also re-queues a matching task still sitting in backlog). */
  queue?: boolean | undefined;
}

/**
 * Import a task from an external tracker on behalf of the workspace's configured import (the
 * watcher's Azure DevOps sync). Idempotent: a task in the workspace whose title starts with
 * `dedupPrefix` — any status, archived included — is returned instead of creating another. The
 * create and the queue are attributed to 'human' (a person configured the import; there is no
 * agent judgement in it), which is why this is a supervisor-only op over HTTP. Queueing goes
 * through the intake acknowledgment rule, so a current "attention required" assessment still
 * holds the task in backlog for a person.
 */
export function importTask(db: DB, input: ImportTaskInput, now: () => string = nowIso): { task: Task; created: boolean } {
  const prefix = input.dedupPrefix.trim();
  if (!prefix) throw new ValidationError('dedupPrefix is required');
  if (!input.title.startsWith(prefix)) throw new ValidationError(`title must start with the dedup prefix '${prefix}'`);

  const { key, created } = transaction(db, () => {
    const ws = requireWorkspaceByName(db, input.workspace);
    const existing = db.prepare('SELECT key FROM task WHERE workspace_id = ? AND substr(title, 1, ?) = ? ORDER BY id LIMIT 1')
      .get(ws.id, prefix.length, prefix) as { key: string } | undefined;
    if (existing) return { key: existing.key, created: false };
    const { workspace, dedupPrefix: _p, note, queue: _q, ...fields } = input;
    const task = createTaskWithinTransaction(db, { ...fields, workspace, actor: 'human' }, now);
    appendActivity(db, { taskId: task.id, type: 'comment', actor: 'human', body: `${ADO_IMPORT_MARKER} — ${note.trim()}`, createdAt: now() });
    return { key: task.key, created: true };
  });

  if (input.queue && findByKey(db, key)!.status === 'backlog') {
    try {
      queueWithIntakeAcknowledgment(db, key, {}, now);
    } catch (err) {
      if (!(err instanceof InvalidTransitionError)) throw err; // intake wants a person first — leave it in backlog
    }
  }
  return { task: findByKey(db, key)!, created };
}
