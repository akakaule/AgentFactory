import type { DB } from './db.js';

export function getVersion(db: DB): string {
  const r = db.prepare(
    `SELECT MAX(v) v FROM (SELECT MAX(updated_at) v FROM task UNION ALL SELECT MAX(created_at) v FROM activity UNION ALL SELECT MAX(created_at) v FROM workspace)`
  ).get() as { v: string | null };
  return r.v ?? '';
}
