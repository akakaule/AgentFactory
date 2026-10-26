import type { DB } from '../db.js';
import type { TaskDetail, DeliverySummary, DeliveryProvider } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus, touch, type TaskRow } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { currentExecution, operationPhase, settleExecution } from '../repo/execution.js';
import { latestPrLinkUrl } from '../repo/links.js';
import { deliveryRowFor, updateDeliveryObservation, upsertDelivery, toDeliverySummary, type DeliveryObservation } from '../repo/delivery.js';
import { insertDependency } from '../repo/taskDependencies.js';
import { createTaskWithinTransaction } from './createTask.js';
import { buildFailureComment } from '../failure.js';
import { NotFoundError, ValidationError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';
import { reserveRetry as reserveRetryRow, settleRetry as settleRetryRow, advanceRetryBudget, budgetByTask, deliveryExhaustionReported } from '../repo/retry.js';

const DEFAULT_DELIVERY_REPAIR_ATTEMPTS = 2;

/**
 * How long after the last observed delivery change (normally the merge) a merged PR without a red
 * or pending verdict ('none'/'unknown'/'passing') stays observed: CI often publishes post-merge
 * checks only after the first poll, or after a fast check already passed. Pending checks stay
 * observed until they settle.
 */
export const POST_MERGE_CHECK_PUBLICATION_MS = 60 * 60_000;

/**
 * A merged delivery whose post-merge checks have no final verdict yet — pending, or none/unknown/
 * passing within the publication window (another check may still be published) — so a later red
 * verdict still gets its follow-up task.
 * Shared by core's acceptance guard and the watcher's selection so the two agree.
 */
export function awaitingPostMergeChecks(
  d: Pick<DeliverySummary, 'prState' | 'checksState' | 'stateChangedAt'>,
  nowMs: number,
): boolean {
  if (d.prState !== 'merged') return false;
  if (d.checksState === 'pending') return true;
  if (d.checksState === 'failing') return false;
  const since = Date.parse(d.stateChangedAt);
  return Number.isFinite(since) && nowMs - since < POST_MERGE_CHECK_PUBLICATION_MS;
}

/** The watcher's reasons for bouncing a delivering task back to the queue. */
export type DeliveryFailureReason = 'ci_failed' | 'pr_closed' | 'merge_conflict';

// The watcher (its own process) races the web server's human overrides on these rows, so unlike
// the single-process ops the status read happens INSIDE the BEGIN IMMEDIATE transaction.
function requireRow(db: DB, key: string) {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return row;
}

/** The delivery state for one task (or null) — rides TaskDetail; exposed for the watcher too. */
export function getDelivery(db: DB, key: string): DeliverySummary | null {
  const row = requireRow(db, key);
  const d = deliveryRowFor(db, row.id);
  return d ? toDeliverySummary(d) : null;
}

/**
 * Seed a delivery row for a task already in 'delivering' that has none — the watcher's self-heal
 * for a raw in_review → delivering drag (approve seeds it in-transaction; a drag bypasses that).
 */
export function beginDelivery(db: DB, key: string, seed: { provider: DeliveryProvider; branch: string; prUrl?: string | null }, now: () => string = nowIso): DeliverySummary {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (row.status !== 'delivering') throw new ValidationError(`beginDelivery requires status 'delivering' (got ${row.status})`);
    upsertDelivery(db, row.id, { provider: seed.provider, branch: seed.branch, prUrl: seed.prUrl ?? null }, now());
    return toDeliverySummary(deliveryRowFor(db, row.id)!);
  });
}

/**
 * Record one watcher poll. Always refreshes checked_at; bumps the task (→ getVersion → UI refetch)
 * only when the observed PR/checks state actually changed. A confirmed merge also completes
 * the current delivery in this transaction, including during repair. Terminal/archived tasks and stale
 * observations are ignored so a slow provider response cannot overwrite a newer delivery.
 */
