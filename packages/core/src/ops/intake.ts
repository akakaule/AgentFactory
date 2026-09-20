import type { DB } from '../db.js';
import type { Activity, IntakeAssessmentV1, IntakeSettings, TaskDetail, RetryReservation } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, intakeForTask, toDetail } from '../repo/tasks.js';
import { appendActivity, intakeMarkerActivities } from '../repo/activity.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { updateStatusWithinTransaction } from './updateStatus.js';
import { nowIso } from '../time.js';
import { buildIntakeComment, buildIntakeOverrideComment, intakeRevision, parseIntakeComment, validateIntakeAssessment } from '../intake.js';
import { getIntakeSettings } from './intakeSettings.js';
import { intakeEnabledFor } from '../intakeSettings.js';
import { activeRetryAttempt, markRetryRunning, reserveRetry as reserveRetryRow, settleRetry as settleRetryRow } from '../repo/retry.js';

export interface BeginIntakeAssessmentResult {
  status: 'started' | 'busy' | 'deferred' | 'exhausted' | 'already_assessed' | 'ineligible';
  sourceRevision: string;
  reservation?: RetryReservation;
  deadlineAt?: string;
  retryAt?: string;
}

function requireTask(db: DB, key: string) {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return row;
}

function currentRevision(row: ReturnType<typeof requireTask>): string {
  return intakeRevision({ title: row.title, spec: row.spec, acceptanceCriteria: row.acceptance_criteria, stage: row.stage, plan: row.plan });
}

function ensureEnabled(row: ReturnType<typeof requireTask>, settings: IntakeSettings): void {
  if (row.kind !== 'code' || row.archived_at !== null || !intakeEnabledFor(settings, row.workspace_name))
    throw new InvalidTransitionError('intake is disabled for this task workspace');
}

export function beginIntakeAssessment(db: DB, key: string, sourceRevision: string, maxAttempts: number, now: () => string = nowIso): BeginIntakeAssessmentResult {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ValidationError('maxAttempts must be a positive integer');
  return transaction(db, () => {
    const row = requireTask(db, key);
    const settings = getIntakeSettings(db);
    if (row.kind !== 'code' || row.archived_at !== null || !intakeEnabledFor(settings, row.workspace_name))
      return { status: 'ineligible', sourceRevision };
    const revision = currentRevision(row);
    if (sourceRevision !== revision) throw new InvalidTransitionError('task changed before intake assessment started');
    const existing = intakeMarkerActivities(db, row.id)
      .map((a) => parseIntakeComment(a.body))
      .find((a): a is IntakeAssessmentV1 => a !== null && a.sourceRevision === revision);
    if (existing) return { status: 'already_assessed', sourceRevision: revision };
    const operation = `intake:assess:${revision}`;
    const timestamp = now();
    const active = activeRetryAttempt(db, row.id, operation);
    if (active) {
      const expired = active.state === 'running' && Date.parse(active.reserved_at) + 150_000 <= Date.parse(timestamp);
      if (expired) {
        db.prepare(`UPDATE retry_attempt SET state = 'failed', settled_at = ?, terminal_reason = 'abandoned' WHERE id = ? AND state = 'running'`).run(timestamp, active.id);
      } else {
        return { status: 'busy', sourceRevision: revision };
      }
    }
    const budget = db.prepare('SELECT attempts_used, max_attempts FROM retry_budget WHERE task_id = ? AND operation = ? ORDER BY generation DESC LIMIT 1').get(row.id, operation) as { attempts_used: number; max_attempts: number } | undefined;
    if (budget && budget.attempts_used >= budget.max_attempts) return { status: 'exhausted', sourceRevision: revision };
    const latest = db.prepare(`SELECT attempt, settled_at, terminal_reason FROM retry_attempt a JOIN retry_budget b ON b.id = a.budget_id WHERE b.task_id = ? AND b.operation = ? AND a.state = 'failed' ORDER BY a.attempt DESC LIMIT 1`).get(row.id, operation) as { attempt: number; settled_at: string | null; terminal_reason: string | null } | undefined;
    const retryable = new Set(['timeout', 'rate_limit', 'network', 'invalid_response']);
    if (latest?.settled_at && latest.terminal_reason && retryable.has(latest.terminal_reason)) {
      const delayMs = Math.min(300_000, 5_000 * (2 ** Math.max(0, latest.attempt - 1)));
      const retryAt = new Date(Date.parse(latest.settled_at) + delayMs);
      if (retryAt.getTime() > Date.parse(timestamp)) return { status: 'deferred', sourceRevision: revision, retryAt: retryAt.toISOString() };
    }
    const reservation = reserveRetryRow(db, row.id, key, { operation, maxAttempts }, timestamp);
    if (!reservation) return { status: 'exhausted', sourceRevision: revision };
    const running = markRetryRunning(db, reservation);
    const deadlineAt = new Date(Date.parse(running.reservedAt) + 150_000).toISOString();
    return { status: 'started', sourceRevision: revision, reservation: running, deadlineAt };
  });
}

