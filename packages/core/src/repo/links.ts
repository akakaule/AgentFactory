import type { DB } from '../db.js';
import type { Link, LinkInput } from '../types.js';

export function insertLinks(db: DB, taskId: number, links: LinkInput[]): void {
  const stmt = db.prepare('INSERT INTO link(task_id,kind,label,url) VALUES (?,?,?,?)');
  for (const l of links) stmt.run(taskId, l.kind, l.label, l.url);
}
export function linksFor(db: DB, taskId: number): Link[] {
  const rows = db.prepare('SELECT * FROM link WHERE task_id = ? ORDER BY id ASC').all(taskId) as Array<{
    id: number; task_id: number; kind: Link['kind']; label: string; url: string;
  }>;
  return rows.map(r => ({ id: r.id, taskId: r.task_id, kind: r.kind, label: r.label, url: r.url }));
}
