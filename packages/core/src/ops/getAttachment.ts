import type { DB } from '../db.js';
import { attachmentWithBytes, type AttachmentRow } from '../repo/attachments.js';
import { NotFoundError } from '../errors.js';

/** Bytes for the binary route and the MCP image blocks. */
export function getAttachment(db: DB, id: number): AttachmentRow {
  const row = attachmentWithBytes(db, id);
  if (!row) throw new NotFoundError(`attachment not found: ${id}`);
  return row;
}
