import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, blockByRows } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';
import { updateStatusWithinTransaction } from './updateStatus.js';

export interface AnswerBlockInput {
  /** The decision/v1 option the human picked; omitted for a free-text answer. */
  optionId?: string | undefined;
  /** Free text: the whole answer, or what to add to the picked option. */
  answer?: string | undefined;
  actorUserId?: number | null;
  actorDelegate?: string | null;
}

/**
 * A human answers a blocked task's question: the answer is recorded as binding `feedback` (the
 * activity the next session reads, like a request-changes note) and the task goes back to the
 * queue with a fresh budget (blocked → queued, the unblock edge). One transaction, so the answer
 * can never be lost between the two writes or land on a task someone else already moved.
 */
export function answerBlock(db: DB, key: string, input: AnswerBlockInput, now: () => string = nowIso): TaskDetail {
  const answer = input.answer?.trim() ?? '';
  if (answer.length > 4000) throw new ValidationError('answer must be at most 4000 characters');
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    if (row.status !== 'blocked') throw new InvalidTransitionError(`answering requires a blocked task (got ${row.status})`);
    const block = blockByRows(db, [row]).get(row.id) ?? null;
    let chosen: string | null = null;
    if (input.optionId !== undefined) {
      const option = block?.decision?.options.find((o) => o.id === input.optionId);
      if (!option) throw new ValidationError(`no option '${input.optionId}' on this task's question`);
      chosen = option.label;
    }
    if (!chosen && !answer) throw new ValidationError('pick an option or write an answer');
    const question = block?.decision?.question ?? block?.reason ?? null;
    const body = [
      question ? `Answer to your question: ${question}` : 'Answer to your block:',
      chosen ? `Chosen: ${chosen}` : null,
      answer || null,
      'Treat this answer as binding and continue the task.',
    ].filter(Boolean).join('\n');
    const ts = now();
    appendActivity(db, { taskId: row.id, type: 'feedback', actor: 'human', body, createdAt: ts, actorUserId: input.actorUserId ?? null, actorDelegate: input.actorDelegate ?? null });
    return updateStatusWithinTransaction(db, key, 'queued', 'human', () => ts, input.actorUserId ?? null, chosen ? `answered: ${chosen}` : 'answered', undefined, undefined, null, input.actorDelegate ?? null);
  });
}
