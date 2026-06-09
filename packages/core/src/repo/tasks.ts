import type { DB } from '../db.js';
import type { Task, Status, UpdateTaskInput } from '../types.js';

export interface TaskRow {
  id: number; key: string; title: string; spec: string; acceptance_criteria: string;
  status: Status; result_summary: string | null; seq: number; created_at: string; updated_at: string;
}

export function toTask(r: TaskRow): Task {
  return {
    id: r.id, key: r.key, title: r.title, spec: r.spec, acceptanceCriteria: r.acceptance_criteria,
    status: r.status, resultSummary: r.result_summary, seq: r.seq, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function findRowByKey(db: DB, key: string): TaskRow | undefined {
  return db.prepare('SELECT * FROM task WHERE key = ?').get(key) as TaskRow | undefined;
}
export function findByKey(db: DB, key: string): Task | null {
  const r = findRowByKey(db, key);
  return r ? toTask(r) : null;
}
export function setStatus(db: DB, id: number, status: Status, ts: string): void {
  db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
}
export function setResultSummary(db: DB, id: number, summary: string, ts: string): void {
  db.prepare('UPDATE task SET result_summary = ?, updated_at = ? WHERE id = ?').run(summary, ts, id);
}
export function touch(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(ts, id);
}
export function applyEdit(db: DB, id: number, fields: UpdateTaskInput, ts: string): void {
  const sets: string[] = [];
  // Cast to (string | number)[] — SQLInputValue includes both; spread is valid at runtime.
  const vals: (string | number)[] = [];
  if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title); }
  if (fields.spec !== undefined) { sets.push('spec = ?'); vals.push(fields.spec); }
  if (fields.acceptanceCriteria !== undefined) { sets.push('acceptance_criteria = ?'); vals.push(fields.acceptanceCriteria); }
  sets.push('updated_at = ?'); vals.push(ts);
  vals.push(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run as (...a: any[]) => unknown)(...vals);
}
export function listRows(db: DB, opts: { status?: Status } = {}): Task[] {
  const rows = (opts.status
    ? db.prepare('SELECT * FROM task WHERE status = ? ORDER BY seq ASC').all(opts.status)
    : db.prepare('SELECT * FROM task ORDER BY seq ASC').all()) as unknown as TaskRow[];
  return rows.map(toTask);
}
export function oldestQueuedRow(db: DB): TaskRow | undefined {
  return db.prepare("SELECT * FROM task WHERE status='queued' ORDER BY seq ASC LIMIT 1").get() as TaskRow | undefined;
}
