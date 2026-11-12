import { describe, it, expect } from 'vitest';
import { needsYou, canQuickApprove } from '../../client/src/needsYou.js';
import type { Task, FailureSummary, AiReviewSummary, DeliverySummary } from '../../client/src/types.js';

const NOW = Date.parse('2030-01-01T12:00:00Z');
const ago = (min: number) => new Date(NOW - min * 60000).toISOString();

function task(key: string, over: Partial<Task>): Task {
  return {
    id: 1, key, title: key, status: 'backlog', stage: 'implementation', kind: 'code', spec: 's', acceptanceCriteria: 'a',
    resultSummary: null, seq: 1, workspace: 'default', claimedBy: null, claimedAt: null, archivedAt: null,
    aiReview: null, failure: null, delivery: null, unmetDependencyCount: 0,
    createdAt: ago(600), updatedAt: ago(60), ...over,
  } as Task;
}
const review = (verdict: AiReviewSummary['verdict'], binding: AiReviewSummary['binding'] = 'current'): AiReviewSummary =>
  ({ verdict, findings: verdict === 'findings' ? 2 : 0, reviewer: 'codex', items: [], binding });
const failure = (over: Partial<FailureSummary> = {}): FailureSummary =>
  ({ reason: 'timeout', detail: 'timed out after 60m', source: 'dispatcher', attempt: 3, maxAttempts: 3, skipListed: true, at: ago(90), ...over });
const delivery = (over: Partial<DeliverySummary> = {}): DeliverySummary =>
  ({ provider: 'github', branch: 'b', prUrl: 'https://github.com/o/r/pull/1', prId: '1', prState: 'open', checksState: 'pending', failing: [],
    checkedAt: ago(1), stateChangedAt: ago(5), ...over });

const kinds = (tasks: Task[]) => needsYou(tasks, NOW).map((n) => `${n.task.key}:${n.kind}`);

describe('needsYou', () => {
  it('lists blocked tasks as questions, with the agent decision when it asked one', () => {
    const decision = { question: 'Which?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], recommended: 'a' };
    const items = needsYou([
      task('AF-1', { status: 'blocked', block: { reason: 'stuck', decision, at: ago(300) } }),
      task('AF-2', { status: 'blocked', block: { reason: 'needs a password', decision: null, at: ago(10) } }),
    ], NOW);
    expect(items.map((n) => n.kind)).toEqual(['question', 'question']);
    expect(items[0]!.since).toBe(ago(300));
  });

  it('includes implementation reviews once the AI review has spoken, and pr-reviews always', () => {
    expect(kinds([
      task('AF-1', { status: 'in_review', aiReview: review('clean') }),
      task('AF-2', { status: 'in_review', aiReview: review('pending'), updatedAt: ago(5) }),
      task('AF-3', { status: 'in_review', kind: 'pr-review' }),
    ])).toEqual(['AF-1:review', 'AF-3:review']);
  });

  it('includes a review whose AI review never arrived after 30 minutes, or that no review can prove', () => {
    expect(kinds([
      task('AF-1', { status: 'in_review', aiReview: null, updatedAt: ago(45) }),
      task('AF-2', { status: 'in_review', aiReview: review('pending', 'unverified'), updatedAt: ago(1) }),
    ])).toEqual(['AF-1:review', 'AF-2:review']);
  });

  it('includes a doc-stage review only when the AI review found something', () => {
    expect(kinds([
      task('AF-1', { status: 'in_review', stage: 'description', aiReview: review('findings') }),
      task('AF-2', { status: 'in_review', stage: 'description', aiReview: review('pending'), updatedAt: ago(5) }),
    ])).toEqual(['AF-1:review']);
  });

  it('splits out-of-attempts failures from setup problems', () => {
    expect(kinds([
      task('AF-1', { status: 'queued', failure: failure() }),
      task('AF-2', { status: 'queued', failure: failure({ reason: 'spawn_failed', detail: 'missing CLI' }) }),
      task('AF-3', { status: 'queued', failure: failure({ skipListed: false, attempt: 1 }) }),
    ])).toEqual(['AF-1:attempts', 'AF-2:setup']);
  });

  it('includes stuck deliveries: failing checks, a long wait, or a spent repair budget', () => {
    expect(kinds([
      task('AF-1', { status: 'delivering', delivery: delivery({ checksState: 'failing' }) }),
      task('AF-2', { status: 'delivering', delivery: delivery({ stateChangedAt: ago(90) }) }),
      task('AF-3', { status: 'delivering', delivery: delivery() }),
      task('AF-4', { status: 'delivering', delivery: delivery({ repairExhausted: true }) }),
    ])).toEqual(['AF-4:attempts', 'AF-2:delivery', 'AF-1:delivery']);
  });

  it('includes backlog tasks Task Intelligence refuses to queue', () => {
    expect(kinds([
      task('AF-1', { status: 'backlog', queueGate: { action: 'block', reasons: [{ code: 'outcome_unclear', message: 'unclear' }] } }),
      task('AF-2', { status: 'backlog', queueGate: { action: 'allow', reasons: [] } }),
    ])).toEqual(['AF-1:spec']);
  });

  it('leaves out running, queued, done, cancelled and archived work', () => {
    expect(needsYou([
      task('AF-1', { status: 'in_progress' }), task('AF-2', { status: 'queued' }), task('AF-3', { status: 'done' }),
      task('AF-4', { status: 'cancelled', failure: failure() }), task('AF-5', { status: 'blocked', archivedAt: ago(1) }),
    ], NOW)).toEqual([]);
  });

  it('orders questions before reviews before the rest, oldest first within a kind', () => {
    expect(kinds([
      task('AF-1', { status: 'in_review', aiReview: review('clean'), updatedAt: ago(10) }),
      task('AF-2', { status: 'blocked', block: { reason: 'x', decision: null, at: ago(5) } }),
      task('AF-3', { status: 'in_review', aiReview: review('clean'), updatedAt: ago(200) }),
    ])).toEqual(['AF-2:question', 'AF-3:review', 'AF-1:review']);
  });
});

describe('canQuickApprove', () => {
  const brief = (over: object = {}) => ({ counts: { must: 0, call: 0, should: 0, fyi: 0, merged: 0, rejected: 0 },
    criteria: [{ id: 'AC1', name: null, text: 't', status: 'clear', issueIds: [] }], ...over }) as unknown as NonNullable<Task['reviewBrief']>;
  const ready = task('AF-1', { status: 'in_review', aiReview: review('clean'), reviewBrief: brief(), submission: { id: 3, headSha: 'a41c9e2ffff' } });

  it('allows an inline approve only for a clean, current, fully met implementation review with a known head', () => {
    expect(canQuickApprove(ready)).toBe(true);
    expect(canQuickApprove({ ...ready, aiReview: review('findings') })).toBe(false);
    expect(canQuickApprove({ ...ready, aiReview: review('clean', 'stale') })).toBe(false);
    expect(canQuickApprove({ ...ready, submission: { id: 3, headSha: null } })).toBe(false);
    expect(canQuickApprove({ ...ready, stage: 'description' })).toBe(false);
    expect(canQuickApprove({ ...ready, reviewBrief: brief({ criteria: [{ id: 'AC1', name: null, text: 't', status: 'your_call', issueIds: [] }] }) })).toBe(false);
    expect(canQuickApprove({ ...ready, reviewBrief: brief({ counts: { must: 0, call: 1, should: 0, fyi: 0, merged: 0, rejected: 0 } }) })).toBe(false);
  });
});
