import { describe, it, expect } from 'vitest';
import { reviewCloseRevision } from '../../client/src/status.js';
import type { Task, AiReviewSummary } from '../../client/src/types.js';
import type { ReviewRevision } from '@agentfactory/core';

const A = 'a'.repeat(40);
const review = (revision: ReviewRevision | null): AiReviewSummary =>
  ({ verdict: 'clean', findings: 0, reviewer: 'codex', items: [], binding: revision ? 'current' : 'legacy', revision });
const t = (over: Partial<Task> = {}): Task => ({
  id: 1, key: 'AF-1', title: 'T', spec: '', acceptanceCriteria: '',
  status: 'in_review', stage: 'implementation', kind: 'code', resultSummary: null, seq: 1,
  workspace: 'default', claimedBy: null, claimedAt: null, archivedAt: null,
  aiReview: null, failure: null, delivery: null, unmetDependencyCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('reviewCloseRevision', () => {
  it('a drag out of review names the submission and head the card review is bound to', () => {
    const task = t({ aiReview: review({ submissionId: 7, headSha: A }) });
    expect(reviewCloseRevision(task, 'done')).toEqual({ submissionId: 7, headSha: A });
    expect(reviewCloseRevision(task, 'delivering')).toEqual({ submissionId: 7, headSha: A });
  });

  it('names nothing for moves that are not approvals, or an unbound / absent review', () => {
    expect(reviewCloseRevision(t({ aiReview: review({ submissionId: 7, headSha: A }) }), 'queued')).toBeUndefined();
    expect(reviewCloseRevision(t({ status: 'delivering', aiReview: review({ submissionId: 7, headSha: A }) }), 'done')).toBeUndefined();
    expect(reviewCloseRevision(t({ aiReview: review(null) }), 'done')).toBeUndefined();
    expect(reviewCloseRevision(t(), 'done')).toBeUndefined();
  });
});
