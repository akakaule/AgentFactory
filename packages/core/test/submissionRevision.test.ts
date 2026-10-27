import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { addComment } from '../src/ops/addComment.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { getTask } from '../src/ops/getTask.js';
import { observeRevision } from '../src/ops/observeRevision.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { recordDeliveryCheck, beginDelivery, failDelivery, recordDeliveryCheckFailure } from '../src/ops/delivery.js';
import { listTasks } from '../src/ops/listTasks.js';
import { attachVisualization } from '../src/ops/visualization.js';
import { formatReviewRevision } from '../src/aiReview.js';
import { InvalidTransitionError } from '../src/errors.js';
import { createCore } from '../src/index.js';
import type { DB } from '../src/db.js';
import { appendActivity } from '../src/repo/activity.js';

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

  it('an unbound review of a tracked submission is not proof: it reads pending and a bound review replaces it', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, baseSha: BASE, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: 'ai-review/v1 - clean\n```json\n{"verdict":"clean","findings":[]}\n```' }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'legacy', revision: null });
    // a push observed after the unbound review must not leave it green either
    observeRevision(db, key, { submissionId: sub.id, headSha: B, source: 'git' }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'legacy' });
    expect(getTask(db, key).reviewBrief?.headline).toBe('pending');
    // the reviewer's bound re-review takes over (here: stale, since head B was observed)
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A, baseSha: BASE }) }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'stale', revision: { submissionId: sub.id } });
  });

  it('an unbound review with must-fix findings keeps its verdict and still needs an approval reason', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: 'ai-review/v1 - 1 finding\n```json\n{"verdict":"findings","findings":[{"severity":"error","title":"Broken"}]}\n```' }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'findings', binding: 'legacy' });
    expect(() => reviewApprove(db, key, now, null, () => null, null, { submissionId: sub.id, headSha: A })).toThrow(/needs a reason/);
  });

  it('an unbound review on a done task keeps rendering as it was recorded', () => {
    const db = makeTestDb();
    const key = implTask(db);
    submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now);
    addComment(db, key, { actor: 'agent', body: 'ai-review/v1 - clean\n```json\n{"verdict":"clean","findings":[]}\n```' }, now);
    db.prepare("UPDATE task SET status='done' WHERE key=?").run(key);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'clean', binding: 'legacy' });
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

describe('revision gate holds across every human close and through observation failures', () => {
  it('a raw human status move cannot complete a known-stale implementation', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, baseSha: BASE, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A, baseSha: BASE }) }, now);
    observeRevision(db, key, { submissionId: sub.id, headSha: B, source: 'git' }, now);
    expect(() => updateStatus(db, key, 'done', 'human', now)).toThrow(/changed since/);
    expect(() => updateStatus(db, key, 'delivering', 'human', now)).toThrow(/changed since/);
    expect(getTask(db, key).status).toBe('in_review');
  });

  it('a raw human status move still closes a current implementation', () => {
    const db = makeTestDb();
    const key = implTask(db);
    submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now);
    expect(updateStatus(db, key, 'done', 'human', now, null, undefined, undefined, { submissionId: getTask(db, key).submission!.id }).status).toBe('done');
  });

  it('a raw human status close names the submission the human reviewed: a replacement is refused, not approved', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: first.id, headSha: A }) }, now);
    // submission B replaces A before the human's status request lands
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    const second = submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now).submission!;
    expect(() => updateStatus(db, key, 'done', 'human', now, null, undefined, undefined, { submissionId: first.id, headSha: A }))
      .toThrow(/approval names submission #\d+, but the current submission/);
    expect(() => updateStatus(db, key, 'delivering', 'human', now, null, undefined, undefined, { submissionId: second.id, headSha: A }))
      .toThrow(/approval names revision/);
    expect(getTask(db, key).status).toBe('in_review');
    const d = updateStatus(db, key, 'done', 'human', now, null, undefined, undefined, { submissionId: second.id, headSha: B });
    expect(d.status).toBe('done');
  });

  it('a raw human status close naming a submission is refused on a historical task with none', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(t.key);
    expect(() => updateStatus(db, t.key, 'done', 'human', now, null, undefined, undefined, { submissionId: 99 })).toThrow(/no recorded submission/);
    // unbound compatibility: without an expectation the historical task closes as before
    expect(updateStatus(db, t.key, 'done', 'human', now).status).toBe('done');
  });

  it('a failed observation after a known mismatch keeps the submission stale and approval refused', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, baseSha: BASE, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A, baseSha: BASE }) }, now);
    observeRevision(db, key, { submissionId: sub.id, headSha: B, source: 'git' }, now);
    observeRevision(db, key, { submissionId: sub.id, headSha: null, source: 'git', error: 'origin unreachable' }, now);
    const d = getTask(db, key);
    expect(d.submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, error: 'origin unreachable' } });
    expect(d.aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
    expect(() => reviewApprove(db, key, now, null, () => null, null, { submissionId: sub.id, headSha: A })).toThrow(/changed since/);
  });

  it('a provider check that reports no head does not erase a known mismatch', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    observeRevision(db, key, { submissionId: sub.id, headSha: B, source: 'git' }, now);
    observeRevision(db, key, { submissionId: sub.id, headSha: null, source: 'provider' }, now);
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B } });
  });

  it('a later successful observation back at the submitted head makes it current again', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    observeRevision(db, key, { submissionId: sub.id, headSha: B, source: 'git' }, now);
    observeRevision(db, key, { submissionId: sub.id, headSha: null, source: 'git', error: 'origin unreachable' }, now);
    observeRevision(db, key, { submissionId: sub.id, headSha: A, source: 'git' }, now);
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'current', lastObservation: { headSha: A, error: null } });
  });
});

