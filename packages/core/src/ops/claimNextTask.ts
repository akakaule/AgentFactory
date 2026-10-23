import type { DB } from '../db.js';
import type { TaskDetail, Stage } from '../types.js';
import { transaction } from '../transaction.js';
import { appendActivity } from '../repo/activity.js';
import { startSession } from '../repo/agentSessions.js';
import { oldestQueuedRow, heldClaimRow, toDetail, claimableQueuedRow, reservedByOther, findRowByKey, type Claimant } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { featureBranch } from '../branch.js';
import { nowIso } from '../time.js';
import { createExecution, currentExecution, executionById, settleExecution, startExecution, supersedeExecution, operationPhase } from '../repo/execution.js';
import { InvalidTransitionError } from '../errors.js';
import { reconcileMergedDelivery } from './delivery.js';
import { getIntakeSettings } from './intakeSettings.js';
import { buildIntakeClaimComment, intakeRevision } from '../intake.js';
import { intakeEnabledFor } from '../intakeSettings.js';
import { intakeForTask } from '../repo/tasks.js';

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
    const claimant: Claimant = { label: opts.claimedBy ?? null, now: now() };
    let row: ReturnType<typeof oldestQueuedRow>;
    if (reservedExecution) {
      // Re-checked at claim time with queue selection's own rules: a dependency added (or a
      // delivery budget exhausted) since the reservation keeps the task unclaimed.
      const reservedTask = claimableQueuedRow(db, reservedExecution.task_id, workspaceId);
      if (!reservedTask ||
          (opts.taskKey !== undefined && reservedTask.key !== opts.taskKey) ||
          (opts.stage !== undefined && reservedTask.stage !== opts.stage) ||
          !['reserved', 'running'].includes(reservedExecution.state) ||
          (opts.claimedBy !== undefined && reservedExecution.owner !== null &&
            reservedExecution.owner !== opts.claimedBy && !opts.claimedBy.startsWith(`${reservedExecution.owner}-a`)))
        throw new InvalidTransitionError(`execution ${opts.executionId} is not claimable`);
      // The reserved task's delivery merged while it waited: reconciliation completes the task,
      // so there is nothing left to claim and the reservation is void. (Reconciliation retires the
      // task's current fence; this one is settled explicitly in case it is not the latest.)
      if (reconcileMergedDelivery(db, reservedTask, now())) {
        settleExecution(db, reservedExecution.id, 'cancelled', now(), 'delivery already merged');
        return null;
      }
      row = reservedTask;
    } else {
      // Queue selection skips a task another claimant's live reservation owns, so an interactive
      // claim never invalidates the fence of a worker its supervisor is still launching.
      row = oldestQueuedRow(db, workspaceId, opts.taskKey, opts.stage, claimant);
      while (row && reconcileMergedDelivery(db, row, now()))
        row = oldestQueuedRow(db, workspaceId, opts.taskKey, opts.stage, claimant);
      if (!row && opts.taskKey !== undefined) {
        const pinned = findRowByKey(db, opts.taskKey);
        if (pinned && claimableQueuedRow(db, pinned.id, workspaceId) && reservedByOther(db, pinned.id, claimant))
          throw new InvalidTransitionError(`${opts.taskKey} is reserved by another live execution`);
      }
    }
    if (!row) return null;
    // Compatibility with workers that were started before execution fencing: a queued task whose
    // live worker-phase reservation is this claimant's (or owner-less) adopts it instead of
    // creating a second execution. Selection already skipped one another claimant owns inside its
    // lease, so any such reservation left here outlived it and is superseded — its attempt counted,
    // exactly as a second reservation would supersede it.
    if (!reservedExecution) {
      const pending = currentExecution(db, row.id);
      if (pending && operationPhase(pending.operation) === 'queued') {
        if (pending.owner === null || pending.owner === opts.claimedBy ||
            (opts.claimedBy !== undefined && opts.claimedBy.startsWith(`${pending.owner}-a`)))
          reservedExecution = pending;
        else supersedeExecution(db, pending, claimant.now);
      }
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
    const intakeSettings = getIntakeSettings(db);
    if (intakeEnabledFor(intakeSettings, row.workspace_name)) {
      const claimedRow = { ...row, status: 'in_progress' as const, claimed_by: claimedBy, claimed_at: ts, updated_at: ts };
      const currentIntake = intakeForTask(db, claimedRow);
      appendActivity(db, {
        taskId: row.id, type: 'comment', actor: 'agent', createdAt: ts,
        body: buildIntakeClaimComment({
          sourceRevision: intakeRevision({ title: row.title, spec: row.spec, acceptanceCriteria: row.acceptance_criteria, stage: row.stage, plan: row.plan }),
          stage: row.stage, assessmentRevision: currentIntake?.state === 'current' ? currentIntake.assessment.sourceRevision : null,
          policyVersion: 'intake-policy/v1', settings: intakeSettings,
        }),
      });
    }
    // a claim starts a live agent session (any path: dispatcher-spawned or worker-loop);
    // heartbeats/milestones update it, submit/exit ends it
    startSession(db, { taskId: row.id, label: claimedBy, workspace: row.workspace_name, stage: row.stage, now: ts });
    const detail = toDetail(db, { ...row, status: 'in_progress', claimed_by: claimedBy, claimed_at: ts, branch, updated_at: ts });
    return { ...detail, branchCreated, executionId: execution.id };
  });
}
