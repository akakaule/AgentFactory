import type { DB } from '../db.js';
import type { CurationEntry, TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { feedbackSchema, parse } from '../validate.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { buildCurationComment } from '../curation.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

/** The curation the human made while sending changes back: which reviewer findings were
 *  forwarded (checked) vs. dismissed (unchecked). ReviewActions owns this split; the op only
 *  persists it as the `curation/v1` ledger. Omitted / empty ⇒ no AI review to curate. */
export interface RequestChangesCuration {
  reviewer: string | null;
  dispositions: CurationEntry[];
}

export function reviewRequestChanges(
  db: DB,
  key: string,
  input: { feedback: string; actorUserId?: number | null; curation?: RequestChangesCuration | undefined },
  now: () => string = nowIso,
): TaskDetail {
  const { feedback } = parse(feedbackSchema, { feedback: input.feedback });
  const actorUserId = input.actorUserId ?? null;
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'in_review') throw new InvalidTransitionError(`request changes requires in_review (got ${row.status})`);
  // A pr-review task is reviewed, never implemented — it must never reach the worker queue. This path
  // calls setStatus('queued') directly (bypassing updateStatus's guard), so the kind check lives here too.
  if (row.kind === 'pr-review')
    throw new ValidationError('a pr-review task has no implementation to send back — there is no "request changes" for a PR review');
  const curation = input.curation;
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, 'queued', ts);
    // Curation ledger: capture the forwarded/dismissed split ReviewActions computed, before the
    // feedback that carries only the forwarded findings on to the agent. Reviewer-precision KPI
    // reads it back from the log; MCP strips it so the dismiss/forward judgment never leaks.
    if (curation && curation.dispositions.length > 0) {
      appendActivity(db, {
        taskId: row.id, type: 'comment', actor: 'human',
        body: buildCurationComment(curation.reviewer, curation.dispositions), createdAt: ts, actorUserId,
      });
    }
    appendActivity(db, { taskId: row.id, type: 'feedback', actor: 'human', body: feedback, createdAt: ts, actorUserId });
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'human', fromStatus: 'in_review', toStatus: 'queued', createdAt: ts, actorUserId });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
