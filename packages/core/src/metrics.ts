import type { ActivityType, Status } from './types.js';

/** Minimal activity projection the derivation walks (full history, id order). */
export interface ActivityStep {
  type: ActivityType;
  fromStatus: Status | null;
  toStatus: Status | null;
  createdAt: string;
  body?: string;
}

export interface DerivedTaskMetrics {
  queueMin: number;
  workMin: number;
  reviewMin: number;
  blockedMin: number;
  rounds: number;       // feedback rows (request-changes round-trips)
  reopened: boolean;    // any done → queued transition
  claimCount: number;   // queued → in_progress transitions
  doneAt: string | null; // last transition into done; null while not done
}

const BUCKET: Partial<Record<Status, 'queueMin' | 'workMin' | 'reviewMin' | 'blockedMin'>> = {
  queued: 'queueMin',
  in_progress: 'workMin',
  in_review: 'reviewMin',
  blocked: 'blockedMin',
};

/**
 * Stage walk over a task's full status history. Backlog and done time are not
 * bucketed (cycle = queue + work + review + blocked); the open segment of a
 * non-done task accrues to `now`.
 */
export function deriveTaskMetrics(activity: ActivityStep[], now: string): DerivedTaskMetrics {
  const m: DerivedTaskMetrics = {
    queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0,
    rounds: 0, reopened: false, claimCount: 0, doneAt: null,
  };
  let current: Status | null = null;
  let since = 0;
  const credit = (until: number) => {
    const bucket = current && BUCKET[current];
    if (bucket && until > since) m[bucket] += (until - since) / 60000;
  };
  for (const step of activity) {
    if (step.type === 'feedback') { m.rounds += 1; continue; }
    if (step.type !== 'status_change' || !step.toStatus) continue;
    const ts = Date.parse(step.createdAt);
    credit(ts);
    if (step.fromStatus === 'queued' && step.toStatus === 'in_progress') m.claimCount += 1;
    if (step.fromStatus === 'done' && step.toStatus === 'queued') m.reopened = true;
    if (step.toStatus === 'done') m.doneAt = step.createdAt;
    else if (step.fromStatus === 'done') m.doneAt = null; // reopened: not done until approved again
    current = step.toStatus;
    since = ts;
  }
  if (current !== 'done') credit(Date.parse(now));
  return m;
}
