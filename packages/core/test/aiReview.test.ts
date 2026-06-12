import { describe, it, expect } from 'vitest';
import { parseAiReview, findingsAtApproval } from '../src/aiReview.js';
import type { ActivityStep } from '../src/metrics.js';

describe('parseAiReview', () => {
  it('returns null for a comment without the marker', () => {
    expect(parseAiReview('looks good to me')).toBeNull();
    expect(parseAiReview('the ai-review: was clean')).toBeNull(); // marker must start the body
  });

  it('detects the marker case-insensitively and tolerates leading whitespace', () => {
    expect(parseAiReview('AI-Review: clean')).toEqual({ findings: 0 });
    expect(parseAiReview('   ai-review: clean')).toEqual({ findings: 0 });
  });

  it('counts findings from an embedded JSON findings array', () => {
    const body = [
      'ai-review: 2 findings — changes requested',
      '{ "version": 1, "verdict": "changes", "findings": [',
      '  { "severity": "warning", "title": "a" },',
      '  { "severity": "info", "title": "b" } ] }',
    ].join('\n');
    expect(parseAiReview(body)).toEqual({ findings: 2 });
  });

  it('accepts a numeric findings field', () => {
    expect(parseAiReview('ai-review: see below\n{"findings": 3}')).toEqual({ findings: 3 });
    expect(parseAiReview('ai-review:\n{"findings": 0}')).toEqual({ findings: 0 });
  });

  it('falls back to the first-line count when JSON is absent or malformed', () => {
    expect(parseAiReview('ai-review: 4 findings')).toEqual({ findings: 4 });
    expect(parseAiReview('ai-review: 1 finding found\n{ not json')).toEqual({ findings: 1 });
  });

  it('treats a marker with no parseable count as clean (advisory zero)', () => {
    expect(parseAiReview('ai-review: looks good')).toEqual({ findings: 0 });
    expect(parseAiReview('ai-review:')).toEqual({ findings: 0 });
  });
});

describe('findingsAtApproval', () => {
  const sc = (fromStatus: string | null, toStatus: string | null, body = ''): ActivityStep =>
    ({ type: 'status_change', fromStatus: fromStatus as never, toStatus: toStatus as never, createdAt: '', body });
  const comment = (body: string): ActivityStep =>
    ({ type: 'comment', fromStatus: null, toStatus: null, createdAt: '', body });

  it('returns null when no ai-review comment precedes the approval', () => {
    expect(findingsAtApproval([
      sc('queued', 'in_progress'),
      sc('in_progress', 'in_review'),
      comment('nice work'),
      sc('in_review', 'done'),
    ])).toBeNull();
  });

  it('snapshots the latest ai-review findings standing at the approval', () => {
    expect(findingsAtApproval([
      sc('in_progress', 'in_review'),
      comment('ai-review: 2 findings\n{"findings":[1,2]}'),
      sc('in_review', 'done'),
    ])).toBe(2);
  });

  it('uses the verdict at the final approval after a request-changes round', () => {
    // AI flags 2 → human requests changes → agent fixes → AI clean → approved
    expect(findingsAtApproval([
      comment('ai-review: 2 findings\n{"findings":[1,2]}'),
      sc('in_review', 'queued'),
      sc('queued', 'in_progress'),
      sc('in_progress', 'in_review'),
      comment('ai-review: clean'),
      sc('in_review', 'done'),
    ])).toBe(0);
  });

  it('returns null for a task that is not yet done', () => {
    expect(findingsAtApproval([
      sc('in_progress', 'in_review'),
      comment('ai-review: 1 finding\n{"findings":[1]}'),
    ])).toBeNull();
  });
});
