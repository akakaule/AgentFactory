import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { releaseClaim } from '../src/ops/releaseClaim.js';
import { reportProgress } from '../src/ops/agentSession.js';
import { submitResult } from '../src/ops/submitResult.js';
import { addComment } from '../src/ops/addComment.js';
import { attachVisualization } from '../src/ops/visualization.js';
import { saveTranscript } from '../src/ops/transcript.js';
import { addTaskMetrics } from '../src/ops/addTaskMetrics.js';
import { addTaskDependency } from '../src/ops/taskDependencies.js';
import { beginDelivery, recordDeliveryCheck, failDelivery } from '../src/ops/delivery.js';
import { reserveExecution, reconcileExecutions, EXECUTION_LEASE_MS } from '../src/ops/execution.js';
import { settleRetry, getRetryBudget } from '../src/ops/retry.js';
import { InvalidTransitionError } from '../src/errors.js';

function queued(db: ReturnType<typeof makeTestDb>) {
  const task = createTask(db, { title: 'Execution ownership', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, task.key, 'queued', 'human');
  return task;
}

const BASE = Date.parse('2026-10-22T12:00:00.000Z');
const at = (ms: number) => () => new Date(BASE + ms).toISOString();

/** queue → claim → submit, leaving the task in_review with no live execution. */
function inReview(db: ReturnType<typeof makeTestDb>) {
  const task = queued(db);
  const claim = claimNextTask(db, { claimedBy: 'worker-1' }, at(-2000))!;
  submitResult(db, task.key, { summary: 'done', executionId: claim.executionId }, at(-1000));
  return task;
}

const executionCount = (db: ReturnType<typeof makeTestDb>, taskId: number) =>
  (db.prepare('SELECT COUNT(*) AS count FROM task_execution WHERE task_id = ?').get(taskId) as { count: number }).count;
const activityCount = (db: ReturnType<typeof makeTestDb>, taskId: number) =>
  (db.prepare('SELECT COUNT(*) AS count FROM activity WHERE task_id = ?').get(taskId) as { count: number }).count;
const failureNotes = (db: ReturnType<typeof makeTestDb>, taskId: number) =>
  (db.prepare("SELECT body FROM activity WHERE task_id = ? AND type = 'comment' AND body LIKE 'failure/v1%'").all(taskId) as Array<{ body: string }>).map((r) => r.body);

describe('execution ownership', () => {
  it('returns the same execution when a claim response is retried', () => {
    const db = makeTestDb();
    const task = queued(db);

    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    const retry = claimNextTask(db, { claimedBy: 'worker-1' });

    expect(first?.key).toBe(task.key);
    expect(first?.executionId).toBeTruthy();
    expect(retry?.executionId).toBe(first?.executionId);
  });

  it('rejects progress and submit from a released execution after a replacement claim', () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(first?.executionId).toBeTruthy();

    releaseClaim(db, task.key, undefined, first!.executionId);
    // the supervisor's recovery note rides the just-failed fence while it is still the latest
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'recovery note', executionId: first!.executionId })).not.toThrow();
    const replacement = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(replacement?.executionId).not.toBe(first?.executionId);

    expect(() => reportProgress(db, task.key, { message: 'late', executionId: first!.executionId })).toThrow(InvalidTransitionError);
    expect(() => submitResult(db, task.key, { summary: 'late', executionId: first!.executionId })).toThrow(InvalidTransitionError);
    // once a replacement holds the claim, even a comment from the old fence is historical output
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'late note', executionId: first!.executionId })).toThrow(InvalidTransitionError);
  });

  it("a human re-queue retires the earlier claim's fence: its late output is stale and the next claimant is not blocked", () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' })!;
    updateStatus(db, task.key, 'queued', 'human'); // the board's release of a stranded claim

    expect(() => reportProgress(db, task.key, { message: 'late', executionId: first.executionId })).toThrow(InvalidTransitionError);
    expect(claimNextTask(db, { claimedBy: 'worker-2' })?.key).toBe(task.key);
  });

  it("a merged delivery retires the repair worker's fence", () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' })!;
    submitResult(db, task.key, { summary: 'done', executionId: first.executionId });
    updateStatus(db, task.key, 'delivering', 'human');
    beginDelivery(db, task.key, { provider: 'github', branch: first.branch!, prUrl: 'https://github.com/acme/widgets/pull/1' });
    recordDeliveryCheck(db, task.key, { prState: 'open', checksState: 'failing', failing: [{ name: 'build', url: null }] });
    failDelivery(db, task.key, { reason: 'ci_failed', detail: 'build failed' });
    const repair = claimNextTask(db, { claimedBy: 'worker-2' })!;

    recordDeliveryCheck(db, task.key, { prState: 'merged', checksState: 'failing', failing: [{ name: 'build', url: null }] });
    expect(db.prepare('SELECT status FROM task WHERE id = ?').get(task.id)).toEqual({ status: 'done' });
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(repair.executionId)).toEqual({ state: 'cancelled' });
    expect(() => reportProgress(db, task.key, { message: 'late repair output', executionId: repair.executionId })).toThrow(InvalidTransitionError);
  });

  it('lets a claim-less agent comment once no execution is live, but never while one is', () => {
    const db = makeTestDb();
    const task = queued(db);
    const claim = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'unfenced while live' })).toThrow(InvalidTransitionError);

    submitResult(db, task.key, { summary: 'done', executionId: claim!.executionId });
    // e.g. an interactive /review-task session: it never claimed, so it has no fence to present
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'interactive review note' })).not.toThrow();
  });

  it('rejects unfenced mutations for a supervisor-owned execution', () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(first?.executionId).toBeTruthy();
    releaseClaim(db, task.key, undefined, first!.executionId);
    const claim = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(claim?.executionId).not.toBe(first?.executionId);

    expect(() => reportProgress(db, task.key, { message: 'late identity omitted' })).toThrow(InvalidTransitionError);
    expect(() => submitResult(db, task.key, { summary: 'late identity omitted' })).toThrow(InvalidTransitionError);
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'late identity omitted' })).toThrow(InvalidTransitionError);
    expect(() => attachVisualization(db, task.key, { html: '<p>late identity omitted</p>' })).toThrow(InvalidTransitionError);
  });

  it('requires an execution identity from the first supervisor-owned claim', () => {
    const db = makeTestDb();
    const task = queued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    expect(() => submitResult(db, task.key, { summary: 'unfenced' })).toThrow(InvalidTransitionError);
    expect(() => reportProgress(db, task.key, { message: 'unfenced' })).toThrow(InvalidTransitionError);
  });

  it('settles an identical submit retry without mutating the newer task state', () => {
    const db = makeTestDb();
    const task = queued(db);
    const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;

    const first = submitResult(db, task.key, { summary: 'submitted', executionId: claim.executionId });
    const activityBefore = activityCount(db, task.id);
    const retry = submitResult(db, task.key, { summary: 'submitted', executionId: claim.executionId });

    expect(first.status).toBe('in_review');
    expect(retry.status).toBe('in_review');
    expect(activityCount(db, task.id)).toBe(activityBefore);
    expect(db.prepare('SELECT COUNT(*) AS count FROM activity WHERE task_id = ? AND type = \'result\'').get(task.id)).toEqual({ count: 1 });
  });

  it('acknowledges an identical submit retry even after the reviewer reserved the submitted task', () => {
    const db = makeTestDb();
    const task = queued(db);
    const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
    submitResult(db, task.key, { summary: 'submitted', executionId: claim.executionId });
    // the lost response's retry lands after the reviewer's tick already reserved the review
    reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true });
    const activityBefore = activityCount(db, task.id);

    expect(submitResult(db, task.key, { summary: 'submitted', executionId: claim.executionId }).status).toBe('in_review');
    expect(activityCount(db, task.id)).toBe(activityBefore);
  });

  it('rejects a materially different retry from the execution that already submitted', () => {
    const db = makeTestDb();
    const task = queued(db);
    const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
    submitResult(db, task.key, { summary: 'submitted', executionId: claim.executionId });

    expect(() => submitResult(db, task.key, { summary: 'a different result', executionId: claim.executionId })).toThrow(InvalidTransitionError);
    expect(db.prepare('SELECT result_summary FROM task WHERE id = ?').get(task.id)).toEqual({ result_summary: 'submitted' });
  });

  it('rejects unfenced mutations while a claim made without a claimedBy label is live', () => {
    const db = makeTestDb();
    const task = queued(db);
    const claim = claimNextTask(db, {})!; // an anonymous claim: no worker label, no owner
    expect(claim.executionId).toBeTruthy();

    expect(() => reportProgress(db, task.key, { message: 'unfenced' })).toThrow(InvalidTransitionError);
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'unfenced' })).toThrow(InvalidTransitionError);
    expect(() => submitResult(db, task.key, { summary: 'unfenced' })).toThrow(InvalidTransitionError);
    expect(db.prepare('SELECT status FROM task WHERE id = ?').get(task.id)).toEqual({ status: 'in_progress' });
    // the claimant itself, presenting its fence, still works
    expect(() => submitResult(db, task.key, { summary: 'fenced', executionId: claim.executionId })).not.toThrow();
  });

  it("keeps the worker's final transcript and metrics after the reviewer reserves the in-review task", () => {
    const db = makeTestDb();
    const task = queued(db);
    const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
    submitResult(db, task.key, { summary: 'done', executionId: claim.executionId });
    reserveExecution(db, task.key, { operation: 'visualization:x', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true });

    // the dispatcher's reap runs after the worker exits — the reviewer's reservation is newer
    expect(() => saveTranscript(db, task.key, { raw: '{"type":"result"}\n', executionId: claim.executionId })).not.toThrow();
    expect(() => addTaskMetrics(db, task.key, { tokensIn: 10, tokensOut: 2, reportedBy: 'worker-1', executionId: claim.executionId })).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM task_metric WHERE task_id = ?').get(task.id)).toEqual({ count: 1 });
  });

  it("keeps a released run's final transcript and usage while no newer worker execution exists", () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' })!;
    updateStatus(db, task.key, 'queued', 'human'); // a human released the stranded claim

    // the dispatcher's reap persists what the released session did before it was let go
    expect(() => saveTranscript(db, task.key, { raw: '{"type":"result"}\n', executionId: first.executionId })).not.toThrow();
    expect(() => addTaskMetrics(db, task.key, { tokensIn: 5, reportedBy: 'worker-1', executionId: first.executionId })).not.toThrow();
    // ...but it is no longer a lifecycle owner
    expect(() => reportProgress(db, task.key, { message: 'late', executionId: first.executionId })).toThrow(InvalidTransitionError);
  });

  it("rejects a settled worker's late transcript once a newer worker execution exists", () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' })!;
    releaseClaim(db, task.key, undefined, first.executionId);
    claimNextTask(db, { claimedBy: 'worker-2' });

    expect(() => saveTranscript(db, task.key, { raw: '{"type":"result"}\n', executionId: first.executionId })).toThrow(InvalidTransitionError);
  });

  it('does not resurrect an older active execution after a newer execution settles', () => {
    const db = makeTestDb();
    const task = inReview(db);
    const older = reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true }, at(0))!;
    // reviewer-1 crashed: its heartbeat outlives the lease, so a second reviewer takes over
    const newer = reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-2', startImmediately: true }, at(EXECUTION_LEASE_MS + 1))!;
    expect(newer.id).not.toBe(older.id);
    expect(settleRetry(db, newer.id, { state: 'succeeded' })).toBe(true);

    expect(() => addComment(db, task.key, { actor: 'agent', body: 'old reviewer output', executionId: older.id })).toThrow(InvalidTransitionError);
  });

  it('reconciles a running reservation left queued by a supervisor crash', () => {
    const db = makeTestDb();
    const task = queued(db);
    const execution = reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1', startImmediately: true })!;
    db.prepare("UPDATE task_execution SET reserved_at = '2020-01-01T00:00:00.000Z', heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(execution.id);

    expect(reconcileExecutions(db, 30_000, () => '2020-01-01T00:01:00.000Z')).toBe(1);
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(execution.id)).toEqual({ state: 'cancelled' });
  });

  it('records exactly one failure/v1 note per abandoned execution, before spawn and once running', () => {
    const db = makeTestDb();
    const reserved = queued(db);
    const running = queued(db);
    // (a) the supervisor died right after reserving; (b) it had already marked the execution running
    const a = reserveExecution(db, reserved.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: `default#${reserved.key}` }, at(0))!;
    const b = reserveExecution(db, running.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: `default#${running.key}`, startImmediately: true }, at(0))!;

    expect(reconcileExecutions(db, 30_000, at(60_000))).toBe(2);
    expect(reconcileExecutions(db, 30_000, at(120_000))).toBe(0); // a repeated restart adds nothing

    for (const [task, execution] of [[reserved, a], [running, b]] as const) {
      const notes = failureNotes(db, task.id);
      expect(notes).toHaveLength(1);
      expect(notes[0]).toContain(execution.id);
      expect(notes[0]).toContain('"source":"dispatcher"');
      expect(db.prepare('SELECT status FROM task WHERE id = ?').get(task.id)).toEqual({ status: 'queued' });
    }
    // the abandoned attempt was never spawned/claimed, so it is refunded rather than counted
    expect(getRetryBudget(db, reserved.key, 'dispatcher:implementation')).toMatchObject({ attemptsUsed: 0 });
  });

  it('cancels a stale earlier-phase execution on a queued task without a failure note', () => {
    const db = makeTestDb();
    const task = inReview(db);
    const review = reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true }, at(0))!;
    updateStatus(db, task.key, 'queued', 'human', at(1000)); // a human sent it back mid-review

    reconcileExecutions(db, 30_000, at(60_000));
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(review.id)).toEqual({ state: 'cancelled' });
    expect(failureNotes(db, task.id)).toHaveLength(0);
  });

  it('keeps a live pre-claim execution when its heartbeat is fresh', () => {
    const db = makeTestDb();
    const task = queued(db);
    const execution = reserveExecution(db, task.key, {
      operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1', startImmediately: true,
    })!;
    db.prepare("UPDATE task_execution SET reserved_at = '2020-01-01T00:00:00.000Z', heartbeat_at = '2026-09-15T00:00:00.000Z' WHERE id = ?").run(execution.id);

    expect(reconcileExecutions(db, 30_000, () => '2026-09-15T00:00:10.000Z')).toBe(0);
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(execution.id)).toEqual({ state: 'running' });
  });
});

