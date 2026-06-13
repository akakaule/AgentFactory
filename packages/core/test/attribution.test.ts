import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { addComment } from '../src/ops/addComment.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { recentActivity } from '../src/repo/activity.js';
import type { DB } from '../src/db.js';

const FIXED_TS = '2030-09-01T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

function seedUser(db: DB, email: string, name: string): number {
  db.prepare('INSERT INTO app_user(email, display_name, is_system, created_at) VALUES (?, ?, 0, ?)').run(email, name, FIXED_TS);
  return Number((db.prepare('SELECT id FROM app_user WHERE email = ?').get(email) as { id: number }).id);
}

describe('attribution (actor_user_id)', () => {
  it('records actor_user_id and joins actorName on a human approve (implementation → done)', () => {
    const db = makeTestDb();
    const userId = seedUser(db, 'alvin@example.com', 'Alvin');
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    const detail = reviewApprove(db, task.key, fixedNow, userId);

    const act = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'done')!;
    expect(act.actor).toBe('human'); // machine axis unchanged
    expect(act.actorUserId).toBe(userId);
    expect(act.actorName).toBe('Alvin');
  });

  it('leaves actor_user_id and actorName null for an agent comment', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const a = addComment(db, task.key, { actor: 'agent', body: 'done' }, fixedNow);

    expect(a.actor).toBe('agent');
    expect(a.actorUserId).toBeNull();
    expect(a.actorName).toBeNull();
  });

  it('carries actorUserId through a human comment to the returned activity', () => {
    const db = makeTestDb();
    const userId = seedUser(db, 'rev@example.com', 'Rev');
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const a = addComment(db, task.key, { actor: 'human', body: 'lgtm', actorUserId: userId }, fixedNow);

    expect(a.actorUserId).toBe(userId);
    expect(a.actorName).toBe('Rev');
  });

  it('attributes a human status move and a request-changes feedback to the user', () => {
    const db = makeTestDb();
    const userId = seedUser(db, 'pm@example.com', 'PM');
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    updateStatus(db, task.key, 'queued', 'human', fixedNow, userId);
    const queued = recentActivity(db, task.id, 50).find(a => a.type === 'status_change' && a.toStatus === 'queued')!;
    expect(queued.actorUserId).toBe(userId);
    expect(queued.actorName).toBe('PM');

    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);
    reviewRequestChanges(db, task.key, { feedback: 'please fix', actorUserId: userId }, fixedNow);
    const fb = recentActivity(db, task.id, 50).find(a => a.type === 'feedback')!;
    expect(fb.actorUserId).toBe(userId);
    expect(fb.actorName).toBe('PM');
  });

  it('auto-approve (clean AI review on a doc stage) stays unattributed (agent action)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);
    const clean = 'ai-review/v1 — clean (claude)\n```json\n' + JSON.stringify({ reviewer: 'claude', verdict: 'clean', findings: [] }) + '\n```';

    addComment(db, task.key, { actor: 'agent', body: clean }, fixedNow);

    const advance = recentActivity(db, task.id, 50).find(a => a.type === 'status_change' && a.toStatus === 'queued')!;
    expect(advance.actor).toBe('agent');
    expect(advance.actorUserId).toBeNull();
  });
});
