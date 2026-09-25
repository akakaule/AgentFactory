import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { addComment } from '../src/ops/addComment.js';
import { restartTask } from '../src/ops/restartTask.js';
import { getTask } from '../src/ops/getTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { getVersion } from '../src/version.js';
import { buildFailureComment } from '../src/failure.js';
import { buildFailureTriageFeedbackComment } from '../src/failureTriage.js';
import { recordFailureTriageFeedback, failureTriageHistory, getFailureTriageSource } from '../src/ops/failureTriage.js';
import { InvalidTransitionError, NotFoundError, ValidationError } from '../src/errors.js';

type DB = ReturnType<typeof makeTestDb>;
const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (min: number) => () => new Date(BASE + min * 60000).toISOString();

const LOG_401 = 'error NU1301: Unable to load the service index for source https://x/index.json. Response status code does not indicate success: 401 (Unauthorized).';
const LOG_TS = "src/a.ts(3,20): error TS2322: Type 'string' is not assignable to type 'number'.";

/** Shaped like the dispatcher's releaseAndRetry note. */
const crash = (tail: string, attempt = 1, maxAttempts = 3, source = 'dispatcher') => buildFailureComment({
  reason: 'crashed', source, attempt, maxAttempts, detail: 'session `worker-1` exited with code 1 with the task still in progress',
  body: `Releasing the claim for retry.\n\nLog tail:\n\`\`\`\n${tail}\n\`\`\``,
});
/** Shaped like the dispatcher's skip-list note: no log. */
const maxAttempts = (attempt = 3) => buildFailureComment({
  reason: 'max_attempts', source: 'dispatcher', attempt, maxAttempts: attempt,
  detail: `reached maxAttempts (${attempt}) and is skip-listed`, body: 'No further sessions will be spawned until a human intervenes.',
});

function inProgress(db: DB, title = 'T') {
  const task = createTask(db, { title, spec: 'S', acceptanceCriteria: 'A' }, at(0));
  updateStatus(db, task.key, 'queued', 'human', at(1));
  claimNextTask(db, { claimedBy: 'worker-1' }, at(2));
  return task;
}
const note = (db: DB, key: string, body: string, min: number) => addComment(db, key, { actor: 'agent', body }, at(min)).id;
const triage = (db: DB, key: string) => getTask(db, key).failureTriage;

describe('failure triage projection', () => {
  it('labels a crash from its own log and matches the list projection', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    const id = note(db, task.key, crash(LOG_401), 10);
    expect(triage(db, task.key)).toMatchObject({
      sourceActivityId: id, evidenceActivityId: id, classifier: 'rules', category: 'access', label: 'Access or credentials',
      rules: { ruleId: 'access/http-401-403', alsoMatched: [] }, human: null,
    });
    expect(listTasks(db).find((t) => t.key === task.key)!.failureTriage).toEqual(triage(db, task.key));
  });

  it('a skip-listed task reads the final attempt\'s log, not the log-less max_attempts note', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    note(db, task.key, crash(LOG_TS, 2), 10);
    const final = note(db, task.key, crash(LOG_401, 3), 20);
    const skip = note(db, task.key, maxAttempts(), 21);
    expect(getTask(db, task.key).failure).toMatchObject({ reason: 'max_attempts', skipListed: true });
    expect(triage(db, task.key)).toMatchObject({ sourceActivityId: skip, evidenceActivityId: final, category: 'access' });
  });

  it('max_attempts gets no evidence without a valid same-episode, same-source predecessor', () => {
    const lone = makeTestDb();
    const a = inProgress(lone);
    note(lone, a.key, maxAttempts(), 10);
    expect(triage(lone, a.key)).toMatchObject({ evidenceActivityId: null, category: 'unknown', rules: { ruleId: null } });

    const otherSource = makeTestDb();
    const b = inProgress(otherSource);
    note(otherSource, b.key, crash(LOG_401, 3, 3, 'reviewer'), 10);
    note(otherSource, b.key, maxAttempts(), 11);
    expect(triage(otherSource, b.key)).toMatchObject({ evidenceActivityId: null, category: 'unknown' });

    const malformed = makeTestDb();
    const c = inProgress(malformed);
    note(malformed, c.key, 'failure/v1 broken\n{ not json', 10);
    note(malformed, c.key, maxAttempts(), 11);
    expect(triage(malformed, c.key)).toMatchObject({ evidenceActivityId: null, category: 'unknown' });

    const restarted = makeTestDb();
    const d = inProgress(restarted);
    note(restarted, d.key, crash(LOG_401, 3), 10);
    updateStatus(restarted, d.key, 'queued', 'human', at(10)); // the dispatcher's release
    restartTask(restarted, d.key, null, at(11));
    note(restarted, d.key, maxAttempts(), 12);
    expect(triage(restarted, d.key)).toMatchObject({ evidenceActivityId: null, category: 'unknown' });
  });

  it('no other note borrows an earlier log', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    note(db, task.key, crash(LOG_401, 1), 10);
    const stale = note(db, task.key, buildFailureComment({ reason: 'stale', source: 'dispatcher', detail: 'claim by `worker-1` looks abandoned — no heartbeat for 130m (staleClaimMinutes 120)', attempt: 2, maxAttempts: 3 }), 20);
    expect(triage(db, task.key)).toMatchObject({ sourceActivityId: stale, evidenceActivityId: stale, category: 'unknown' });
  });

  it('a reviewer\'s final review_failed note is its own evidence', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    const id = note(db, task.key, buildFailureComment({ reason: 'review_failed', source: 'reviewer', detail: 'codex exited with code 1: stream error: 529 overloaded_error', attempt: 3, maxAttempts: 3, body: 'The automated reviewer is skip-listing this task — review it manually.' }), 10);
    expect(triage(db, task.key)).toMatchObject({ sourceActivityId: id, evidenceActivityId: id, category: 'infrastructure' });
  });

  it('is null without a current failure, and for done or archived tasks', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    expect(triage(db, task.key)).toBeNull();
    note(db, task.key, crash(LOG_401), 10);
    db.prepare("UPDATE task SET status = 'done' WHERE key = ?").run(task.key);
    expect(triage(db, task.key)).toBeNull();
    expect(getTask(db, task.key).failure).not.toBeNull(); // original failure presentation unchanged
    db.prepare("UPDATE task SET status = 'queued', archived_at = ? WHERE key = ?").run(at(20)(), task.key);
    expect(triage(db, task.key)).toBeNull();
  });

  it('list reads stay batched — query count does not grow with failing tasks', () => {
    const db = makeTestDb();
    const count = (n: number) => {
      for (let i = 0; i < n; i++) {
        const t = inProgress(db, `T${i}`);
        note(db, t.key, crash(LOG_401), 10);
        db.prepare("UPDATE task SET status = 'queued', claimed_by = NULL WHERE key = ?").run(t.key);
      }
      const original = db.prepare.bind(db);
      let prepared = 0;
      (db as { prepare: typeof db.prepare }).prepare = ((sql: string) => { prepared++; return original(sql); }) as typeof db.prepare;
      listTasks(db);
      (db as { prepare: typeof db.prepare }).prepare = original;
      return prepared;
    };
    const few = count(2);
    const many = count(6);
    expect(many).toBe(few);
  });
});

