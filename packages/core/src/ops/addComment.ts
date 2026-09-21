import type { DB } from '../db.js';
import type { Activity, AddCommentInput } from '../types.js';
import { transaction } from '../transaction.js';
import { commentSchema, parse } from '../validate.js';
import { findRowByKey, touch, toDetail } from '../repo/tasks.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { parseAiReviewComment } from '../aiReview.js';
import { applyApproval } from './approval.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { reviewSubmissionFingerprint } from '../reviewConsensus.js';
import { nowIso } from '../time.js';
import { assertExecutionOwnership } from '../repo/execution.js';

export function addComment(
  db: DB,
  key: string,
  input: AddCommentInput,
  now: () => string = nowIso,
): Activity {
  const { body } = parse(commentSchema, input);
  return transaction(db, () => {
    const parsed = parseAiReviewComment(body);
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    // A settled fence may still comment while it is the task's LATEST execution (a recovery note
    // after release, a note after submit): nothing newer exists, so nothing can be overwritten.
    if (input.actor === 'agent') assertExecutionOwnership(db, row.id, key, input.executionId, { allowSettledSuccess: true, allowSettledFailure: true });
    const current = row;
    const submission = parsed?.consensus?.submission;
    if (submission && (submission.key !== key || submission.fingerprint !== reviewSubmissionFingerprint(toDetail(db, current)))) {
      throw new InvalidTransitionError('review submission changed before publication');
    }
    const ts = now();
    appendActivity(db, { taskId: row.id, type: 'comment', actor: input.actor, body, createdAt: ts, actorUserId: input.actorUserId ?? null });
    touch(db, row.id, ts);
    const comment = recentActivity(db, row.id, 1)[0]!; // capture before the hook appends more rows
    // Auto-approve policy: a clean ai-review/v1 verdict on an in-review doc stage advances
    // the task to its next stage. Keyed on the incoming body itself (the newest activity by
    // construction), regardless of actor — the reviewer loop posts via HTTP (human) or MCP
    // (agent). Findings, malformed markers, and the implementation stage all escalate to
    // the human gate instead. Reviewers stay advisory; this policy lives here, in core.
    if (parsed && parsed.consensus?.status !== 'disputed' && parsed.findings.length === 0 && current.status === 'in_review' && current.stage !== 'implementation') {
      applyApproval(db, current, 'agent', ts, 'auto-approved: clean AI review');
    }
    return comment;
  });
}
