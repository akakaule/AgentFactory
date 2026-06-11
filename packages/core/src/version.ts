import type { DB } from './db.js';

export function getVersion(db: DB): string {
  // "<max timestamp>#<task count>" — a DELETE can never raise the max, but it always
  // changes the count, so deletions bump the version like every other mutation.
  const r = db.prepare(
    `SELECT MAX(v) v, (SELECT COUNT(*) FROM task) n FROM (SELECT MAX(updated_at) v FROM task UNION ALL SELECT MAX(created_at) v FROM activity UNION ALL SELECT MAX(created_at) v FROM workspace)`
  ).get() as { v: string | null; n: number };
  return `${r.v ?? ''}#${r.n}`;
}
