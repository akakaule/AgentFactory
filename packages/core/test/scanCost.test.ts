import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { POST_MERGE_CHECK_PUBLICATION_MS } from '../src/ops/delivery.js';
import type { DB } from '../src/db.js';
import { latestAiReviewComments, latestFailureComments, latestFailureNotePairs } from '../src/repo/activity.js';

// getVersion() runs once per second per open board tab. Each MAX() must be answered from an index
// led by that column (SQLite's min/max shortcut): without one it reads the whole table — measured at
// ~90 ms per call with 300k task_metric rows, against ~0.2 ms with the indexes.
describe('getVersion query plan', () => {
  it('answers each growing MAX() from an index led by its column', () => {
    const db = makeTestDb();
    const src = readFileSync(new URL('../src/version.ts', import.meta.url), 'utf8');
    const sql = (/db\.prepare\(\s*`([\s\S]*?)`/.exec(src) ?? [])[1]!;
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>).map((r) => r.detail).join('\n');
    for (const index of ['idx_task_updated', 'idx_activity_created', 'idx_metric_created', 'idx_attention_first_seen', 'idx_attention_resolved', 'idx_outbox_updated'])
      expect(plan).toContain(index);
  });
});

describe('listTasks({ delivery: true })', () => {
  const HOUR = 60 * 60_000;
  function seed(db: DB, title: string, status: string, delivery?: { pr: string; checks: string; changedMsAgo: number }) {
    const t = createTask(db, { title, spec: 'S', acceptanceCriteria: 'A' });
    db.prepare('UPDATE task SET status = ? WHERE key = ?').run(status, t.key);
    if (delivery) {
      const at = new Date(Date.now() - delivery.changedMsAgo).toISOString();
      db.prepare(`INSERT INTO task_delivery (task_id, provider, branch, pr_state, checks_state, state_changed_at, created_at, updated_at)
                  VALUES (?, 'github', 'b', ?, ?, ?, ?, ?)`).run(t.id, delivery.pr, delivery.checks, at, at, at);
    }
    return t.key;
  }

  it('returns only what the watcher can act on: a superset of its own filter', () => {
    const db = makeTestDb();
    const keep = [
      seed(db, 'delivering, no row yet', 'delivering'),
      seed(db, 'bounced back to the queue', 'queued', { pr: 'open', checks: 'failing', changedMsAgo: 5 * HOUR }),
      seed(db, 'merged, checks pending', 'done', { pr: 'merged', checks: 'pending', changedMsAgo: 50 * HOUR }),
      seed(db, 'merged just now', 'done', { pr: 'merged', checks: 'passing', changedMsAgo: POST_MERGE_CHECK_PUBLICATION_MS / 2 }),
    ];
    seed(db, 'merged long ago', 'done', { pr: 'merged', checks: 'passing', changedMsAgo: POST_MERGE_CHECK_PUBLICATION_MS + HOUR });
    seed(db, 'merged long ago, failing', 'done', { pr: 'merged', checks: 'failing', changedMsAgo: 50 * HOUR });
    seed(db, 'done without delivery', 'done');
    seed(db, 'queued, never delivered', 'queued');
    seed(db, 'backlog', 'backlog');

    expect(listTasks(db, { delivery: true }).map((t) => t.key)).toEqual(keep);
    expect(listTasks(db)).toHaveLength(9); // the plain listing is unchanged
  });
});

describe('listTasks({ doneSince })', () => {
  it('keeps every unfinished task, recent done tasks, and done tasks with an open alert', () => {
    const db = makeTestDb();
    const mk = (title: string, status: string, updatedAt: string) => {
      const t = createTask(db, { title, spec: 'S', acceptanceCriteria: 'A' });
      db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE key = ?').run(status, updatedAt, t.key);
      return t.key;
    };
    const old = '2020-01-01T00:00:00.000Z';
    const since = '2030-01-01T00:00:00.000Z';
    const queuedOld = mk('queued long ago', 'queued', old);
    const doneRecent = mk('done just now', 'done', '2030-01-02T00:00:00.000Z');
    const doneAlerted = mk('done long ago, alert still open', 'done', old);
    mk('done long ago, settled', 'done', old);
    db.prepare(`INSERT INTO attention_occurrence (event_key, state_key, event_type, reason, target, task_key, text, first_seen_at, last_seen_at)
                VALUES ('k', 's', 'blocked', 'blocked', ?, ?, 'x', ?, ?)`).run(doneAlerted, doneAlerted, old, old);

    expect(listTasks(db, { doneSince: since }).map((t) => t.key)).toEqual([queuedOld, doneRecent, doneAlerted]);
  });
});

// listRows runs these for every listing (board, supervisors' polls, notifier). Reading the whole
// activity history instead of the listed tasks' rows made a 2-task listing cost ~35 ms on a real
// board (20k activity rows, every comment body lower-cased).
describe('per-task activity lookups', () => {
  it.each([
    ['latestAiReviewComments', latestAiReviewComments],
    ['latestFailureComments', latestFailureComments],
    ['latestFailureNotePairs', latestFailureNotePairs],
  ] as const)('%s reads only the requested tasks\' activity', (_name, fn) => {
    const db = makeTestDb();
    const seen: string[] = [];
    const spy = new Proxy(db, { get: (t, p) => p === 'prepare' ? (sql: string) => { seen.push(sql); return t.prepare(sql); } : Reflect.get(t, p) });
    fn(spy as DB, [1, 2]);
    expect(seen).toHaveLength(1);
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${seen[0]}`).all(1, 2) as Array<{ detail: string }>).map((r) => r.detail);
    expect(plan.filter((d) => /^SCAN activity\b/.test(d))).toEqual([]);
  });
});
