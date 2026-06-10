import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { findRowByKey } from '../src/repo/tasks.js';

/** Helper: create a task and promote it to queued status */
function seedQueued(db: ReturnType<typeof makeTestDb>, n: number): Array<{ key: string; id: number }> {
  const tasks: Array<{ key: string; id: number }> = [];
  for (let i = 0; i < n; i++) {
    const t = createTask(db, { title: `Task ${i + 1}`, spec: `Spec ${i + 1}`, acceptanceCriteria: `AC ${i + 1}` });
    db.prepare("UPDATE task SET status='queued' WHERE key=?").run(t.key);
    tasks.push({ key: t.key, id: t.id });
  }
  return tasks;
}

describe('claimNextTask', () => {
  it('FIFO: claims tasks in seq order (AF-1, AF-2, AF-3)', () => {
    const db = makeTestDb();
    const [t1, t2, t3] = seedQueued(db, 3);

    const r1 = claimNextTask(db);
    const r2 = claimNextTask(db);
    const r3 = claimNextTask(db);

    expect(r1?.key).toBe(t1.key);
    expect(r2?.key).toBe(t2.key);
    expect(r3?.key).toBe(t3.key);
  });

  it('claim effects: status becomes in_progress, updatedAt bumped, activity row written', () => {
    const db = makeTestDb();
    const [t] = seedQueued(db, 1);

    const fixedTs = '2030-01-01T12:00:00.000Z';
    const now = () => fixedTs;

    const detail = claimNextTask(db, undefined, now);

    expect(detail).not.toBeNull();
    expect(detail!.status).toBe('in_progress');
    expect(detail!.updatedAt).toBe(fixedTs);

    // Verify persisted status via DB read
    const row = findRowByKey(db, t.key)!;
    expect(row.status).toBe('in_progress');
    expect(row.updated_at).toBe(fixedTs);

    // Verify activity row
    const activityRows = db.prepare(
      "SELECT * FROM activity WHERE task_id = ? AND type = 'status_change' AND actor = 'agent'"
    ).all(t.id) as Array<{
      type: string; actor: string; from_status: string; to_status: string; created_at: string;
    }>;

    expect(activityRows).toHaveLength(1);
    expect(activityRows[0].from_status).toBe('queued');
    expect(activityRows[0].to_status).toBe('in_progress');
    expect(activityRows[0].created_at).toBe(fixedTs);
  });

  it('returns recent activity including prior feedback (feed-and-follow-up loop)', () => {
    const db = makeTestDb();
    const [t] = seedQueued(db, 1);

    // Raw-insert a feedback activity row to simulate prior human feedback
    const feedbackTs = '2029-12-31T10:00:00.000Z';
    db.prepare(
      "INSERT INTO activity(task_id,type,actor,from_status,to_status,body,created_at) VALUES (?, 'feedback','human',NULL,NULL,'please fix the bug', ?)"
    ).run(t.id, feedbackTs);

    const detail = claimNextTask(db);

    expect(detail).not.toBeNull();
    const feedbackEntry = detail!.activity.find(a => a.type === 'feedback');
    expect(feedbackEntry).toBeDefined();
    expect(feedbackEntry!.body).toBe('please fix the bug');
    expect(feedbackEntry!.actor).toBe('human');
  });

  it('empty queue: returns null and changes nothing when no queued tasks exist', () => {
    const db = makeTestDb();
    // Create a backlog task only — not queued
    createTask(db, { title: 'Backlog Task', spec: 'S', acceptanceCriteria: 'A' });

    const result = claimNextTask(db);

    expect(result).toBeNull();

    // The backlog task should be unchanged
    const row = db.prepare("SELECT status FROM task LIMIT 1").get() as { status: string };
    expect(row.status).toBe('backlog');
  });

  it('skips non-queued: claims AF-2 (queued), not AF-1 (backlog)', () => {
    const db = makeTestDb();
    // AF-1 stays in backlog
    const t1 = createTask(db, { title: 'Backlog', spec: 'S', acceptanceCriteria: 'A' });
    // AF-2 is promoted to queued
    const t2 = createTask(db, { title: 'Queued', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='queued' WHERE key=?").run(t2.key);

    const detail = claimNextTask(db);

    expect(detail).not.toBeNull();
    expect(detail!.key).toBe(t2.key);
    expect(detail!.key).not.toBe(t1.key);
  });

  it('sequential atomicity: claiming twice with one queued task returns task then null', () => {
    const db = makeTestDb();
    seedQueued(db, 1);

    const first = claimNextTask(db);
    const second = claimNextTask(db);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('claimed TaskDetail has correct activity in chronological order', () => {
    const db = makeTestDb();
    const [t] = seedQueued(db, 1);

    const fixedTs = '2030-06-01T00:00:00.000Z';
    const detail = claimNextTask(db, undefined, () => fixedTs);

    expect(detail).not.toBeNull();
    // Should contain at least: original status_change (backlog) from createTask, and new status_change (in_progress) from claim
    const types = detail!.activity.map(a => a.type);
    expect(types).toContain('status_change');

    // Last activity should be the claim's status_change
    const last = detail!.activity[detail!.activity.length - 1];
    expect(last.type).toBe('status_change');
    expect(last.actor).toBe('agent');
    expect(last.toStatus).toBe('in_progress');
    expect(last.createdAt).toBe(fixedTs);

    // Activity is in chronological order (ascending IDs)
    for (let i = 1; i < detail!.activity.length; i++) {
      expect(detail!.activity[i].id).toBeGreaterThan(detail!.activity[i - 1].id);
    }
  });

  it('returned TaskDetail includes links (empty array when no links)', () => {
    const db = makeTestDb();
    seedQueued(db, 1);

    const detail = claimNextTask(db);

    expect(detail).not.toBeNull();
    expect(detail!.links).toEqual([]);
  });
});