describe('raw delivery approvals and provider failures keep the revision binding', () => {
  it('a raw drag to delivering binds the seeded delivery row to the approved submission', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A }) }, now);
    updateStatus(db, key, 'delivering', 'human', now, null, undefined, undefined, { submissionId: getTask(db, key).submission!.id });
    expect(getTask(db, key).activity.at(-1)?.body).toMatch(new RegExp(`approved submission #${sub.id} at ${A.slice(0, 7)}`));
    expect(beginDelivery(db, key, { provider: 'github', branch: 'feature/x' }, now)).toMatchObject({ approvedHeadSha: A });
    recordDeliveryCheck(db, key, { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending', headSha: B }, now);
    const d = getTask(db, key);
    expect(d.delivery).toMatchObject({ approvedHeadSha: A, headSha: B });
    expect(d.submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, source: 'provider' } });
    expect(d.aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
  });

  it('a raw drag after a bounced delivery rebinds the surviving delivery row to the new submission', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: first.id, headSha: A });
    failDelivery(db, key, { reason: 'ci_failed', detail: 'red' }, now);
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    const second = submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now).submission!;
    updateStatus(db, key, 'delivering', 'human', now, null, undefined, undefined, { submissionId: getTask(db, key).submission!.id });
    expect(getTask(db, key).delivery).toMatchObject({ approvedHeadSha: B });
    recordDeliveryCheck(db, key, { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending', headSha: A }, now);
    expect(getTask(db, key).submission).toMatchObject({ id: second.id, freshness: 'stale', lastObservation: { headSha: A, source: 'provider' } });
  });

  it('a failed provider check makes freshness unknown; a later check clears it', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: sub.id, headSha: A });
    recordDeliveryCheck(db, key, { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending', headSha: A }, now);
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'current' });
    recordDeliveryCheckFailure(db, key, { error: 'GitHub 503' }, now);
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'unknown', lastObservation: { headSha: A, source: 'provider', error: 'GitHub 503' } });
    recordDeliveryCheck(db, key, { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending' }, now);
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'current', lastObservation: { headSha: A, error: null } });
  });

  it('a failed provider check after a known mismatch keeps the submission stale', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: sub.id, headSha: A });
    recordDeliveryCheck(db, key, { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending', headSha: B }, now);
    recordDeliveryCheckFailure(db, key, { error: 'GitHub 503' }, now);
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, error: 'GitHub 503' } });
  });
});

