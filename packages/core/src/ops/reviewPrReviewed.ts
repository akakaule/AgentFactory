import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { applyApproval } from './approval.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

/** Prefixes a captured PR-review body in the activity log. The ado-bridge reads the latest such
 *  comment over HTTP and posts the markdown after the marker line to the Azure DevOps PR. Mirrors
 *  the `ai-review/v1` convention; unlike that one it is NOT stripped from MCP payloads. */
export const PR_REVIEW_FEEDBACK_MARKER = 'pr-review-feedback/v1';

/**
 * "Mark reviewed" for a pr-review task. Optionally captures the human's final review text as a
 * `pr-review-feedback/v1` comment (so the ado-bridge can auto-post it to the PR), then closes the
 * task (in_review → done) via the shared approval path (which also logs the break-glass override
 * when there are open AI findings). An empty review just closes — done = review given, no PR
 * comment. Comment + close happen in one transaction. The review is only captured for a
 * `pr-review` task; for any other kind this is a plain approve.
 */
export function reviewPrReviewed(
  db: DB,
  key: string,
  input: { review?: string | undefined; actorUserId?: number | null } = {},
  now: () => string = nowIso,
): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'in_review') throw new InvalidTransitionError(`mark reviewed requires in_review (got ${row.status})`);
  const review = input.review?.trim() ?? '';
  const actorUserId = input.actorUserId ?? null;
  return transaction(db, () => {
    const ts = now();
    if (review && row.kind === 'pr-review') {
      appendActivity(db, { taskId: row.id, type: 'comment', actor: 'human', body: `${PR_REVIEW_FEEDBACK_MARKER}\n${review}`, createdAt: ts, actorUserId });
    }
    applyApproval(db, row, 'human', ts, undefined, actorUserId);
    return toDetail(db, findRowByKey(db, key)!);
  });
}