export function recordIntakeAssessment(db: DB, key: string, input: unknown, now: () => string = nowIso): IntakeAssessmentV1 {
  const assessment = validateIntakeAssessment(input);
  if (assessment.taskKey !== key) throw new ValidationError('assessment taskKey does not match the task');
  return transaction(db, () => {
    const row = requireTask(db, key);
    const settings = getIntakeSettings(db);
    ensureEnabled(row, settings);
    if (assessment.sourceRevision !== currentRevision(row)) throw new InvalidTransitionError('task changed while intake assessment was running');
    if (assessment.stage !== row.stage) throw new InvalidTransitionError('assessment stage does not match the task');
    const existing = intakeMarkerActivities(db, row.id)
      .map((a) => parseIntakeComment(a.body))
      .find((a): a is IntakeAssessmentV1 => a !== null && a.sourceRevision === assessment.sourceRevision);
    if (existing) return existing;
    if (assessment.attemptId) {
      const attempt = db.prepare(`SELECT a.id, a.state FROM retry_attempt a JOIN retry_budget b ON b.id = a.budget_id WHERE a.id = ? AND b.task_id = ? AND b.operation = ?`).get(assessment.attemptId, row.id, `intake:assess:${assessment.sourceRevision}`) as { id: string; state: string } | undefined;
      if (!attempt || attempt.state !== 'running') throw new InvalidTransitionError('intake assessment attempt is no longer active');
    }
    const ts = now();
    appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', body: buildIntakeComment(assessment), createdAt: ts });
    db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(ts, row.id);
    if (assessment.attemptId) settleRetryRow(db, assessment.attemptId, assessment.status === 'assessed' ? 'succeeded' : 'failed', ts, assessment.status === 'unavailable' ? assessment.error.kind : undefined);
    return assessment;
  });
}

export function intakeHistory(db: DB, key: string): Activity[] {
  const row = requireTask(db, key);
  const ids = new Set(intakeMarkerActivities(db, row.id).map((a) => a.id));
  const rows = db.prepare(
    `SELECT a.id, a.task_id, a.type, a.actor, a.from_status, a.to_status, a.body, a.created_at,
            a.actor_user_id, u.display_name AS actor_name
       FROM activity a LEFT JOIN app_user u ON u.id = a.actor_user_id
      WHERE a.task_id = ? AND a.id IN (${[...ids].map(() => '?').join(',') || 'NULL'} ) ORDER BY a.id ASC`,
  ).all(row.id, ...ids) as Array<{
    id: number; task_id: number; type: Activity['type']; actor: Activity['actor']; from_status: Activity['fromStatus']; to_status: Activity['toStatus']; body: string; created_at: string; actor_user_id: number | null; actor_name: string | null;
  }>;
  return rows.map((a) => ({ id: a.id, taskId: a.task_id, type: a.type, actor: a.actor, fromStatus: a.from_status, toStatus: a.to_status, body: a.body, createdAt: a.created_at, actorUserId: a.actor_user_id, actorName: a.actor_name }));
}

function expectedCurrentPolicy(db: DB, key: string, expectedRevision: string) {
  const row = requireTask(db, key);
  const revision = currentRevision(row);
  if (revision !== expectedRevision) throw new InvalidTransitionError('task changed; refresh the intake notice');
  const summary = intakeForTask(db, row);
  if (!summary || summary.state !== 'current' || !summary.policy) throw new InvalidTransitionError('no current intake policy is available');
  return { row, revision, summary };
}

export function overrideIntake(db: DB, key: string, input: { expectedRevision: string; reason?: string | undefined; actorUserId?: number | null }, now: () => string = nowIso): TaskDetail {
  return transaction(db, () => {
    const { row, revision, summary } = expectedCurrentPolicy(db, key, input.expectedRevision);
    const policy = summary.policy;
    if (!policy || policy.eligibility !== 'attention_required') throw new InvalidTransitionError('the current intake policy does not require an override');
    const settings = getIntakeSettings(db);
    const reason = input.reason?.trim() || null;
    appendActivity(db, { taskId: row.id, type: 'comment', actor: 'human', actorUserId: input.actorUserId ?? null, body: buildIntakeOverrideComment({ sourceRevision: revision, policy, reason, settings }), createdAt: now() });
    const ts = now();
    db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(ts, row.id);
    return toDetail(db, findRowByKey(db, key)!);
  });
}

export function queueWithIntakeAcknowledgment(db: DB, key: string, input: { expectedRevision?: string | undefined; reason?: string | undefined; actorUserId?: number | null }, now: () => string = nowIso): TaskDetail {
  return transaction(db, () => {
    const row = requireTask(db, key);
    if (row.status !== 'backlog') throw new InvalidTransitionError('only backlog tasks can be queued');
    const summary = intakeForTask(db, row);
    const settings = getIntakeSettings(db);
    const needsOverride = summary?.state === 'current' && summary.policy?.eligibility === 'attention_required' && !summary.overridden;
    if (needsOverride) {
      if (!input.expectedRevision) throw new InvalidTransitionError('intake acknowledgment is required');
      const expected = expectedCurrentPolicy(db, key, input.expectedRevision);
      const ts = now();
      appendActivity(db, { taskId: row.id, type: 'comment', actor: 'human', actorUserId: input.actorUserId ?? null, body: buildIntakeOverrideComment({ sourceRevision: expected.revision, policy: expected.summary.policy!, reason: input.reason?.trim() || null, settings }), createdAt: ts });
    }
    return updateStatusWithinTransaction(db, key, 'queued', 'human', now, input.actorUserId ?? null);
  });
}

export function intakeRuntimeSettings(db: DB): IntakeSettings {
  return getIntakeSettings(db);
}
