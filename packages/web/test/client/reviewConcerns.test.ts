import { describe, it, expect } from 'vitest';
import { remainingConcerns } from '../../client/src/reviewConcerns.js';
import type { ReviewBrief, ReviewIssue, TaskDetailView } from '../../client/src/types.js';

const issue = (id: string, group: ReviewIssue['group']): ReviewIssue => ({
  id, group, dispute: null, title: `Issue ${id}`, problem: null, fix: null, file: null, line: null,
  criteria: null, source: 'codex', opinions: [], merged: [],
});

function brief(issues: ReviewIssue[] = [], over: Partial<ReviewBrief> = {}): ReviewBrief {
  const count = (g: ReviewIssue['group']) => issues.filter((i) => i.group === g).length;
  return {
    headline: issues.length === 0 ? 'clean' : count('must') > 0 ? 'changes_needed' : count('call') > 0 ? 'your_call' : 'minor',
    reviewers: ['codex'], headSha: null,
    counts: { must: count('must'), call: count('call'), should: count('should'), fyi: count('fyi'), merged: 0, rejected: 0 },
    issues, rejected: [], criteria: [], generalCriteria: null, unlinked: 0, ...over,
  };
}

function task(over: Partial<TaskDetailView> = {}): TaskDetailView {
  return {
    id: 150, key: 'AF-150', title: 't', spec: 's', acceptanceCriteria: '1. A — a',
    status: 'in_review', stage: 'implementation', kind: 'code', resultSummary: 'done', seq: 1, workspace: 'agentfactory',
    unmetDependencyCount: 0, claimedBy: null, claimedAt: null, archivedAt: null,
    aiReview: null, reviewBrief: brief(), failure: null, delivery: null,
    createdAt: 't', updatedAt: 'u', activity: [], links: [], attachments: [], dependencies: [], dependents: [],
    repoPath: '.', branch: null, plan: null, originalSpec: null, originalAcceptanceCriteria: null, policy: null,
    verifyCommand: null, hasVisualization: false, visualizationGeneratedAt: null,
    metrics: { queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0, deliveringMin: 0, rounds: 0, reopened: false, claimCount: 0, doneAt: null, model: null, tokensIn: null, tokensOut: null, costUsd: null },
    criteriaClaims: null,
    ...over,
  } as TaskDetailView;
}

const submission = (over: Partial<NonNullable<TaskDetailView['submission']>> = {}): NonNullable<TaskDetailView['submission']> => ({
  id: 7, stage: 'implementation', executionId: null, branch: 'b', headSha: 'a'.repeat(40), baseSha: null, contentHash: null,
  source: 'origin', observedAt: 't', createdAt: 't', lastObservation: null, freshness: 'current', ...over,
});

const delivery = (prState: NonNullable<TaskDetailView['delivery']>['prState']): NonNullable<TaskDetailView['delivery']> => ({
  provider: 'github', branch: 'b', prUrl: null, prId: null, prState, checksState: 'pending', failing: [], checkedAt: null, stateChangedAt: 't',
});

describe('remainingConcerns', () => {
  it('a clean in-review task has none', () => {
    expect(remainingConcerns(task())).toEqual([]);
  });

  it('counts must-fix issues', () => {
    expect(remainingConcerns(task({ reviewBrief: brief([issue('F1', 'must')]) }))).toEqual(['1 must-fix issue']);
    expect(remainingConcerns(task({ reviewBrief: brief([issue('F1', 'must'), issue('F2', 'must')]) }))).toEqual(['2 must-fix issues']);
  });

  it('puts a stale submission first', () => {
    const t = task({
      reviewBrief: brief([issue('F1', 'must')]),
      submission: submission({ freshness: 'stale', lastObservation: { headSha: 'def5678', source: 'git', observedAt: 't2', error: null } }),
    });
    expect(remainingConcerns(t)).toEqual([
      'The branch moved to def5678 after this submission. Approval is blocked until the new revision is submitted and reviewed — request changes.',
      '1 must-fix issue',
    ]);
  });

  it('lists the failure note before blocked', () => {
    const failure = { reason: 'timeout', detail: null, source: 'dispatcher', attempt: 1, maxAttempts: 3, skipListed: false, at: 't' };
    expect(remainingConcerns(task({ status: 'blocked', failure }))).toEqual(['Failed: timeout', 'Blocked']);
  });

  it('a delivering task waits for its PR to merge', () => {
    expect(remainingConcerns(task({ status: 'delivering', delivery: delivery('open') }))).toEqual(['PR not merged yet']);
    expect(remainingConcerns(task({ status: 'delivering', delivery: delivery('merged') }))).toEqual([]);
  });

  it('keeps the fixed order across every kind of concern', () => {
    const t = task({
      status: 'blocked',
      failure: { reason: 'crash', detail: null, source: 'dispatcher', attempt: 1, maxAttempts: 3, skipListed: false, at: 't' },
      submission: submission({ freshness: 'unknown', lastObservation: { headSha: null, source: 'git', observedAt: 't2', error: 'origin unreachable' } }),
      aiReview: { binding: 'stale' } as TaskDetailView['aiReview'],
      reviewBrief: brief([issue('F1', 'must'), issue('F2', 'call'), issue('F3', 'call')], {
        criteria: [{ id: 'AC1', name: 'Race', text: 'x', status: 'not_met', issueIds: ['F1'] }, { id: 'AC2', name: null, text: 'y', status: 'clear', issueIds: [] }],
      }),
    });
    expect(remainingConcerns(t)).toEqual([
      'Revision freshness unknown: origin unreachable. Approving records that.',
      'This AI review is for an older revision.',
      '1 must-fix issue',
      '2 issues need your decision',
      'Criteria not met: AC1 Race',
      'Failed: crash',
      'Blocked',
    ]);
  });

  it('a decided your-call issue no longer counts, and a pending review asks for no decisions', () => {
    const b = brief([issue('F2', 'call'), issue('F3', 'call')]);
    expect(remainingConcerns(task({ reviewBrief: b }), { F2: 'must' })).toEqual(['1 issue needs your decision']);
    expect(remainingConcerns(task({ reviewBrief: { ...b, headline: 'pending' } }))).toEqual([]);
  });
});
