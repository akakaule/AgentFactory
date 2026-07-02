import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { addComment } from '../src/ops/addComment.js';
import { getTask } from '../src/ops/getTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { analyticsRows } from '../src/ops/analyticsRows.js';
import { parseCurationComment } from '../src/curation.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (min: number) => () => new Date(BASE + min * 60000).toISOString();

/** An `ai-review/v1` comment body with N findings (fenced JSON), reviewer optional. */
const reviewBody = (n: number, reviewer = 'codex'): string =>
  `ai-review/v1 — ${n} findings (${reviewer})\n\n\`\`\`json\n${JSON.stringify({
    reviewer,
    verdict: n > 0 ? 'findings' : 'clean',
    findings: Array.from({ length: n }, (_, i) => ({ severity: 'warning', title: `Finding ${i + 1}`, file: 'src/x.ts', line: i + 1 })),
  })}\n\`\`\``;

/** queue → claim → submit, leaving the task in_review. */
function driveToReview(db: ReturnType<typeof makeTestDb>, title = 'T') {
  const task = createTask(db, { title, spec: 'S', acceptanceCriteria: 'A' }, at(0));
  updateStatus(db, task.key, 'queued', 'human', at(10));
  claimNextTask(db, { claimedBy: 'worker-1' }, at(30));
  submitResult(db, task.key, { summary: 'done' }, at(90));
  return task;
}

describe('derived aiReview field', () => {
  it('is null when no ai-review comment exists', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    expect(getTask(db, task.key).aiReview).toBeNull();
    expect(listTasks(db).find((t) => t.key === task.key)!.aiReview).toBeNull();
  });

  it('reflects the latest ai-review verdict + parsed findings on detail and summary', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));

    const detail = getTask(db, task.key).aiReview!;
    expect(detail.verdict).toBe('findings');
    expect(detail.findings).toBe(2);
    expect(detail.reviewer).toBe('codex');
    expect(detail.items).toHaveLength(2);
    expect(detail.items[0]).toMatchObject({ title: 'Finding 1', file: 'src/x.ts', line: 1, severity: 'warning' });

    expect(listTasks(db, { status: 'in_review' })[0]!.aiReview).toMatchObject({ verdict: 'findings', findings: 2 });
  });

  it('reads clean at zero findings', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(0) }, at(95));
    expect(getTask(db, task.key).aiReview).toMatchObject({ verdict: 'clean', findings: 0 });
  });

  it('uses the latest of several ai-review comments', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(3) }, at(95));
    addComment(db, task.key, { actor: 'agent', body: reviewBody(0) }, at(100));
    expect(getTask(db, task.key).aiReview).toMatchObject({ verdict: 'clean', findings: 0 });
  });

  it('reads pending when a resubmission is newer than the latest review', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));
    // request changes → re-claim → resubmit: a new result now postdates the review
    reviewRequestChanges(db, task.key, { feedback: 'fix it' }, at(100));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(110));
    submitResult(db, task.key, { summary: 'fixed' }, at(120));

    expect(getTask(db, task.key).aiReview).toMatchObject({ verdict: 'pending', findings: 2 });
  });

  it('ignores ordinary comments and the obsolete prefix', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'human', body: 'this looks fine, ai-review/v1 pending later' }, at(95));
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: 2 findings\n{"findings":[1,2]}' }, at(96));
    expect(getTask(db, task.key).aiReview).toBeNull();
  });

  it('degrades a marked-but-malformed review to a plain comment (no chip)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: 'ai-review/v1 broken\n{ not json' }, at(95));
    expect(getTask(db, task.key).aiReview).toBeNull();
  });
});

describe('reviewApprove override logging', () => {
  it('appends an override comment when approving over open findings', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));
    reviewApprove(db, task.key, at(150));

    const override = getTask(db, task.key).activity.find((a) => a.type === 'comment' && a.body.startsWith('override:'));
    expect(override).toBeDefined();
    expect(override!.actor).toBe('human');
    expect(override!.body).toBe('override: approved over 2 open AI findings');
  });

  it('does not log an override for a clean approval', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(0) }, at(95));
    reviewApprove(db, task.key, at(150));
    expect(getTask(db, task.key).activity.some((a) => a.body.startsWith('override:'))).toBe(false);
  });

  it('does not log an override while pending (no current review)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));
    reviewRequestChanges(db, task.key, { feedback: 'fix it' }, at(100));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(110));
    submitResult(db, task.key, { summary: 'fixed' }, at(120)); // pending: result newer than review
    reviewApprove(db, task.key, at(150));
    expect(getTask(db, task.key).activity.some((a) => a.body.startsWith('override:'))).toBe(false);
  });
});