export function recordDeliveryCheck(db: DB, key: string, obs: DeliveryObservation, now: () => string = nowIso): { changed: boolean; skipped?: boolean; accepted: boolean; stateChangedAt: string | null } {
  return transaction(db, () => {
    const row = requireRow(db, key);
    const d = deliveryRowFor(db, row.id);
    if (!d) return { changed: false, skipped: true, accepted: false, stateChangedAt: null }; // nothing seeded
    // A completed delivery stays observed while its merged PR's post-merge checks have no final
    // verdict, so a later red verdict still gets its follow-up task; nothing else about a done
    // task is observed, and only merge-commit check evidence counts as post-merge.
    const ts = now();
    const postMergeEvidence = obs.prState === 'merged' && obs.checksTarget === 'merge_commit';
    const awaitingPostMerge = row.status === 'done' && postMergeEvidence &&
      awaitingPostMergeChecks(toDeliverySummary(d), Date.parse(ts));
    if (row.archived_at || !(awaitingPostMerge || ['delivering', 'queued', 'in_progress', 'blocked', 'in_review'].includes(row.status))) return { changed: false, skipped: true, accepted: false, stateChangedAt: null };
    const expected = obs.expected;
    if (expected && (expected.status !== row.status || expected.branch !== d.branch ||
        expected.prUrl !== d.pr_url || expected.stateChangedAt !== d.state_changed_at)) return { changed: false, skipped: true, accepted: false, stateChangedAt: null };
    const { changed, accepted } = updateDeliveryObservation(db, d, obs, ts);
    if (!accepted) return { changed: false, skipped: true, accepted: false, stateChangedAt: null };
    const stateChangedAt = changed ? ts : d.state_changed_at;
    if (awaitingPostMerge) {
      const followUp = ensurePostMergeFollowUp(db, row, ts);
      if (followUp) appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', createdAt: ts,
        body: `Post-merge checks failed on PR ${d.pr_id ?? d.pr_url}; follow-up ${followUp} tracks the repair.` });
      if (changed) touch(db, row.id, ts);
      return { changed, accepted, stateChangedAt };
    }
    if (reconcileMergedDelivery(db, row, ts, undefined, postMergeEvidence)) return { changed: true, accepted, stateChangedAt };
    if (changed) touch(db, row.id, ts);
    return { changed, accepted, stateChangedAt };
  });
}

/**
 * Finish a previously observed merged delivery. The stored facts, not a caller's note, authorize
 * completion. Used to recover legacy queued deliveries before dispatching another worker.
 */
export function completeDelivery(db: DB, key: string, note: string, expectedStateChangedAt?: string, now: () => string = nowIso): TaskDetail {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (expectedStateChangedAt !== undefined && deliveryRowFor(db, row.id)?.state_changed_at !== expectedStateChangedAt)
      throw new InvalidTransitionError(`stale delivery observation for ${key}`);
    if (!reconcileMergedDelivery(db, row, now(), note))
      throw new InvalidTransitionError(`completion requires a current merged delivery: ${key}`);
    return toDetail(db, findRowByKey(db, key)!);
  });
}

/** Runs inside the caller's transaction (observation, retry, or claim); never nests a transaction. */
export function reconcileMergedDelivery(db: DB, row: TaskRow, ts: string, note?: string, postMergeEvidence = false): boolean {
  if (row.archived_at || row.kind !== 'code' || row.stage !== 'implementation' ||
      !['delivering', 'queued', 'in_progress', 'blocked', 'in_review'].includes(row.status)) return false;
  const d = deliveryRowFor(db, row.id);
  if (!d || d.pr_state !== 'merged' || !d.pr_url || !d.checked_at || d.branch !== row.branch) return false;
  // A repair may already have submitted a replacement PR, pending its own approval.
  const latestPr = latestPrLinkUrl(db, row.id);
  if (latestPr && latestPr !== d.pr_url) return false;
  assertTransition(row.status, 'done', 'agent');
  setStatus(db, row.id, 'done', ts);
  endSession(db, row.id, ts);
  // A repair worker still running has nothing left to own: retire its fence with its session, so
  // its late output is stale and a reopened task is free for a new claimant.
  const live = currentExecution(db, row.id);
  if (live && operationPhase(live.operation) === 'queued') settleExecution(db, live.id, 'cancelled', ts, 'delivery already merged');
  // Failing PR-head checks on a merged PR are history, not post-merge evidence: no follow-up.
  const followUp = postMergeEvidence ? ensurePostMergeFollowUp(db, row, ts) : null;
  const body = `PR ${d.pr_id ?? d.pr_url} merged; checks ${d.checks_state}. Original delivery complete; ` +
    (followUp ? `follow-up ${followUp} tracks the post-merge check repair.` : 'further CI repair is separate work.');
  appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: row.status,
    toStatus: 'done', body: note ? `${body}\n${note}` : body, createdAt: ts });
  return true;
}

/**
 * Failing post-merge (merge-commit) checks on a merged delivery become one linked backlog task in the same
 * workspace: it references the PR as a plain 'url' link (a 'pr' link would seed the follow-up's
 * own delivery with the already-merged PR on approval), depends on the original task, and lists
 * the red checks. Idempotent per PR (an existing dependent linking that PR counts). Returns the new task's key,
 * or null when nothing was created. Runs inside the caller's transaction.
 */
