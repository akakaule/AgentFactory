import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { buildPrFeedbackComment } from '../prFeedback.js';
import { nowIso } from '../time.js';

export interface AddPrFeedbackInput { feedback: string; author?: string | null; url?: string | null; actorUserId?: number | null }

/**
 * Attach a human's PR-review comment to a DELIVERING task as a `pr-feedback/v1` marker — the trigger
 * the delivering evaluator polls for. No status change: the task stays in `delivering` while the
 * evaluator critically assesses the feedback and posts a `feedback-eval/v1` verdict.
 */
export function addPrFeedback(db: DB, key: string, input: AddPrFeedbackInput, now: () => string = nowIso): TaskDetail {
  const feedback = (input.feedback ?? '').trim();
  if (!feedback) throw new ValidationError('feedback is required');
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'delivering') throw new ValidationError(`PR feedback can only be added to a delivering task (got ${row.status})`);
  return transaction(db, () => {
    const body = buildPrFeedbackComment({ feedback, author: input.author ?? undefined, url: input.url ?? undefined });
    appendActivity(db, { taskId: row.id, type: 'comment', actor: 'human', body, createdAt: now(), actorUserId: input.actorUserId ?? null });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