describe('failure triage feedback', () => {
  function failing() {
    const db = makeTestDb();
    const task = inProgress(db);
    const source = note(db, task.key, crash(LOG_TS), 10);
    return { db, key: task.key, source };
  }

  it('confirm and correct label the event; latest wins; the rule result is preserved', () => {
    const { db, key, source } = failing();
    recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'confirm', shownCategory: 'build_test', actorUserId: null }, at(20));
    expect(triage(db, key)).toMatchObject({ classifier: 'human', category: 'build_test', human: { action: 'confirm', shownCategory: 'build_test', classifier: 'rules' } });
    const detail = recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'correct', category: 'configuration', shownCategory: 'build_test', note: '  missing SDK  ' }, at(21));
    expect(detail.failureTriage).toMatchObject({
      classifier: 'human', category: 'configuration', label: 'Setup or configuration',
      rules: { category: 'build_test' }, human: { action: 'correct', category: 'configuration', shownCategory: 'build_test', classifier: 'human', note: 'missing SDK' },
    });
  });

  it('never carries forward to a newer failure', () => {
    const { db, key, source } = failing();
    recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'correct', category: 'access', shownCategory: 'build_test' }, at(20));
    const next = note(db, key, crash(LOG_TS, 2), 30);
    expect(triage(db, key)).toMatchObject({ sourceActivityId: next, classifier: 'rules', category: 'build_test', human: null });
    // the old event can still be annotated, and it still does not label the new one
    recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'correct', category: 'infrastructure', shownCategory: 'access' }, at(31));
    expect(triage(db, key)).toMatchObject({ sourceActivityId: next, human: null });
  });

  it('rejects a stale label, a correction without a category, an oversized note, and foreign sources', () => {
    const { db, key, source } = failing();
    expect(() => recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'confirm', shownCategory: 'access' })).toThrow(InvalidTransitionError);
    expect(() => recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'correct', shownCategory: 'build_test' })).toThrow(ValidationError);
    expect(() => recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'confirm', shownCategory: 'build_test', note: 'x'.repeat(501) })).toThrow(ValidationError);
    const other = inProgress(db, 'other');
    const foreign = note(db, other.key, crash(LOG_401), 40);
    expect(() => recordFailureTriageFeedback(db, key, { sourceActivityId: foreign, action: 'confirm', shownCategory: 'access' })).toThrow(NotFoundError);
    const plain = addComment(db, key, { actor: 'human', body: 'just a comment' }, at(41)).id;
    expect(() => recordFailureTriageFeedback(db, key, { sourceActivityId: plain, action: 'confirm', shownCategory: 'unknown' })).toThrow(NotFoundError);
  });

  it('moves the version signal without touching the task, and stays out of recent activity', () => {
    const { db, key, source } = failing();
    const before = getTask(db, key);
    const version = getVersion(db);
    recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'confirm', shownCategory: 'build_test' }, at(500));
    const after = getTask(db, key);
    expect(getVersion(db)).not.toBe(version);
    expect(after.updatedAt).toBe(before.updatedAt);
    expect(after.status).toBe(before.status);
    expect(after.activity.some((a) => a.body.startsWith('failure-triage'))).toBe(false);
  });

  it('reserves the triage prefixes on generic comments for humans and agents', () => {
    const { db, key, source } = failing();
    const forged = buildFailureTriageFeedbackComment({ sourceActivityId: source, action: 'correct', category: 'access', shownCategory: 'build_test', classifier: 'rules', rulesVersion: 'x', note: null });
    expect(() => addComment(db, key, { actor: 'agent', body: forged })).toThrow(InvalidTransitionError);
    expect(() => addComment(db, key, { actor: 'human', body: 'failure-triage/v1 anything' })).toThrow(InvalidTransitionError);
  });

  it('internal markers never displace human comments from recent activity', () => {
    const { db, key, source } = failing();
    addComment(db, key, { actor: 'human', body: 'keep me' }, at(15));
    for (let i = 0; i < 60; i++) {
      const shown = triage(db, key)!.category;
      recordFailureTriageFeedback(db, key, { sourceActivityId: source, action: 'correct', category: i % 2 ? 'access' : 'build_test', shownCategory: shown }, at(100 + i));
    }
    expect(getTask(db, key).activity.some((a) => a.body === 'keep me')).toBe(true);
  });
});