describe('round 4: unbound doc reviews, the rebind fence, the raw-close audit', () => {
  const unboundClean = 'ai-review/v1 - clean (codex)\n```json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n```';

  it('an unbound clean review does not auto-approve a doc stage with a tracked submission', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(t.key);
    submitResult(db, t.key, { summary: 'd1', spec: 'Spec v1', acceptanceCriteria: '- AC1 works' }, now);
    db.prepare("UPDATE task SET spec='edited' WHERE key=?").run(t.key);
    addComment(db, t.key, { actor: 'agent', body: unboundClean }, now);
    expect(getTask(db, t.key)).toMatchObject({ status: 'in_review', stage: 'description' });
  });

  it('an unbound clean review still auto-approves a historical doc task with no tracked submission', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(t.key);
    addComment(db, t.key, { actor: 'agent', body: unboundClean }, now);
    expect(getTask(db, t.key)).toMatchObject({ status: 'queued', stage: 'implementation' });
  });

  it('a raw reapproval advances the delivery fence: a delayed observation from the previous approval is rejected', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: first.id, headSha: A });
    const pr = 'https://github.com/o/r/pull/1';
    recordDeliveryCheck(db, key, { prUrl: pr, prId: '1', prState: 'open', checksState: 'pending', headSha: A }, now);
    // the watcher reads the episode, then its provider request is in flight across the bounce
    const seen = getTask(db, key).delivery!;
    const expected = { status: 'delivering' as const, branch: 'feature/x', prUrl: pr, stateChangedAt: seen.stateChangedAt };
    failDelivery(db, key, { reason: 'ci_failed', detail: 'red' }, now);
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    const second = submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now).submission!;
    updateStatus(db, key, 'delivering', 'human', now, null, undefined, undefined, { submissionId: getTask(db, key).submission!.id });
    expect(getTask(db, key).delivery!.stateChangedAt).not.toBe(seen.stateChangedAt);
    const late = recordDeliveryCheck(db, key, { expected, expectedStateChangedAt: seen.stateChangedAt, prUrl: pr, prId: '1', prState: 'open', checksState: 'pending', headSha: A }, now);
    expect(late.accepted).toBe(false);
    expect(getTask(db, key).submission).toMatchObject({ id: second.id, freshness: 'current' });
  });

  it('a raw human close with unknown freshness writes the same distinct audit note as approve', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    observeRevision(db, key, { submissionId: sub.id, headSha: null, source: 'git', error: 'origin unreachable' }, now);
    const d = updateStatus(db, key, 'done', 'human', now, null, undefined, undefined, { submissionId: getTask(db, key).submission!.id });
    expect(d.status).toBe('done');
    expect(d.activity.some((a) => a.type === 'comment' && a.actor === 'human' && /unknown revision freshness/.test(a.body) && a.body.includes('origin unreachable'))).toBe(true);
  });
});

describe('round 6: observations superseded during a refresh, fenced provider failures', () => {
  function deferredHeads() {
    const pending: Array<(h: { headSha: string | null; error: string | null }) => void> = [];
    const resolveRemoteHead = () => new Promise<{ headSha: string | null; error: string | null }>((r) => { pending.push(r); });
    return { pending, resolveRemoteHead };
  }

  it('an older refresh that returns after a newer one recorded B does not overwrite it', async () => {
    const db = makeTestDb();
    const { pending, resolveRemoteHead } = deferredHeads();
    const core = createCore(db, { resolveOrigin: () => 'https://github.com/o/r.git', resolveRemoteHead });
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A }) }, now);
    const older = core.refreshRevision(key); // reads A ...
    const newer = core.refreshRevision(key); // ... reads B, and returns first
    pending[1]!({ headSha: B, error: null });
    await newer;
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B } });
    pending[0]!({ headSha: A, error: null });
    await older;
    const d = getTask(db, key);
    expect(d.submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B } });
    expect(d.aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
    expect(() => core.reviewApprove(key, null, null, { submissionId: sub.id, headSha: A })).toThrow(InvalidTransitionError);
  });

  it('refreshes that return in order still record the newest head', async () => {
    const db = makeTestDb();
    const { pending, resolveRemoteHead } = deferredHeads();
    const core = createCore(db, { resolveOrigin: () => null, resolveRemoteHead });
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    const first = core.refreshRevision(key);
    const second = core.refreshRevision(key);
    pending[0]!({ headSha: B, error: null });
    await first;
    pending[1]!({ headSha: A, error: null });
    await second;
    expect(getTask(db, key).submission).toMatchObject({ id: sub.id, freshness: 'current', lastObservation: { headSha: A } });
  });

  it('a failed poll fenced to an earlier delivery episode does not mark the current one unknown', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: first.id, headSha: A });
    const seen = getTask(db, key).delivery!;
    const fence = { expected: { status: 'delivering' as const, branch: seen.branch, prUrl: seen.prUrl, stateChangedAt: seen.stateChangedAt }, submissionId: first.id };
    // the poll for submission A is in flight while A bounces and B is approved and observed
    failDelivery(db, key, { reason: 'ci_failed', detail: 'red' }, now);
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    const second = submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: second.id, headSha: B });
    recordDeliveryCheck(db, key, { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending', headSha: B }, now);
    expect(recordDeliveryCheckFailure(db, key, { error: 'GitHub 503', ...fence }, now)).toEqual({ recorded: false });
    expect(getTask(db, key).submission).toMatchObject({ id: second.id, freshness: 'current' });
  });

  it('a failed poll naming the current delivery episode still records unknown freshness', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: sub.id, headSha: A });
    const seen = getTask(db, key).delivery!;
    expect(seen.submissionId).toBe(sub.id);
    const fence = { expected: { status: 'delivering' as const, branch: seen.branch, prUrl: seen.prUrl, stateChangedAt: seen.stateChangedAt }, submissionId: sub.id };
    expect(recordDeliveryCheckFailure(db, key, { error: 'GitHub 503', ...fence }, now)).toEqual({ recorded: true });
    expect(getTask(db, key).submission).toMatchObject({ freshness: 'unknown' });
  });
});

