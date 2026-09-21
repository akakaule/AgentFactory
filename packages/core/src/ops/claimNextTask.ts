import type { DB } from '../db.js';
import type { TaskDetail, Stage } from '../types.js';
import { transaction } from '../transaction.js';
import { appendActivity } from '../repo/activity.js';
import { startSession } from '../repo/agentSessions.js';
import { oldestQueuedRow, heldClaimRow, toDetail } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { featureBranch } from '../branch.js';
import { nowIso } from '../time.js';
import { createExecution, currentExecution, executionById, settleExecution, startExecution } from '../repo/execution.js';
import { InvalidTransitionError } from '../errors.js';
import { reconcileMergedDelivery } from './delivery.js';

export interface ClaimOptions {
  workspace?: string | undefined;
  claimedBy?: string | undefined;
  executionId?: string | undefined;
  taskKey?: string | undefined;
  stage?: Stage | undefined;
}

/**
 * Claim result = the task detail plus `branchCreated`: true when this claim freshly
 * named the branch (first claim, or a legacy null-branch task), false when it reused
 * a branch a prior claim already persisted. The MCP layer turns this into the
 * create-with-`-b` vs. reuse worktree-setup command — the agent never guesses.
 */
export interface ClaimResult extends TaskDetail { branchCreated: boolean; executionId: string; }

