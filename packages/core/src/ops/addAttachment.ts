import type { DB } from '../db.js';
import type { Attachment, AddAttachmentInput } from '../types.js';
import { ATTACHMENT_MAX_BYTES } from '../types.js';
import { findRowByKey } from '../repo/tasks.js';
import { insertAttachment } from '../repo/attachments.js';
import { attachmentSchema, parse } from '../validate.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

/** Attach a pasted spec image. Backlog-only — the agent's brief is frozen once queued. */
export function addAttachment(db: DB, key: string, input: AddAttachmentInput, now: () => string = nowIso): Attachment {
  const a = parse(attachmentSchema, input);
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'backlog')
    throw new InvalidTransitionError(`attachments can only change while a task is in backlog: ${key} is ${row.status}`);

  const bytes = Buffer.from(a.dataBase64, 'base64');
  if (bytes.length === 0) throw new ValidationError('image data is empty');
  if (bytes.length > ATTACHMENT_MAX_BYTES)
    throw new ValidationError(`image exceeds ${ATTACHMENT_MAX_BYTES / 1024 / 1024} MB after decoding`);

  const ts = now();
  const id = insertAttachment(db, { taskId: row.id, filename: a.filename, mime: a.mime, bytes, createdAt: ts });
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(ts, row.id);
  return { id, taskId: row.id, filename: a.filename, mime: a.mime, size: bytes.length };
}
