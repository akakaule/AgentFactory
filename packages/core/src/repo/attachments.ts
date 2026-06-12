import type { DB } from '../db.js';
import type { Attachment } from '../types.js';

export interface AttachmentInsert {
  taskId: number; filename: string; mime: string; bytes: Uint8Array; createdAt: string;
}
export function insertAttachment(db: DB, a: AttachmentInsert): number {
  const r = db.prepare(
    'INSERT INTO attachment(task_id, filename, mime, bytes, created_at) VALUES (?,?,?,?,?)'
  ).run(a.taskId, a.filename, a.mime, a.bytes, a.createdAt);
  return Number(r.lastInsertRowid);
}

/** Metadata only — bytes never ride list/detail payloads. */
export function attachmentsMeta(db: DB, taskId: number): Attachment[] {
  const rows = db.prepare(
    'SELECT id, task_id, filename, mime, LENGTH(bytes) AS size FROM attachment WHERE task_id = ? ORDER BY id ASC'
  ).all(taskId) as Array<{ id: number; task_id: number; filename: string; mime: string; size: number }>;
  return rows.map((r) => ({ id: r.id, taskId: r.task_id, filename: r.filename, mime: r.mime, size: r.size }));
}

export interface AttachmentRow {
  id: number; taskId: number; filename: string; mime: string; bytes: Uint8Array;
}
export function attachmentWithBytes(db: DB, id: number): AttachmentRow | undefined {
  const r = db.prepare('SELECT id, task_id, filename, mime, bytes FROM attachment WHERE id = ?').get(id) as
    | { id: number; task_id: number; filename: string; mime: string; bytes: Uint8Array }
    | undefined;
  return r ? { id: r.id, taskId: r.task_id, filename: r.filename, mime: r.mime, bytes: r.bytes } : undefined;
}

export function deleteAttachmentRow(db: DB, id: number): void {
  db.prepare('DELETE FROM attachment WHERE id = ?').run(id);
}
