import type { DB } from '../db.js';
import type { TaskDetail, SubmitResultInput } from '../types.js';
import { RECENT_ACTIVITY_LIMIT } from '../types.js';
import { transaction } from '../transaction.js';
import { submitResultSchema, parse } from '../validate.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toTask, setStatus, setResultSummary } from '../repo/tasks.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { insertLinks, linksFor } from '../repo/links.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export function submitResult(
  db: DB,
  key: string,
  input: SubmitResultInput,
  now: () => string = nowIso,
): TaskDetail {
  const { summary, links } = parse(submitResultSchema, input);
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  assertTransition(row.status, 'in_review', 'agent'); // rejects unless in_progress
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, 'in_review', ts);
    setResultSummary(db, row.id, summary, ts);
    insertLinks(db, row.id, links ?? []);
    appendActivity(db, { taskId: row.id, type: 'result', actor: 'agent', body: summary, createdAt: ts });
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: 'in_progress', toStatus: 'in_review', createdAt: ts });
    const fresh = findRowByKey(db, key)!;
    return { ...toTask(fresh), activity: recentActivity(db, row.id, RECENT_ACTIVITY_LIMIT), links: linksFor(db, row.id) };
  });
}
