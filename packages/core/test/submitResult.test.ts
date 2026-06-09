import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { linksFor } from '../src/repo/links.js';
import { ValidationError, NotFoundError, InvalidTransitionError } from '../src/errors.js';
import type { Status } from '../src/types.js';

const FIXED_TS = '2030-07-01T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

describe('submitResult', () => {
  it('in_progress → in_review: status, resultSummary, links, updatedAt all set correctly', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    const detail = submitResult(
      db,
      task.key,
      { summary: 'did the thing', links: [{ kind: 'pr', label: 'PR #1', url: 'http://x/1' }] },
      fixedNow,
    );

    expect(detail.status).toBe('in_review');
    expect(detail.resultSummary).toBe('did the thing');
    expect(detail.links).toHaveLength(1);
    expect(detail.links[0].kind).toBe('pr');
    expect(detail.links[0].label).toBe('PR #1');
    expect(detail.links[0].url).toBe('http://x/1');
    expect(detail.updatedAt).toBe(FIXED_TS);

    // Verify DB row
    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_review');
    expect(row.result_summary).toBe('did the thing');
    expect(row.updated_at).toBe(FIXED_TS);
  });

  it('appends both result and status_change activities; both present in returned activity', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    const detail = submitResult(db, task.key, { summary: 'done' }, fixedNow);

    const resultAct = detail.activity.find(a => a.type === 'result');
    const statusAct = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'in_review');

    expect(resultAct).toBeDefined();
    expect(resultAct!.actor).toBe('agent');
    expect(resultAct!.body).toBe('done');
    expect(resultAct!.createdAt).toBe(FIXED_TS);

    expect(statusAct).toBeDefined();
    expect(statusAct!.actor).toBe('agent');
    expect(statusAct!.fromStatus).toBe('in_progress');
    expect(statusAct!.toStatus).toBe('in_review');
    expect(statusAct!.createdAt).toBe(FIXED_TS);
  });

  it('updatedAt is bumped to the injected ts', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    const detail = submitResult(db, task.key, { summary: 'done' }, fixedNow);

    expect(detail.updatedAt).toBe(FIXED_TS);
  });

  it.each<Status>(['backlog', 'queued', 'in_review', 'done', 'blocked'])(
    'rejects from status=%s with InvalidTransitionError; nothing changed',
    (status) => {
      const db = makeTestDb();
      const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
      db.prepare("UPDATE task SET status=? WHERE key=?").run(status, task.key);

      const activityBefore = recentActivity(db, task.id, 100).length;
      const linksBefore = linksFor(db, task.id).length;

      expect(() =>
        submitResult(db, task.key, { summary: 'should fail' })
      ).toThrow(InvalidTransitionError);

      // Status unchanged
      const row = findRowByKey(db, task.key)!;
      expect(row.status).toBe(status);
      expect(row.result_summary).toBeNull();

      // No new activity or links written
      expect(recentActivity(db, task.id, 100).length).toBe(activityBefore);
      expect(linksFor(db, task.id).length).toBe(linksBefore);
    },
  );

  it('empty summary throws ValidationError', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    expect(() =>
      submitResult(db, task.key, { summary: '   ' })
    ).toThrow(ValidationError);
  });

  it('unknown key throws NotFoundError', () => {
    const db = makeTestDb();

    expect(() =>
      submitResult(db, 'AF-9999', { summary: 'done' })
    ).toThrow(NotFoundError);
  });
});
