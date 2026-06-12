import type { DB } from '../db.js';
import { attachmentWithBytes, deleteAttachmentRow } from '../repo/attachments.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

export function deleteAttachment(db: DB, id: number, now: () => string = nowIso): void {
  const row = attachmentWithBytes(db, id);
  if (!row) throw new NotFoundError(`attachment not found: ${id}`);
  const task = db.prepare('SELECT status FROM task WHERE id = ?').get(row.taskId) as { status: string } | undefined;
  if (task && task.status !== 'backlog')
    throw new InvalidTransitionError(`attachments can only change while a task is in backlog`);
  deleteAttachmentRow(db, id);
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(now(), row.taskId);
}
