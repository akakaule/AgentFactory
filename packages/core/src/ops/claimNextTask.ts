import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { appendActivity } from '../repo/activity.js';
import { oldestQueuedRow, toDetail } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { featureBranch } from '../branch.js';
import { nowIso } from '../time.js';

export interface ClaimOptions {
  workspace?: string | undefined;
  claimedBy?: string | undefined;
}

/**
 * Claim result = the task detail plus `branchCreated`: true when this claim freshly
 * named the branch (first claim, or a legacy null-branch task), false when it reused
 * a branch a prior claim already persisted. The MCP layer turns this into the
 * create-with-`-b` vs. reuse worktree-setup command — the agent never guesses.
 */
export interface ClaimResult extends TaskDetail { branchCreated: boolean; }

export function claimNextTask(db: DB, opts: ClaimOptions = {}, now: () => string = nowIso): ClaimResult | null {
  return transaction(db, () => {
    const workspaceId = opts.workspace === undefined ? undefined : requireWorkspaceByName(db, opts.workspace).id;
    const row = oldestQueuedRow(db, workspaceId);
    if (!row) return null;
    const ts = now();
    const claimedBy = opts.claimedBy ?? null;
    // The branch is named once and persisted, so a reclaim reuses it even after a
    // title edit. A null branch (first claim, or a task claimed before this feature)
    // gets a fresh name now and is flagged for the create-with-`-b` setup form.
    const branchCreated = row.branch === null;
    const branch = row.branch ?? featureBranch(row.key, row.title);
    db.prepare(
      "UPDATE task SET status='in_progress', claimed_by=?, claimed_at=?, branch=?, updated_at=? WHERE id=? AND status='queued'"
    ).run(claimedBy, ts, branch, ts, row.id);
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor: 'agent',
      fromStatus: 'queued', toStatus: 'in_progress', createdAt: ts,
      // worker label rides the claim row so releases stay attributable after
      // claimed_by is cleared on re-queue (analytics: stranded releases per worker)
      body: claimedBy ?? '',
    });
    const detail = toDetail(db, { ...row, status: 'in_progress', claimed_by: claimedBy, claimed_at: ts, branch, updated_at: ts });
    return { ...detail, branchCreated };
  });
}