function ensurePostMergeFollowUp(db: DB, row: TaskRow, ts: string): string | null {
  const d = deliveryRowFor(db, row.id);
  if (!d || d.pr_state !== 'merged' || d.checks_state !== 'failing' || !d.pr_url) return null;
  const existing = db.prepare(
    `SELECT t.key FROM task t JOIN task_dependency dep ON dep.task_id = t.id JOIN link l ON l.task_id = t.id
      WHERE dep.depends_on_task_id = ? AND l.kind IN ('url', 'pr') AND l.url = ? LIMIT 1`,
  ).get(row.id, d.pr_url) as { key: string } | undefined;
  if (existing) return null;
  const pr = d.pr_id ?? d.pr_url;
  const failing = toDeliverySummary(d).failing.map((f) => `- ${f.name}${f.url ? ` — ${f.url}` : ''}`).join('\n') || '- (no check names reported)';
  const task = createTaskWithinTransaction(db, {
    title: `Fix post-merge checks for ${row.key} (PR ${pr})`,
    spec: `${row.key} "${row.title}" was merged in ${d.pr_url}, but the checks on the merge commit failed:\n${failing}\n\nThe original delivery is complete; this task repairs the post-merge failures on the default branch.`,
    acceptanceCriteria: '1. The failing post-merge checks listed in the spec pass on the default branch.',
    stage: 'description',
    workspace: row.workspace_name,
    links: [{ kind: 'url', label: `PR ${pr}`, url: d.pr_url }],
    actor: 'agent',
  }, () => ts);
  insertDependency(db, task.id, row.id, ts);
  return task.key;
}

/**
 * The watcher's bounce: CI failed, the PR was closed unmerged, or the PR cannot merge cleanly
 * ⇒ one transaction posting a `failure/v1` comment (reason ci_failed | pr_closed |
 * merge_conflict — rendered by the existing failure chip, carried into the next claim payload so
 * the fixing session reads why) AND re-queuing the task.
 * Comment + requeue must not tear: a requeue without the why (or the why without the requeue)
 * would strand the next agent/human without context.
 * With the delivery repair budget spent there is no bounce: the returned task is still
 * `delivering` and its failure is `repair_exhausted` (posted once, until Restart task).
 */
export function failDelivery(
  db: DB,
  key: string,
  input: { reason: DeliveryFailureReason; detail: string; body?: string | undefined; expectedStateChangedAt?: string | undefined },
  now: () => string = nowIso,
): TaskDetail {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (row.status !== 'delivering') throw new InvalidTransitionError(`delivery failure requires delivering (got ${row.status})`);
    assertTransition(row.status, 'queued', 'agent');
    if (input.expectedStateChangedAt !== undefined && deliveryRowFor(db, row.id)?.state_changed_at !== input.expectedStateChangedAt)
      throw new InvalidTransitionError(`stale delivery observation for ${key}`);
    const ts = now();
    const repair = reserveRetryRow(db, row.id, key, { operation: 'delivery', maxAttempts: DEFAULT_DELIVERY_REPAIR_ATTEMPTS }, ts);
    if (!repair) {
      // Out of repairs: no bounce. The task stays in Delivering with one skip-listed
      // `repair_exhausted` note per budget generation (not per Task.failure, which a later
      // supervisor note can supersede), so the board and the notifier ask a human to Restart
      // task — which starts a new delivery budget generation and supersedes this note.
      if (!deliveryExhaustionReported(db, row.id)) {
        const max = budgetByTask(db, row.id, 'delivery')?.maxAttempts ?? DEFAULT_DELIVERY_REPAIR_ATTEMPTS;
        appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', createdAt: ts, body: buildFailureComment({
          reason: 'repair_exhausted', source: 'watcher', attempt: max, maxAttempts: max,
          detail: `delivery repair budget exhausted — ${input.detail}`,
          body: `${input.body ? `${input.body}\n\n` : ''}All ${max} automatic delivery repairs are spent, so the task stays in Delivering. A human must Restart task to allow another repair, or fix and merge the PR by hand.`,
        }) });
        touch(db, row.id, ts);
      }
      return toDetail(db, findRowByKey(db, key)!);
    }
    const comment = buildFailureComment({
      reason: input.reason, detail: input.detail, source: 'watcher', attempt: repair.attempt, maxAttempts: repair.maxAttempts,
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', body: comment, createdAt: ts });
    setStatus(db, row.id, 'queued', ts); // clears the claimant like every path into 'queued'
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: row.status, toStatus: 'queued', body: input.detail, createdAt: ts });
    settleRetryRow(db, repair.id, 'failed', ts, input.detail);
    // The repair is new work (merge main, fix CI), not a retry of the earlier implementation
    // rounds — without a fresh worker budget the dispatcher silently skips it. The delivery
    // budget above bounds how often this can happen; its final bounce is left for a human.
    if (repair.attempt < repair.maxAttempts) advanceRetryBudget(db, row.id, `dispatcher:${row.stage}`, ts, 'delivery repair');
    return toDetail(db, findRowByKey(db, key)!);
  });
}
