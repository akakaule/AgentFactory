import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { addComment } from '../src/ops/addComment.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { getTask } from '../src/ops/getTask.js';
import { observeRevision } from '../src/ops/observeRevision.js';
import { recordDeliveryCheck } from '../src/ops/delivery.js';
import { attachVisualization } from '../src/ops/visualization.js';
import { formatReviewRevision } from '../src/aiReview.js';
import { InvalidTransitionError } from '../src/errors.js';
import type { DB } from '../src/db.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);
let tick = 0;
const now = () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)).toISOString();

function implTask(db: DB): string {
  const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
  db.prepare("UPDATE task SET status='in_progress', branch='feature/x' WHERE key=?").run(t.key);
  return t.key;
}

function cleanReview(rev: { submissionId: number; headSha?: string | null; baseSha?: string | null }): string {
  return `ai-review/v1 - clean (codex)\n\`\`\`json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n\`\`\`\n${formatReviewRevision(rev)}`;
}

describe('revision-bound submissions', () => {
  it('records the submitted head/base SHA with its source and observation time', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const d = submitResult(db, key, { summary: 'r1', revision: { headSha: A, baseSha: BASE, source: 'origin' } }, now);
    expect(d.submission).toMatchObject({ stage: 'implementation', headSha: A, baseSha: BASE, source: 'origin', branch: 'feature/x', freshness: 'current' });
    expect(d.submission!.id).toBeGreaterThan(0);
    expect(d.submission!.observedAt).toBeTruthy();
  });

  it('an implementation submit without a resolved revision is recorded with unknown freshness', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const d = submitResult(db, key, { summary: 'r1' }, now);
    expect(d.submission).toMatchObject({ headSha: null, source: 'unknown', freshness: 'unknown' });
  });

  it('a review bound to the current submission/head reads current; approval of it succeeds', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, baseSha: BASE, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A, baseSha: BASE }) }, now);
    const d = getTask(db, key);
    expect(d.aiReview).toMatchObject({ verdict: 'clean', binding: 'current', revision: { submissionId: sub.id, headSha: A } });
    const approved = reviewApprove(db, key, now, null, () => null, null, { submissionId: sub.id, headSha: A });
    expect(approved.status).toBe('done');
    const note = approved.activity.find((a) => a.type === 'status_change' && a.toStatus === 'done')!;
    expect(note.body).toContain(`submission #${sub.id}`);
    expect(note.body).toContain(A.slice(0, 7));
  });

  it('submission A reviewed at SHA A, branch updated to SHA B: the green review is stale and approval of A is rejected', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, baseSha: BASE, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A, baseSha: BASE }) }, now);
    observeRevision(db, key, { submissionId: sub.id, headSha: B, source: 'git' }, now);
    const d = getTask(db, key);
    expect(d.submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, source: 'git' } });
    expect(d.aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
    expect(() => reviewApprove(db, key, now, null, () => null, null, { submissionId: sub.id, headSha: A })).toThrow(InvalidTransitionError);
    // even a caller that sends no expectation cannot approve the stale revision
    expect(() => reviewApprove(db, key, now, null, () => null, null)).toThrow(/changed since/);
    expect(getTask(db, key).status).toBe('in_review');
  });

  it('a review that diffed a newer head than the submission is not proof for the submission', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: B }) }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
  });

  it('approval names the expected submission: an older submission id is refused after a resubmit', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    const second = submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now).submission!;
    expect(second.id).not.toBe(first.id);
    expect(() => reviewApprove(db, key, now, null, () => null, null, { submissionId: first.id, headSha: A })).toThrow(/submission/);
    expect(() => reviewApprove(db, key, now, null, () => null, null, { submissionId: second.id, headSha: A })).toThrow(/revision/);
    expect(reviewApprove(db, key, now, null, () => null, null, { submissionId: second.id, headSha: B }).status).toBe('done');
  });

  it('a review posted for a superseded submission id is refused before publication', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now);
    expect(() => addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: first.id, headSha: A }) }, now)).toThrow(InvalidTransitionError);
  });

  it('unknown freshness during a git failure is shown and an approval records it in a distinct audit note', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    observeRevision(db, key, { submissionId: sub.id, headSha: null, source: 'git', error: 'origin unreachable' }, now);
    const d = getTask(db, key);
    expect(d.submission).toMatchObject({ freshness: 'unknown', lastObservation: { error: 'origin unreachable' } });
    const approved = reviewApprove(db, key, now, null, () => null, null, { submissionId: sub.id, headSha: A });
    expect(approved.status).toBe('done');
    expect(approved.activity.some((a) => a.type === 'comment' && a.actor === 'human' && /unknown revision freshness/.test(a.body) && a.body.includes('origin unreachable'))).toBe(true);
  });

  it('a retry of the same successful execution does not create a second submission', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
    db.prepare("UPDATE task SET status='queued' WHERE key=?").run(t.key);
    const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
    const key = t.key;
    const input = { summary: 'r1', executionId: claim.executionId!, revision: { headSha: A, source: 'origin' as const } };
    const first = submitResult(db, key, input, now).submission!;
    const again = submitResult(db, key, input, now);
    expect(again.submission!.id).toBe(first.id);
    const n = db.prepare('SELECT COUNT(*) AS n FROM task_submission').get() as { n: number };
    expect(n.n).toBe(1);
  });

  it('doc stages carry a content identity: identical content hashes equally, an edit makes it stale', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(t.key);
    const s1 = submitResult(db, t.key, { summary: 'd1', spec: 'Spec v1', acceptanceCriteria: '- AC1 works' }, now).submission!;
    expect(s1).toMatchObject({ stage: 'description', source: 'content', headSha: null, freshness: 'current' });
    expect(s1.contentHash).toMatch(/^[0-9a-f]{64}$/);
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(t.key);
    const s2 = submitResult(db, t.key, { summary: 'd2', spec: 'Spec v1', acceptanceCriteria: '- AC1 works' }, now).submission!;
    expect(s2.id).not.toBe(s1.id);
    expect(s2.contentHash).toBe(s1.contentHash);
    db.prepare("UPDATE task SET spec='edited' WHERE key=?").run(t.key);
    expect(getTask(db, t.key).submission!.freshness).toBe('stale');
  });

  it('a clean doc-stage review bound to changed content does not auto-approve', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(t.key);
    const s1 = submitResult(db, t.key, { summary: 'd1', spec: 'Spec v1', acceptanceCriteria: '- AC1 works' }, now).submission!;
    db.prepare("UPDATE task SET spec='edited' WHERE key=?").run(t.key);
    addComment(db, t.key, { actor: 'agent', body: cleanReview({ submissionId: s1.id }) }, now);
    expect(getTask(db, t.key)).toMatchObject({ status: 'in_review', stage: 'description' });
  });

  it('historical tasks without submissions still render; their reviews are labelled legacy', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(t.key);
    addComment(db, t.key, { actor: 'agent', body: 'ai-review/v1 - clean\n```json\n{"verdict":"clean","findings":[]}\n```' }, now);
    const d = getTask(db, t.key);
    expect(d.submission).toBeNull();
    expect(d.aiReview).toMatchObject({ verdict: 'clean', binding: 'legacy', revision: null });
    expect(reviewApprove(db, t.key, now).status).toBe('done');
  });

  it('visualizations are stamped with the submission they were attached under', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    attachVisualization(db, key, { html: '<html></html>' }, now);
    expect(getTask(db, key).visualizationRevision).toEqual({ submissionId: sub.id, headSha: A });
  });

  it('delivery keeps the approved revision; a provider-observed PR head that differs is persisted and marks the submission stale', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: sub.id, headSha: A });
    let d = getTask(db, key);
    expect(d.status).toBe('delivering');
    expect(d.delivery).toMatchObject({ approvedHeadSha: A, headSha: null });
    recordDeliveryCheck(db, key, { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending', headSha: B }, now);
    d = getTask(db, key);
    expect(d.delivery).toMatchObject({ approvedHeadSha: A, headSha: B });
    expect(d.submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, source: 'provider' } });
  });
});

describe('review binding: superseded vs stale', () => {
  it('a review of an older submission reads superseded; a moved head on the current one reads stale', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: first.id, headSha: A }) }, now);
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    const second = submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now).submission!;
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'superseded' });
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: second.id, headSha: B }) }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'clean', binding: 'current' });
    observeRevision(db, key, { headSha: A, source: 'git' }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
  });
});
