import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { getTask } from '../src/ops/getTask.js';
import { ValidationError } from '../src/errors.js';

const prReview = (db: ReturnType<typeof makeTestDb>) =>
  createTask(db, {
    title: 'PR #42: fix the thing',
    spec: 'Review teammate PR',
    acceptanceCriteria: 'review given',
    kind: 'pr-review',
    links: [
      { kind: 'pr', label: 'PR #42', url: 'https://github.com/o/r/pull/42' },
      { kind: 'branch', label: 'feature/teammate-thing', url: 'https://github.com/o/r/pull/42' },
    ],
  });

describe('pr-review tasks', () => {
  it('defaults kind to code; a normal task is unchanged', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(t.kind).toBe('code');
  });

  it('createTask persists kind=pr-review and the attached links', () => {
    const db = makeTestDb();
    const t = prReview(db);
    expect(t.kind).toBe('pr-review');
    const detail = getTask(db, t.key);
    expect(detail.links.map((l) => l.kind)).toEqual(['pr', 'branch']);
    expect(detail.links.find((l) => l.kind === 'branch')!.label).toBe('feature/teammate-thing');
  });

  it('parks a pr-review task straight into review (backlog → in_review)', () => {
    const db = makeTestDb();
    const t = prReview(db);
    const d = updateStatus(db, t.key, 'in_review', 'human');
    expect(d.status).toBe('in_review');
  });

  it('rejects backlog → in_review for a code task (no skipping implementation)', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(() => updateStatus(db, t.key, 'in_review', 'human')).toThrow(ValidationError);
  });

  it('rejects queuing a pr-review task (it is reviewed, not implemented)', () => {
    const db = makeTestDb();
    const t = prReview(db);
    expect(() => updateStatus(db, t.key, 'queued', 'human')).toThrow(ValidationError);
  });

  it('"Mark reviewed" closes it: reviewApprove on the in_review pr-review task → done', () => {
    const db = makeTestDb();
    const t = prReview(db);
    updateStatus(db, t.key, 'in_review', 'human');
    const done = reviewApprove(db, t.key);
    expect(done.status).toBe('done');
  });
});
