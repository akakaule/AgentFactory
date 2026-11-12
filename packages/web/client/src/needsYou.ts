import type { Task } from './types.js';

/** What a task needs from the human. Ordered by how directly the human unblocks work. */
export type NeedKind = 'question' | 'review' | 'attempts' | 'setup' | 'delivery' | 'spec';

export interface Need {
  task: Task;
  kind: NeedKind;
  /** When the wait began (ISO): the block, the failure, the delivery state change, or the last update. */
  since: string;
}

const RANK: Record<NeedKind, number> = { question: 0, review: 1, attempts: 2, setup: 3, delivery: 4, spec: 5 };
/** A review with no AI verdict after this long is waiting on a reviewer that is not coming (the notifier's default). */
export const REVIEW_WAIT_MS = 30 * 60000;
/** A delivery that has not changed state for this long is stuck (the notifier's default). */
export const DELIVERY_WAIT_MS = 60 * 60000;

/** A failure only a human can fix (credentials, permissions, a missing tool) — same rule as the notifier. */
export function needsSetup(task: Pick<Task, 'failure'>): boolean {
  const f = task.failure;
  return !!f && (f.reason === 'spawn_failed' ||
    /credentials?|authentication|unauthorized|permission|not found|missing (?:cli|checkout|token)/i.test(f.detail ?? ''));
}

function needOf(t: Task, now: number): Need | null {
  if (t.archivedAt || t.status === 'done' || t.status === 'cancelled') return null;
  if (t.status === 'blocked') return { task: t, kind: 'question', since: t.block?.at ?? t.updatedAt };
  if (t.failure && needsSetup(t)) return { task: t, kind: 'setup', since: t.failure.at };
  if (t.failure?.skipListed) return { task: t, kind: 'attempts', since: t.failure.at };
  if (t.status === 'delivering') {
    const d = t.delivery;
    if (d?.repairExhausted) return { task: t, kind: 'attempts', since: d.stateChangedAt };
    const since = d?.stateChangedAt ?? t.updatedAt;
    if (d?.checksState === 'failing' || now - Date.parse(since) >= DELIVERY_WAIT_MS) return { task: t, kind: 'delivery', since };
    return null;
  }
  if (t.status === 'in_review') {
    const verdict = t.aiReview?.verdict;
    const waited = now - Date.parse(t.updatedAt) >= REVIEW_WAIT_MS;
    const ready = t.kind === 'pr-review' || waited || t.aiReview?.binding === 'unverified' || (t.stage === 'implementation'
      ? verdict !== undefined && verdict !== 'pending'
      : verdict === 'findings' || verdict === 'disputed');
    return ready ? { task: t, kind: 'review', since: t.updatedAt } : null;
  }
  if (t.status === 'backlog' && t.queueGate?.action === 'block') return { task: t, kind: 'spec', since: t.updatedAt };
  return null;
}

/** Every task waiting on the human, derived from task state alone: a card leaves when the task moves on. */
export function needsYou(tasks: Task[], now: number = Date.now()): Need[] {
  return tasks.map((t) => needOf(t, now)).filter((n): n is Need => n !== null)
    .sort((a, b) => RANK[a.kind] - RANK[b.kind] || a.since.localeCompare(b.since));
}

/** An inline approve is offered only where there is nothing left to read: a clean, current AI review of an
 *  implementation with a known head, no open decisions and every criterion met. Anything else opens the review. */
export function canQuickApprove(t: Task): boolean {
  const brief = t.reviewBrief;
  return t.status === 'in_review' && t.kind === 'code' && t.stage === 'implementation'
    && t.aiReview?.verdict === 'clean' && t.aiReview.binding === 'current'
    && !!t.submission?.headSha && !!brief && brief.counts.must === 0 && brief.counts.call === 0
    && brief.criteria.every((c) => c.status === 'clear');
}
