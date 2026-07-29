import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

/**
 * Release a stranded `in_progress` claim back to `queued` — the SYSTEM recovery action behind the
 * dispatcher's crash/timeout reaper and the stale-claim scan. Semantically this is the human
 * claim-recovery edge (`in_progress → queued, by 'human'`), but callers are supervisors, not
 * humans: centralizing it here means a service principal never has to assert `actor: 'human'`
 * over the network (the #45 actor-from-token rule), and the activity body carries the
 * `system-reap` stamp so a reaped release is distinguishable from a human's manual one.
 *
 * The row is read INSIDE the transaction (delivery.ts pattern): five processes share this DB, and
 * the release must never race a concurrent settle into logging a stale from_status.
 */
export function releaseClaim(db: DB, key: string, now: () => string = nowIso): TaskDetail {
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    if (row.status !== 'in_progress')
      throw new InvalidTransitionError(`release requires an in_progress claim (got ${row.status}): ${key}`);
    assertTransition('in_progress', 'queued', 'human');
    const ts = now();
    setStatus(db, row.id, 'queued', ts);
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor: 'human',
      fromStatus: 'in_progress', toStatus: 'queued', createdAt: ts,
      body: 'system-reap: released a stranded claim',
    });
    // the abandoned worker's live session ends with the claim (same as the manual release path)
    endSession(db, row.id, ts);
    return toDetail(db, findRowByKey(db, key)!);
  });
}
