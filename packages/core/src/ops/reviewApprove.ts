import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail } from '../repo/tasks.js';
import { applyApproval, type DeliverySeed } from './approval.js';
import { parseRemoteUrl, resolveOriginUrl } from '../remote.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

/**
 * Human approval of an in_review task. Stage-aware: doc stages advance and re-queue;
 * the implementation stage closes the task — via 'delivering' (the watcher verifies the
 * PR merged + pipeline green before done) when the task has a branch and its workspace's
 * origin is a recognizable git host, straight to 'done' exactly as before otherwise
 * (doc-stage history, legacy no-branch tasks, pr-review tasks, unrecognizable/missing
 * remotes). `resolveOrigin` is injectable for tests; it shells out to git, so it runs
 * BEFORE the transaction — never inside the write lock.
 */
export function reviewApprove(
  db: DB,
  key: string,
  now: () => string = nowIso,
  actorUserId: number | null = null,
  resolveOrigin: (repoPath: string) => string | null = resolveOriginUrl,
): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'in_review') throw new InvalidTransitionError(`approve requires in_review (got ${row.status})`);
  let delivery: DeliverySeed | null = null;
  if (row.stage === 'implementation' && row.kind === 'code' && row.branch !== null) {
    const remote = parseRemoteUrl(resolveOrigin(row.workspace_repo_path) ?? '');
    if (remote) delivery = { provider: remote.provider };
  }
  return transaction(db, () => {
    applyApproval(db, row, 'human', now(), undefined, actorUserId, delivery);
    return toDetail(db, findRowByKey(db, key)!);
  });
}