describe('execution reservation', () => {
  it('two supervisors reserving the same queued task produce exactly one execution and one claim', () => {
    const db = makeTestDb();
    const task = queued(db);
    const winner = reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1', startImmediately: true });
    expect(winner).not.toBeNull();

    // budget remains for a second attempt, yet the live reservation already owns the task
    expect(() => reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1', startImmediately: true }))
      .toThrow(InvalidTransitionError);
    expect(executionCount(db, task.id)).toBe(1);
    expect(getRetryBudget(db, task.key, 'dispatcher:implementation')).toMatchObject({ attemptsUsed: 1 });

    const claim = claimNextTask(db, { claimedBy: 'default#AF-1-a1', executionId: winner!.id });
    expect(claim?.executionId).toBe(winner!.id);
    expect(claimNextTask(db, { claimedBy: 'default#AF-1-a2' })).toBeNull();
    expect(executionCount(db, task.id)).toBe(1);
  });

  it('refuses a reservation for a task its operation cannot act on, without consuming budget', () => {
    const db = makeTestDb();
    const task = queued(db);
    expect(() => reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1' }))
      .toThrow(InvalidTransitionError);

    const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
    expect(() => reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1' }))
      .toThrow(InvalidTransitionError);
    submitResult(db, task.key, { summary: 'done', executionId: claim.executionId });
    expect(() => reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1' }))
      .toThrow(InvalidTransitionError);

    expect(getRetryBudget(db, task.key, 'dispatcher:implementation')).toBeNull();
    expect(getRetryBudget(db, task.key, 'reviewer:implementation')).toBeNull();
    expect(executionCount(db, task.id)).toBe(1); // only the claim's own execution
  });

  it("an interactive claim does not take a task another supervisor's live execution reserved", () => {
    const db = makeTestDb();
    const task = queued(db);
    const reservation = reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: `default#${task.key}`, startImmediately: true })!;

    expect(claimNextTask(db, { claimedBy: 'interactive' })).toBeNull();
    expect(() => claimNextTask(db, { claimedBy: 'interactive', taskKey: task.key })).toThrow(InvalidTransitionError);
    expect(claimNextTask(db, {})).toBeNull();
    expect(executionCount(db, task.id)).toBe(1);

    // the reservation's own worker still claims it, with the reserved fence
    expect(claimNextTask(db, { claimedBy: `default#${task.key}-a1`, executionId: reservation.id })?.executionId).toBe(reservation.id);
  });

  it('an interactive claim skips a reserved task and takes the next eligible one', () => {
    const db = makeTestDb();
    const reserved = queued(db);
    const free = queued(db);
    reserveExecution(db, reserved.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: `default#${reserved.key}`, startImmediately: true });

    expect(claimNextTask(db, { claimedBy: 'interactive' })?.key).toBe(free.key);
  });

  it('a reservation past its lease no longer blocks an interactive claim, which supersedes it', () => {
    const db = makeTestDb();
    const task = queued(db);
    const stale = reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: `default#${task.key}`, startImmediately: true }, at(0))!;

    const claim = claimNextTask(db, { claimedBy: 'interactive' }, at(EXECUTION_LEASE_MS + 1))!;
    expect(claim.key).toBe(task.key);
    expect(claim.executionId).not.toBe(stale.id);
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(stale.id)).toEqual({ state: 'failed' });
    // like a superseding reservation, the crashed owner's attempt is settled and stays counted
    expect(db.prepare('SELECT state FROM retry_attempt WHERE id = ?').get(stale.id)).toEqual({ state: 'failed' });
    expect(getRetryBudget(db, task.key, 'dispatcher:implementation')).toMatchObject({ attemptsUsed: 1 });
  });

  it('refuses to reserve, or to claim through a reservation, a task that is not claim-eligible', () => {
    const db = makeTestDb();
    const prerequisite = createTask(db, { title: 'Prerequisite', spec: 'S', acceptanceCriteria: 'A' });
    const blocked = queued(db);
    addTaskDependency(db, blocked.key, prerequisite.key);
    expect(() => reserveExecution(db, blocked.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: `default#${blocked.key}` }))
      .toThrow(InvalidTransitionError);
    expect(getRetryBudget(db, blocked.key, 'dispatcher:implementation')).toBeNull();

    // a dependency added between the reservation and the claim is honoured at claim time
    const later = queued(db);
    const reservation = reserveExecution(db, later.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: `default#${later.key}`, startImmediately: true })!;
    addTaskDependency(db, later.key, prerequisite.key);
    expect(() => claimNextTask(db, { claimedBy: `default#${later.key}-a1`, executionId: reservation.id })).toThrow(InvalidTransitionError);
    expect(db.prepare('SELECT status FROM task WHERE id = ?').get(later.id)).toEqual({ status: 'queued' });
  });

  it('a reviewer reservation is not blocked by the settled worker execution that preceded it', () => {
    const db = makeTestDb();
    const task = inReview(db);
    expect(reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true })).not.toBeNull();
  });

  it('a live owner within its lease blocks a second reviewer; past the lease it is superseded', () => {
    const db = makeTestDb();
    const task = inReview(db);
    const first = reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 3, owner: 'reviewer-1', startImmediately: true }, at(0))!;

    expect(() => reserveExecution(db, task.key, { operation: 'visualization:x', maxAttempts: 3, owner: 'reviewer-2', startImmediately: true }, at(EXECUTION_LEASE_MS - 1)))
      .toThrow(InvalidTransitionError);

    const second = reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 3, owner: 'reviewer-2', startImmediately: true }, at(EXECUTION_LEASE_MS + 1))!;
    expect(second.id).not.toBe(first.id);
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(first.id)).toEqual({ state: 'failed' });
    expect(getRetryBudget(db, task.key, 'reviewer:implementation')).toMatchObject({ attemptsUsed: 2 }); // the crashed attempt still counts
  });
});