describe('round 8: unresolved submitted heads, reviews of an earlier stage', () => {
  it('a review of a submission with no recorded head stays pending, also after head B is observed; approval keeps its unknown-revision path', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1' }, now).submission!;
    expect(sub.headSha).toBeNull();
    // a fallback live-diff review bound to the head it saw
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A }) }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'unverified' });
    observeRevision(db, key, { submissionId: sub.id, headSha: B, source: 'git' }, now);
    expect(getTask(db, key).aiReview).toMatchObject({ verdict: 'pending', binding: 'unverified' });
    const approved = reviewApprove(db, key, now, null, () => null, null, { submissionId: sub.id });
    expect(approved.status).toBe('done');
  });

  it('a delayed review naming the description submission is refused once implementation was submitted', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(t.key);
    const d1 = submitResult(db, t.key, { summary: 'd1', spec: 'Spec v1', acceptanceCriteria: '- AC1 works' }, now).submission!;
    reviewApprove(db, t.key, now, null, () => null, null, { submissionId: d1.id });
    expect(getTask(db, t.key)).toMatchObject({ stage: 'implementation', status: 'queued' });
    db.prepare("UPDATE task SET status='in_progress', branch='feature/x' WHERE key=?").run(t.key);
    const i2 = submitResult(db, t.key, { summary: 'i2', revision: { headSha: A, source: 'origin' } }, now).submission!;
    expect(i2.stage).toBe('implementation');
    expect(() => addComment(db, t.key, { actor: 'human', body: cleanReview({ submissionId: d1.id }) }, now)).toThrow(/not the current submission/);
  });

  it('an earlier-stage review that reached the log never provides current readiness for a later stage', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(t.key);
    const d1 = submitResult(db, t.key, { summary: 'd1', spec: 'Spec v1', acceptanceCriteria: '- AC1 works' }, now).submission!;
    reviewApprove(db, t.key, now, null, () => null, null, { submissionId: d1.id });
    db.prepare("UPDATE task SET status='in_progress', branch='feature/x' WHERE key=?").run(t.key);
    submitResult(db, t.key, { summary: 'i2', revision: { headSha: A, source: 'origin' } }, now);
    const id = getTask(db, t.key).id;
    appendActivity(db, { taskId: id, type: 'comment', actor: 'human', body: cleanReview({ submissionId: d1.id }), createdAt: now(), actorUserId: null });
    expect(getTask(db, t.key).aiReview).toMatchObject({ verdict: 'pending', binding: 'superseded' });
  });
});

