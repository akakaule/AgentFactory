import type { DB } from '../db.js';
import type { Activity, Actor } from '../types.js';
import { transaction } from '../transaction.js';
import { commentSchema, parse } from '../validate.js';
import { findRowByKey, touch, toDetail } from '../repo/tasks.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { parseAiReviewComment } from '../aiReview.js';
import { applyApproval } from './approval.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { reviewSubmissionFingerprint } from '../reviewConsensus.js';
import { nowIso } from '../time.js';
import { isIntakeMarker } from '../intake.js';
import { isFailureTriageMarker } from '../failureTriage.js';

export function addComment(
  db: DB,
  key: string,
  input: { actor: Actor; body: string; actorUserId?: number | null },
  now: () => string = nowIso,
): Activity {
  const { body } = parse(commentSchema, { body: input.body });
  if (isIntakeMarker(body)) throw new InvalidTransitionError('intake markers can only be written by dedicated core operations');
  if (isFailureTriageMarker(body)) throw new InvalidTransitionError('failure-triage markers can only be written by dedicated core operations');
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return transaction(db, () => {
    const parsed = parseAiReviewComment(body);
    const current = findRowByKey(db, key);
    if (!current) throw new NotFoundError(`task not found: ${key}`);
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
