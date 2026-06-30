import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { feedbackSchema, parse } from '../validate.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

export function reviewRequestChanges(db: DB, key: string, input: { feedback: string; actorUserId?: number | null }, now: () => string = nowIso): TaskDetail {
  const { feedback } = parse(feedbackSchema, { feedback: input.feedback });
  const actorUserId = input.actorUserId ?? null;
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'in_review') throw new InvalidTransitionError(`request changes requires in_review (got ${row.status})`);
  // A pr-review task is reviewed, never implemented — it must never reach the worker queue. This path
  // calls setStatus('queued') directly (bypassing updateStatus's guard), so the kind check lives here too.
  if (row.kind === 'pr-review')
    throw new ValidationError('a pr-review task has no implementation to send back — there is no "request changes" for a PR review');
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, 'queued', ts);
    appendActivity(db, { taskId: row.id, type: 'feedback', actor: 'human', body: feedback, createdAt: ts, actorUserId });
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'human', fromStatus: 'in_review', toStatus: 'queued', createdAt: ts, actorUserId });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
