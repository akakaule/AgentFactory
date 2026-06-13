import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import type { DB } from '../src/db.js';
import { createTask } from '../src/ops/createTask.js';
import { addComment } from '../src/ops/addComment.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import type { Stage } from '../src/types.js';

const FIXED_TS = '2030-10-01T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

const review = (findings: unknown[]) =>
  `ai-review/v1 — ${findings.length} findings (claude)\nLooks fine.\n\`\`\`json\n${JSON.stringify({ reviewer: 'claude', verdict: findings.length ? 'findings' : 'clean', findings })}\n\`\`\``;
const CLEAN = review([]);
const FINDINGS = review([{ severity: 'error', file: 'x.ts', line: 1, title: 'bug', detail: 'broken' }]);

function seedInReview(db: DB, stage: Stage, claimedBy = 'worker-1') {
  const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage });
  db.prepare("UPDATE task SET status='in_review', claimed_by=?, claimed_at=? WHERE key=?").run(claimedBy, FIXED_TS, task.key);
  return task;
}

describe('addComment — auto-approve clean doc-stage reviews', () => {
  it('a clean review on an in-review description stage advances to plan and re-queues, clearing the claimant', () => {
    const db = makeTestDb();
    const task = seedInReview(db, 'description');

    const activity = addComment(db, task.key, { actor: 'human', body: CLEAN }, fixedNow);

    // the returned activity is still the comment itself, not the advance
    expect(activity.type).toBe('comment');
    expect(activity.body).toBe(CLEAN);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('queued');
    expect(row.stage).toBe('plan');
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();

    const advance = recentActivity(db, task.id, 10).find((a) => a.type === 'status_change' && a.toStatus === 'queued');
    expect(advance).toBeDefined();
    expect(advance!.actor).toBe('agent');
    expect(advance!.fromStatus).toBe('in_review');
    expect(advance!.body).toContain('auto-approved: clean AI review');
    expect(advance!.body).toContain('description → plan');
  });

  it('a clean review on an in-review plan stage advances to implementation', () => {
    const db = makeTestDb();
    const task = seedInReview(db, 'plan');

    addComment(db, task.key, { actor: 'agent', body: CLEAN }, fixedNow); // MCP path posts as agent

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('queued');
    expect(row.stage).toBe('implementation');
  });

  it('a review with findings does NOT advance — it escalates to the human', () => {
    const db = makeTestDb();
    const task = seedInReview(db, 'description');

    addComment(db, task.key, { actor: 'human', body: FINDINGS }, fixedNow);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_review');
    expect(row.stage).toBe('description');
    expect(row.claimed_by).toBe('worker-1');
  });

  it('a malformed marker comment does NOT advance', () => {
    const db = makeTestDb();
    const task = seedInReview(db, 'description');

    addComment(db, task.key, { actor: 'human', body: 'ai-review/v1 — oops, no json here' }, fixedNow);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_review');
    expect(row.stage).toBe('description');
  });

  it('a clean review on the implementation stage does NOT advance — that gate is human-only', () => {
    const db = makeTestDb();
    const task = seedInReview(db, 'implementation');

    addComment(db, task.key, { actor: 'human', body: CLEAN }, fixedNow);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_review');
    expect(row.stage).toBe('implementation');
  });

  it('a clean review on a task that is not in_review does NOT advance', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'description' });
    db.prepare("UPDATE task SET status='queued' WHERE key=?").run(task.key);

    addComment(db, task.key, { actor: 'human', body: CLEAN }, fixedNow);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('queued');
    expect(row.stage).toBe('description');
  });

  it('a plain comment on an in-review doc stage writes exactly one activity row and changes nothing else', () => {
    const db = makeTestDb();
    const task = seedInReview(db, 'description');
    const before = recentActivity(db, task.id, 100).length;

    addComment(db, task.key, { actor: 'human', body: 'just a note' }, fixedNow);

    expect(recentActivity(db, task.id, 100).length).toBe(before + 1);
    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_review');
    expect(row.stage).toBe('description');
  });
});