describe('round 9: list identity, drag expectations, visualized heads', () => {
  it('list rows carry the current submission identity of a task in review', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    expect(listTasks(db).find((t) => t.key === key)?.submission).toMatchObject({ id: sub.id, headSha: A });
  });

  it('a raw status close of a tracked submission must name it; a historical task without one still closes', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    expect(() => updateStatus(db, key, 'done', 'human', now)).toThrow(/name the submission/);
    expect(updateStatus(db, key, 'done', 'human', now, null, undefined, undefined, { submissionId: sub.id, headSha: A }).status).toBe('done');
    const legacy = createTask(db, { title: 'L', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(legacy.key);
    expect(updateStatus(db, legacy.key, 'done', 'human', now).status).toBe('done');
  });

  it('a visualization stamps the head it actually depicted and must name the current submission', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const first = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    attachVisualization(db, key, { html: '<p>live diff</p>', revision: { submissionId: first.id, headSha: B } }, now);
    expect(getTask(db, key).visualizationRevision).toEqual({ submissionId: first.id, headSha: B });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(key);
    submitResult(db, key, { summary: 'r2', revision: { headSha: B, source: 'origin' } }, now);
    expect(() => attachVisualization(db, key, { html: '<p>old</p>', revision: { submissionId: first.id, headSha: A } }, now)).toThrow(InvalidTransitionError);
  });
});

