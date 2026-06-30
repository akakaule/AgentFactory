import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { reviewPrReviewed, PR_REVIEW_FEEDBACK_MARKER } from '../src/ops/reviewPrReviewed.js';
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

  it('requires a branch link — the remote branch is the functional input', () => {
    const db = makeTestDb();
    expect(() =>
      createTask(db, {
        title: 'PR #42: fix the thing',
        spec: 'Review teammate PR',
        acceptanceCriteria: 'review given',
        kind: 'pr-review',
        links: [{ kind: 'pr', label: 'PR #42', url: 'https://dev.azure.com/o/p/_git/r/pullrequest/42' }],
      }),
    ).toThrow(ValidationError);
  });

  it('accepts a branch link with no pr link — the pr/MR url is optional context', () => {
    const db = makeTestDb();
    const t = createTask(db, {
      title: 'ADO-PR #7: tidy up',
      spec: 'Review teammate PR',
      acceptanceCriteria: 'review given',
      kind: 'pr-review',
      links: [{ kind: 'branch', label: 'feature/tidy', url: 'origin/feature/tidy' }],
    });
    expect(t.kind).toBe('pr-review');
    expect(getTask(db, t.key).links.map((l) => l.kind)).toEqual(['branch']);
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

  it('rejects sending a pr-review task back to the queue from in_review', () => {
    const db = makeTestDb();
    const t = prReview(db);
    updateStatus(db, t.key, 'in_review', 'human');
    // in_review → queued is the human "send back" edge; a pr-review task has no implementation
    // to re-queue, so it must never reach the worker queue (where the dispatcher would claim it).
    expect(() => updateStatus(db, t.key, 'queued', 'human')).toThrow(ValidationError);
  });

  it('rescues a pr-review task stranded in queued back to in_review', () => {
    const db = makeTestDb();
    const t = prReview(db);
    // simulate a legacy task wrongly parked in queued (pre-guard): the human can recover it.
    updateStatus(db, t.key, 'in_review', 'human');
    db.prepare("UPDATE task SET status='queued' WHERE key=?").run(t.key);
    const d = updateStatus(db, t.key, 'in_review', 'human');
    expect(d.status).toBe('in_review');
  });

  it('reopens a closed pr-review to review (done → in_review), not the queue', () => {
    const db = makeTestDb();
    const t = prReview(db);
    updateStatus(db, t.key, 'in_review', 'human');
    updateStatus(db, t.key, 'done', 'human');
    expect(() => updateStatus(db, t.key, 'queued', 'human')).toThrow(ValidationError);
    expect(updateStatus(db, t.key, 'in_review', 'human').status).toBe('in_review');
  });

  it('a queued pr-review task is never claimed by a worker', () => {
    const db = makeTestDb();
    const t = prReview(db);
    // force it into queued the way the pre-guard bug did, then prove the claim path skips it.
    db.prepare("UPDATE task SET status='queued' WHERE key=?").run(t.key);
    expect(claimNextTask(db, { workspace: 'default' })).toBeNull();
  });

  it('rejects reopening a code task straight to review (done → in_review is pr-review-only)', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    updateStatus(db, t.key, 'queued', 'human');
    const claimed = claimNextTask(db, { workspace: 'default' })!;
    updateStatus(db, claimed.key, 'in_review', 'agent');
    updateStatus(db, claimed.key, 'done', 'human');
    expect(() => updateStatus(db, claimed.key, 'in_review', 'human')).toThrow(ValidationError);
  });

  it('"Mark reviewed" closes it: reviewApprove on the in_review pr-review task → done', () => {
    const db = makeTestDb();
    const t = prReview(db);
    updateStatus(db, t.key, 'in_review', 'human');
    const done = reviewApprove(db, t.key);
    expect(done.status).toBe('done');
  });

  it('reviewPrReviewed captures the review as a pr-review-feedback/v1 comment and closes', () => {
    const db = makeTestDb();
    const t = prReview(db);
    updateStatus(db, t.key, 'in_review', 'human');
    const done = reviewPrReviewed(db, t.key, { review: '  LGTM, one nit:\n\n- fix the guard  ' });
    expect(done.status).toBe('done');
    const fb = getTask(db, t.key).activity.find((a) => a.type === 'comment' && a.body.startsWith(PR_REVIEW_FEEDBACK_MARKER));
    expect(fb).toBeDefined();
    // marker line + the trimmed review markdown
    expect(fb!.body).toBe(`${PR_REVIEW_FEEDBACK_MARKER}\nLGTM, one nit:\n\n- fix the guard`);
  });

  it('reviewPrReviewed with an empty review closes with no feedback comment', () => {
    const db = makeTestDb();
    const t = prReview(db);
    updateStatus(db, t.key, 'in_review', 'human');
    const done = reviewPrReviewed(db, t.key, { review: '   ' });
    expect(done.status).toBe('done');
    expect(getTask(db, t.key).activity.some((a) => a.body.startsWith(PR_REVIEW_FEEDBACK_MARKER))).toBe(false);
  });

  it('reviewPrReviewed requires in_review', () => {
    const db = makeTestDb();
    const t = prReview(db); // still backlog
    expect(() => reviewPrReviewed(db, t.key, { review: 'x' })).toThrow();
  });
});
