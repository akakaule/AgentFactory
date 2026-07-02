import type { DB } from '../db.js';
import type { Actor, DeliveryProvider, Status } from '../types.js';
import { STAGE_ORDER } from '../types.js';
import type { TaskRow } from '../repo/tasks.js';
import { setStatus, setStage, aiReviewFor } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { upsertDelivery } from '../repo/delivery.js';
import { latestPrLinkUrl } from '../repo/links.js';
import { InvalidTransitionError } from '../errors.js';

/** Approve-time routing decision: non-null ⇒ the implementation approve enters 'delivering'
 *  under this provider (reviewApprove computes it from the workspace's origin URL). */
export interface DeliverySeed { provider: DeliveryProvider; }

/**
 * The approve action for an in_review task: a doc stage (description/plan) advances to
 * the next stage and re-queues; the implementation stage closes the task (human-only —
 * the final gate is never automated). With a `delivery` seed the implementation approve
 * routes to 'delivering' instead of 'done' — done then means the watcher verified the PR
 * merged and the pipeline came up green (or a human force-completed). Runs INSIDE an
 * already-open transaction: `transaction()` cannot nest, and this body is shared by
 * `reviewApprove` (human) and `addComment`'s auto-approve hook (agent, clean doc-stage
 * reviews — that path never passes a delivery seed).
 *
 * `note` rides the status_change body, prefixing the stage-advance trail
 * (e.g. 'auto-approved: clean AI review; stage description → plan').
 */
export function applyApproval(db: DB, row: TaskRow, actor: Actor, ts: string, note?: string, actorUserId: number | null = null, delivery: DeliverySeed | null = null): void {
  // Break-glass audit trail: approving while the *current* AI review has open findings
  // logs an override comment. Derived, no schema change; the override-rate KPI reads the
  // same condition from the activity log (findingsAtApproval). Pending/clean ⇒ no override.
  // The auto path can never hit this — a clean verdict is its precondition (so actorUserId
  // is the approving human here, never the agent).
  const review = aiReviewFor(db, row.id);
  if (review && review.verdict === 'findings') {
    appendActivity(db, {
      taskId: row.id, type: 'comment', actor: 'human',
      body: `override: approved over ${review.findings} open AI finding${review.findings === 1 ? '' : 's'}`,
      createdAt: ts, actorUserId,
    });
  }
  if (row.stage === 'implementation') {
    if (actor !== 'human') throw new InvalidTransitionError('the implementation review is approved by a human, never auto-approved');
    const to: Status = delivery ? 'delivering' : 'done';
    setStatus(db, row.id, to, ts);
    // seed (or reset, on a re-approval) the delivery row inside the same transaction — the
    // watcher must never find a delivering task it can't attribute to a provider/branch
    if (delivery) upsertDelivery(db, row.id, { provider: delivery.provider, branch: row.branch!, prUrl: latestPrLinkUrl(db, row.id) }, ts);
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor, fromStatus: 'in_review', toStatus: to, createdAt: ts,
      body: delivery ? 'approved — awaiting PR merge + green checks' : '', actorUserId,
    });
    return;
  }
  const next = STAGE_ORDER[STAGE_ORDER.indexOf(row.stage) + 1]!;
  setStage(db, row.id, next, ts);
  setStatus(db, row.id, 'queued', ts); // clears the claimant — the next stage is anyone's claim
  appendActivity(db, {
    taskId: row.id, type: 'status_change', actor, fromStatus: 'in_review', toStatus: 'queued', createdAt: ts,
    body: `${note ?? 'approved'}; stage ${row.stage} → ${next}`, actorUserId,
  });
}