describe('reviewApprove curation ledger (overridden)', () => {
  const ledgerOf = (db: ReturnType<typeof makeTestDb>, key: string) => {
    const c = getTask(db, key).activity.find((a) => a.type === 'comment' && parseCurationComment(a.body));
    return c ? parseCurationComment(c.body) : null;
  };

  it('dispositions every open finding as overridden when approving past them, attributed to the reviewer', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2, 'codex') }, at(95));
    reviewApprove(db, task.key, at(150));

    const parsed = ledgerOf(db, task.key)!;
    expect(parsed.reviewer).toBe('codex');
    expect(parsed.dispositions.map((d) => d.disposition)).toEqual(['overridden', 'overridden']);
    expect(parsed.dispositions.map((d) => d.title)).toEqual(['Finding 1', 'Finding 2']);
  });

  it('writes no curation ledger for a clean approval', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(0) }, at(95));
    reviewApprove(db, task.key, at(150));
    expect(ledgerOf(db, task.key)).toBeNull();
  });

  it('writes no curation ledger while pending (a result superseded the review)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));
    reviewRequestChanges(db, task.key, { feedback: 'fix it' }, at(100));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(110));
    submitResult(db, task.key, { summary: 'fixed' }, at(120));
    reviewApprove(db, task.key, at(150));
    expect(ledgerOf(db, task.key)).toBeNull();
  });
});

describe('analyticsRows curation events', () => {
  it('emits one event per disposition, tagged with reviewer/workspace and the task fate', () => {
    const db = makeTestDb();
    // request-changes forwards one finding, dismisses another; then the task reopens? No —
    // exercise the override path: approve past 2 findings ⇒ two overridden events.
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2, 'codex') }, at(95));
    reviewApprove(db, task.key, at(150));

    const { curations } = analyticsRows(db, at(999));
    const mine = curations.filter((c) => c.taskKey === task.key);
    expect(mine).toHaveLength(2);
    expect(mine.every((c) => c.reviewer === 'codex' && c.workspace === 'default' && c.disposition === 'overridden')).toBe(true);
    expect(mine.every((c) => c.reopened === false && c.failed === false)).toBe(true);
  });

  it('carries the forwarded split and flags a task that later failed', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2, 'codex') }, at(95));
    reviewRequestChanges(db, task.key, {
      feedback: '[reviewer-codex] Finding 1',
      curation: { reviewer: 'codex', dispositions: [
        { severity: 'warning', file: 'src/x.ts', line: 1, title: 'Finding 1', disposition: 'forwarded' },
        { severity: 'warning', file: 'src/x.ts', line: 2, title: 'Finding 2', disposition: 'dismissed' },
      ] },
    }, at(100));
    // a CI failure note lands on the task
    addComment(db, task.key, { actor: 'agent', body: 'failure/v1 — build broke\n```json\n{"reason":"ci_failed","detail":"x","source":"watcher"}\n```' }, at(160));

    const mine = analyticsRows(db, at(999)).curations.filter((c) => c.taskKey === task.key);
    expect(mine.map((c) => c.disposition).sort()).toEqual(['dismissed', 'forwarded']);
    expect(mine.every((c) => c.failed === true)).toBe(true);
  });
});

describe('analyticsRows aiReviewFindings', () => {
  const findFindings = (db: ReturnType<typeof makeTestDb>, key: string) =>
    analyticsRows(db, at(999)).tasks.find((t) => t.key === key)!.aiReviewFindings;

  it('is null for a done task with no AI review (excluded from override rate)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBeNull();
  });

  it('is 0 for a clean approval', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(0) }, at(95));
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBe(0);
  });

  it('is > 0 when approved past open findings (an override)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBe(2);
  });

  it('is null when a resubmission superseded the review (pending at approval, excluded)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));
    reviewRequestChanges(db, task.key, { feedback: 'fix it' }, at(100));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(110));
    submitResult(db, task.key, { summary: 'fixed' }, at(120));
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBeNull();
  });

  it('snapshots the verdict at the final approval after a request-changes round', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: reviewBody(2) }, at(95));
    reviewRequestChanges(db, task.key, { feedback: 'address the AI findings' }, at(100));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(110));
    submitResult(db, task.key, { summary: 'fixed' }, at(120));
    addComment(db, task.key, { actor: 'agent', body: reviewBody(0) }, at(125));
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBe(0);
  });
});
