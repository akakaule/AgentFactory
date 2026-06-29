import type { DB } from './db.js';

export function getVersion(db: DB): string {
  // "<max timestamp>#<task count>" — a DELETE can never raise the max, but it always
  // changes the count, so deletions bump the version like every other mutation.
  // task_visualization is folded in (its updated_at) so attaching a change visualization bumps the
  // version and the open drawer refetches the task (picking up hasVisualization). Safe to include —
  // a viz is attached once per review, unlike the high-frequency transcript tail (deliberately out).
  const r = db.prepare(
    `SELECT MAX(v) v, (SELECT COUNT(*) FROM task) n FROM (SELECT MAX(updated_at) v FROM task UNION ALL SELECT MAX(created_at) v FROM activity UNION ALL SELECT MAX(created_at) v FROM workspace UNION ALL SELECT MAX(created_at) v FROM task_metric UNION ALL SELECT MAX(updated_at) v FROM task_visualization)`
  ).get() as { v: string | null; n: number };
  return `${r.v ?? ''}#${r.n}`;
}