export function claimNextTask(db: DB, opts: ClaimOptions = {}, now: () => string = nowIso): ClaimResult | null {
  return transaction(db, () => {
    const workspaceId = opts.workspace === undefined ? undefined : requireWorkspaceByName(db, opts.workspace).id;
    // Reconciliation: a worker that already holds a live claim gets it back instead of a second
    // task — so a claim whose response was lost in transit (remote HTTP worker) is retried
    // idempotently, and an interrupted session resumes what it holds. branchCreated=false: the
    // branch was named by the original claim; the reclaim protocol handles a branch that was
    // never actually created.
    if (opts.claimedBy !== undefined) {
      const held = heldClaimRow(db, opts.claimedBy, workspaceId);
      if (held) {
        if ((opts.taskKey !== undefined && held.key !== opts.taskKey) ||
            (opts.stage !== undefined && held.stage !== opts.stage)) return null;
        if (reconcileMergedDelivery(db, held, now())) return null;
        const current = currentExecution(db, held.id);
        if (opts.executionId !== undefined && (!current || current.id !== opts.executionId))
          throw new InvalidTransitionError(`execution ${opts.executionId} is not the current execution for ${held.key}`);
        const execution = current ?? createExecution(db, {
          taskId: held.id, taskKey: held.key, stage: held.stage, operation: `worker:${held.stage}`,
          generation: 1, attempt: 1, maxAttempts: 1, owner: opts.claimedBy, now: now(),
        });
        return { ...toDetail(db, held), branchCreated: false, executionId: execution.id };
      }
    }
    let reservedExecution = opts.executionId === undefined ? null : executionById(db, opts.executionId);
    if (opts.executionId !== undefined && !reservedExecution)
      throw new InvalidTransitionError(`execution ${opts.executionId} does not exist`);
    let row: ReturnType<typeof oldestQueuedRow>;
    if (reservedExecution) {
      const reservedTask = findQueuedById(db, reservedExecution.task_id);
      if (!reservedTask || (workspaceId !== undefined && reservedTask.workspace_id !== workspaceId) ||
          (opts.taskKey !== undefined && reservedTask.key !== opts.taskKey) ||
          (opts.stage !== undefined && reservedTask.stage !== opts.stage) ||
          !['reserved', 'running'].includes(reservedExecution.state) ||
          (opts.claimedBy !== undefined && reservedExecution.owner !== null &&
            reservedExecution.owner !== opts.claimedBy && !opts.claimedBy.startsWith(`${reservedExecution.owner}-a`)))
        throw new InvalidTransitionError(`execution ${opts.executionId} is not claimable`);
      // The reserved task's delivery merged while it waited: reconciliation completes the task,
      // so there is nothing left to claim and the reservation is void.
      if (reconcileMergedDelivery(db, reservedTask, now())) {
        settleExecution(db, reservedExecution.id, 'cancelled', now(), 'delivery already merged');
        return null;
      }
      row = reservedTask;
    } else {
      row = oldestQueuedRow(db, workspaceId, opts.taskKey, opts.stage);
      while (row && reconcileMergedDelivery(db, row, now()))
        row = oldestQueuedRow(db, workspaceId, opts.taskKey, opts.stage);
    }
    if (!row && opts.executionId === undefined && opts.taskKey === undefined && opts.stage === undefined) {
      const pending = db.prepare(
        `SELECT task_id, owner FROM task_execution WHERE state = 'reserved' AND (owner IS NULL OR ? LIKE owner || '-a%')
         ORDER BY reserved_at ASC, rowid ASC LIMIT 1`,
      ).get(opts.claimedBy ?? null) as { task_id: number } | undefined;
      if (pending) {
        reservedExecution = currentExecution(db, pending.task_id) ?? null;
        row = findQueuedById(db, pending.task_id);
      }
    }
    if (!row) return null;
    // Compatibility with workers that were started before execution fencing: a queued task with
    // one supervisor reservation adopts that reservation instead of creating a second execution.
    // New MCP workers always pass the id explicitly, while this keeps old local loops recoverable.
    if (!reservedExecution) {
      const pending = currentExecution(db, row.id);
      if ((pending?.state === 'reserved' || pending?.state === 'running') && (pending.owner === null || pending.owner === opts.claimedBy ||
          (opts.claimedBy !== undefined && pending.owner !== null && opts.claimedBy.startsWith(`${pending.owner}-a`))))
        reservedExecution = pending;
    }
    const ts = now();
    const claimedBy = opts.claimedBy ?? null;
    // The branch is named once and persisted, so a reclaim reuses it even after a
    // title edit. A null branch (first claim, or a task claimed before this feature)
    // gets a fresh name now and is flagged for the create-with-`-b` setup form.
    // Doc stages (description/plan) never touch the repo: the branch stays NULL until
    // the first implementation-stage claim, so the slug derives from the final title.
    const isImplementation = row.stage === 'implementation';
    const branchCreated = isImplementation && row.branch === null;
    const branch = isImplementation ? row.branch ?? featureBranch(row.key, row.title) : row.branch;
    const updated = db.prepare(
      "UPDATE task SET status='in_progress', claimed_by=?, claimed_at=?, branch=?, updated_at=? WHERE id=? AND status='queued'"
    ).run(claimedBy, ts, branch, ts, row.id);
    // The status guard can miss if another process claimed the row between our snapshot and
    // this write. Never report a claim the DB did not make — no activity, no session, no detail.
    if (updated.changes === 0) return null;
    const execution = reservedExecution
      ? (startExecution(db, reservedExecution.id, ts, claimedBy ?? undefined), { id: reservedExecution.id })
      : createExecution(db, {
          taskId: row.id, taskKey: row.key, stage: row.stage, operation: `worker:${row.stage}`,
          generation: 1, attempt: 1, maxAttempts: 1, owner: claimedBy, now: ts,
        });
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor: 'agent',
      fromStatus: 'queued', toStatus: 'in_progress', createdAt: ts,
      // worker label rides the claim row so releases stay attributable after
      // claimed_by is cleared on re-queue (analytics: stranded releases per worker)
      body: claimedBy ?? '',
    });
    // a claim starts a live agent session (any path: dispatcher-spawned or worker-loop);
    // heartbeats/milestones update it, submit/exit ends it
    startSession(db, { taskId: row.id, label: claimedBy, workspace: row.workspace_name, stage: row.stage, now: ts });
    const detail = toDetail(db, { ...row, status: 'in_progress', claimed_by: claimedBy, claimed_at: ts, branch, updated_at: ts });
    return { ...detail, branchCreated, executionId: execution.id };
  });
}

function findQueuedById(db: DB, id: number): ReturnType<typeof oldestQueuedRow> {
  return db.prepare(
    `SELECT task.*, w.name AS workspace_name, w.repo_path AS workspace_repo_path,
            w.policy AS workspace_policy, w.verify_command AS workspace_verify_command,
            (SELECT COUNT(*) FROM task_dependency dependency
             JOIN task prerequisite ON prerequisite.id = dependency.depends_on_task_id
             WHERE dependency.task_id = task.id AND prerequisite.status != 'done') AS unmet_dependency_count
       FROM task JOIN workspace w ON w.id = task.workspace_id
      WHERE task.id = ? AND task.status = 'queued' AND task.archived_at IS NULL`,
  ).get(id) as ReturnType<typeof oldestQueuedRow>;
}