describe('round 10: named approvals', () => {
  it('the approve action must name a tracked submission; a historical task without one still approves unnamed', () => {
    const db = makeTestDb();
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    expect(() => reviewApprove(db, key, now, null, () => null)).toThrow(/name the submission/);
    expect(getTask(db, key).status).toBe('in_review');
    expect(reviewApprove(db, key, now, null, () => null, null, { submissionId: sub.id, headSha: A }).status).toBe('done');
    const legacy = createTask(db, { title: 'L', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(legacy.key);
    expect(reviewApprove(db, legacy.key, now, null, () => null).status).toBe('done');
  });

});


describe('round 12: board-issued read tickets order every revision observation', () => {
  const PR = { prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open' as const, checksState: 'pending' as const };
  type Kind = 'git' | 'provider';
  type Outcome = { headSha: string } | { error: string };

  /** A delivering task on a facade whose git reads are deferred; the provider reader is driven
   *  like the watcher: take a ticket from the board, read on its own (skewed) clock, report with it. */
  function harness() {
    const db = makeTestDb();
    const pending: Array<(h: { headSha: string | null; error: string | null }) => void> = [];
    const resolveRemoteHead = () => new Promise<{ headSha: string | null; error: string | null }>((r) => { pending.push(r); });
    const core = createCore(db, { resolveOrigin: () => 'https://github.com/o/r.git', resolveRemoteHead });
    const key = implTask(db);
    const sub = submitResult(db, key, { summary: 'r1', revision: { headSha: A, source: 'origin' } }, now).submission!;
    addComment(db, key, { actor: 'agent', body: cleanReview({ submissionId: sub.id, headSha: A }) }, now);
    reviewApprove(db, key, now, null, () => 'https://github.com/o/r.git', null, { submissionId: sub.id, headSha: A });
    return { db, core, key, sub, pending };
  }

  /** Start one reader; the returned function delivers its outcome and waits until it is recorded. */
  function start(h: ReturnType<typeof harness>, kind: Kind, skewMs: number): (o: Outcome) => Promise<void> {
    if (kind === 'git') {
      const done = h.core.refreshRevision(h.key);
      const resolve = h.pending[h.pending.length - 1]!;
      return async (o) => {
        resolve('headSha' in o ? { headSha: o.headSha, error: null } : { headSha: null, error: o.error });
        await done;
      };
    }
    const ticket = h.core.issueRevisionReadTicket(h.key, h.sub.id)!;
    const readStartedAt = new Date(Date.now() + skewMs).toISOString(); // the watcher's own clock
    return async (o) => {
      if ('headSha' in o) h.core.recordDeliveryCheck(h.key, { ...PR, headSha: o.headSha, readStartedAt, readTicket: ticket });
      else h.core.recordDeliveryCheckFailure(h.key, { error: o.error, submissionId: h.sub.id, readStartedAt, readTicket: ticket });
    };
  }

  const kinds: Kind[] = ['git', 'provider'];
  const cases: Array<{ first: Kind; last: Kind; returns: 'in order' | 'last-started first'; skewMs: number; lastSees: 'B' | 'A' | 'failure' }> = [];
  for (const first of kinds) for (const last of kinds) for (const returns of ['in order', 'last-started first'] as const)
    for (const skewMs of [-5_000, 5_000]) for (const lastSees of ['B', 'A', 'failure'] as const)
      cases.push({ first, last, returns, skewMs, lastSees });

  it.each(cases)('$first then $last start, return $returns, watcher clock $skewMs ms, last-started sees $lastSees: it wins', async (c) => {
    const h = harness();
    const firstOutcome: Outcome = c.lastSees === 'A' ? { headSha: B } : { headSha: A };
    const lastOutcome: Outcome = c.lastSees === 'failure' ? { error: 'unreachable' } : { headSha: c.lastSees === 'B' ? B : A };
    const finishFirst = start(h, c.first, c.skewMs);
    const finishLast = start(h, c.last, c.skewMs);
    if (c.returns === 'in order') {
      await finishFirst(firstOutcome);
      await finishLast(lastOutcome);
    } else {
      await finishLast(lastOutcome);
      await finishFirst(firstOutcome);
    }
    const s = getTask(h.db, h.key).submission!;
    if ('error' in lastOutcome) {
      // the failure wins; the known head is A either way (the first reader saw A or was dropped)
      expect(s.lastObservation).toMatchObject({ source: c.last, headSha: c.returns === 'in order' ? A : null, error: expect.stringMatching(/unreachable/) });
      expect(s.freshness).toBe('unknown');
    } else {
      expect(s.lastObservation).toMatchObject({ source: c.last, headSha: lastOutcome.headSha, error: null });
      expect(s.freshness).toBe(lastOutcome.headSha === A ? 'current' : 'stale');
    }
  });

  it('the reviewer\'s race: a git read that starts before the provider poll but returns after its observation of B cannot restore green', async () => {
    const h = harness();
    const git = start(h, 'git', 0);
    const provider = start(h, 'provider', -5_000);
    await provider({ headSha: B });
    await git({ headSha: A });
    const d = getTask(h.db, h.key);
    expect(d.submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, source: 'provider' } });
    expect(d.aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
  });

  it('a late provider answer keeps its PR/checks state but not its head', async () => {
    const h = harness();
    const provider = start(h, 'provider', 5_000);
    const git = start(h, 'git', 0);
    await git({ headSha: B });
    await provider({ headSha: A });
    const d = getTask(h.db, h.key);
    expect(d.delivery).toMatchObject({ checksState: 'pending', headSha: null });
    expect(d.submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, source: 'git' } });
  });

  it('a ticket the board never issued, or one for another submission, records nothing', () => {
    const h = harness();
    const issued = h.core.issueRevisionReadTicket(h.key, h.sub.id)!;
    observeRevision(h.db, h.key, { submissionId: h.sub.id, headSha: B, source: 'provider', readTicket: issued.ticket + 10 }, now);
    expect(h.core.recordDeliveryCheckFailure(h.key, { error: 'x', readTicket: { submissionId: h.sub.id + 1, ticket: issued.ticket } })).toEqual({ recorded: false });
    expect(getTask(h.db, h.key).submission).toMatchObject({ freshness: 'current', lastObservation: null });
  });

  it('an unticketed observation (an older watcher) takes the next ticket when it records, so it outranks reads in flight', async () => {
    const h = harness();
    const git = start(h, 'git', 0);
    observeRevision(h.db, h.key, { submissionId: h.sub.id, headSha: B, source: 'provider' }, now);
    await git({ headSha: A });
    expect(getTask(h.db, h.key).submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B, source: 'provider' } });
  });

  it('readStartedAt is only the display time: a skewed watcher clock never fences, and the as-of time is never in the future', () => {
    const h = harness();
    const ticket = h.core.issueRevisionReadTicket(h.key, h.sub.id)!;
    h.core.recordDeliveryCheck(h.key, { ...PR, headSha: B, readStartedAt: '2099-01-01T00:00:00.000Z', readTicket: ticket });
    const s = getTask(h.db, h.key).submission!;
    expect(s).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B } });
    expect(s.lastObservation!.observedAt < '2099-01-01T00:00:00.000Z').toBe(true);
  });

  it('the delivery no longer exposes an observation generation', () => {
    const h = harness();
    expect(getTask(h.db, h.key).delivery).not.toHaveProperty('observationGeneration');
  });
});