describe('failure triage history and source', () => {
  it('paginates every failure event, beyond the recent-activity window, with bound feedback', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    const ids: number[] = [];
    for (let i = 0; i < 5; i++) ids.push(note(db, task.key, crash(i % 2 ? LOG_401 : LOG_TS, i + 1, 9), 10 + i));
    for (let i = 0; i < 60; i++) addComment(db, task.key, { actor: 'human', body: `chatter ${i}` }, at(100 + i));
    recordFailureTriageFeedback(db, task.key, { sourceActivityId: ids[1]!, action: 'confirm', shownCategory: 'access' }, at(200));

    const first = failureTriageHistory(db, task.key, { limit: 2 });
    expect(first.items.map((i) => i.sourceActivityId)).toEqual([ids[4], ids[3]]);
    expect(first.nextBeforeId).toBe(ids[3]);
    const second = failureTriageHistory(db, task.key, { limit: 2, beforeId: first.nextBeforeId! });
    expect(second.items.map((i) => i.sourceActivityId)).toEqual([ids[2], ids[1]]);
    expect(second.items[1]).toMatchObject({ reason: 'crashed', rules: { category: 'access' }, feedback: [{ action: 'confirm', category: 'access' }] });
    const last = failureTriageHistory(db, task.key, { limit: 2, beforeId: second.nextBeforeId! });
    expect(last.items.map((i) => i.sourceActivityId)).toEqual([ids[0]]);
    expect(last.nextBeforeId).toBeNull();
  });

  it('agrees with the projection on the current event, including the max_attempts evidence rule', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    const final = note(db, task.key, crash(LOG_401, 3), 10);
    note(db, task.key, maxAttempts(), 11);
    const [current] = failureTriageHistory(db, task.key).items;
    expect(current).toMatchObject({ reason: 'max_attempts', evidenceActivityId: final });
    expect(current!.rules).toEqual(triage(db, task.key)!.rules);
  });

  it('reads the exact source note past the activity window and rejects anything else', () => {
    const db = makeTestDb();
    const task = inProgress(db);
    const id = note(db, task.key, crash(LOG_401), 10);
    for (let i = 0; i < 60; i++) addComment(db, task.key, { actor: 'human', body: `chatter ${i}` }, at(100 + i));
    expect(getFailureTriageSource(db, task.key, id)).toMatchObject({ id, type: 'comment' });
    expect(getFailureTriageSource(db, task.key, id).body).toContain('401 (Unauthorized)');
    const plain = addComment(db, task.key, { actor: 'human', body: 'hello' }, at(300)).id;
    expect(() => getFailureTriageSource(db, task.key, plain)).toThrow(NotFoundError);
    const other = inProgress(db, 'other');
    expect(() => getFailureTriageSource(db, other.key, id)).toThrow(NotFoundError);
    expect(() => failureTriageHistory(db, 'AF-999')).toThrow(NotFoundError);
  });
});
