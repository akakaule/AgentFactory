import { describe, it, expect } from 'vitest';
import {
  isAiReviewMarker,
  parseAiReviewComment,
  summarizeAiReview,
  findingsAtApproval,
} from '../src/aiReview.js';
import type { ActivityStep } from '../src/metrics.js';

const review = (summary: string, json: object): string =>
  `ai-review/v1 — ${summary}\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\``;

describe('isAiReviewMarker', () => {
  it('recognises the v1 marker case-insensitively, tolerating leading whitespace', () => {
    expect(isAiReviewMarker('ai-review/v1 clean')).toBe(true);
    expect(isAiReviewMarker('AI-Review/v1 — 2 findings')).toBe(true);
    expect(isAiReviewMarker('   ai-review/v1\n{}')).toBe(true);
  });

  it('rejects non-markers and the obsolete prefix', () => {
    expect(isAiReviewMarker('looks good to me')).toBe(false);
    expect(isAiReviewMarker('ai-review: 2 findings')).toBe(false); // the round-1 prefix is gone
    expect(isAiReviewMarker('the ai-review/v1 was clean')).toBe(false); // must start the body
    expect(isAiReviewMarker('ai-review/v10 future')).toBe(false); // word-boundary guards v1
  });

  it('is true for a marked comment even when its JSON is malformed (kept out of the agent brief)', () => {
    expect(isAiReviewMarker('ai-review/v1 see notes\n{ not json')).toBe(true);
  });
});

describe('parseAiReviewComment', () => {
  it('returns null for a comment without the marker', () => {
    expect(parseAiReviewComment('looks good')).toBeNull();
    expect(parseAiReviewComment('ai-review: 2 findings\n{"findings":[1,2]}')).toBeNull();
  });

  it('parses reviewer + findings from a fenced JSON block', () => {
    const body = review('2 findings', {
      reviewer: 'codex',
      verdict: 'findings',
      findings: [
        { severity: 'warning', file: 'src/x.ts', line: 42, title: 'Unbounded retry loop', detail: 'no cap' },
        { severity: 'info', title: 'Missing test' },
      ],
    });
    const parsed = parseAiReviewComment(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.reviewer).toBe('codex');
    expect(parsed!.findings).toHaveLength(2);
    expect(parsed!.findings[0]).toEqual({ severity: 'warning', file: 'src/x.ts', line: 42, title: 'Unbounded retry loop', detail: 'no cap' });
    expect(parsed!.findings[1]).toEqual({ severity: 'info', file: null, line: null, title: 'Missing test', detail: null });
  });

  it('parses a bare (un-fenced) JSON object too', () => {
    const parsed = parseAiReviewComment('ai-review/v1 clean\n{"reviewer":"claude","verdict":"clean","findings":[]}');
    expect(parsed).toEqual({ reviewer: 'claude', findings: [] });
  });

  it('drops findings with no title and ignores unknown severities', () => {
    const parsed = parseAiReviewComment(review('x', { findings: [{ title: 'kept', severity: 'critical' }, { detail: 'no title' }] }));
    expect(parsed!.findings).toEqual([{ severity: null, file: null, line: null, title: 'kept', detail: null }]);
  });

  it('degrades to null when the JSON is malformed or lacks a findings array', () => {
    expect(parseAiReviewComment('ai-review/v1 oops\n{ not json')).toBeNull();
    expect(parseAiReviewComment('ai-review/v1 no array\n{"verdict":"clean"}')).toBeNull();
    expect(parseAiReviewComment('ai-review/v1 just text, no json at all')).toBeNull();
  });
});

describe('summarizeAiReview', () => {
  const parsed = (n: number) => ({ reviewer: 'codex', findings: Array.from({ length: n }, (_, i) => ({ severity: null, file: null, line: null, title: `f${i}`, detail: null })) });

  it('returns null for no review', () => {
    expect(summarizeAiReview(null, false)).toBeNull();
  });

  it('reads clean at zero findings, findings at N>0', () => {
    expect(summarizeAiReview(parsed(0), false)).toMatchObject({ verdict: 'clean', findings: 0, reviewer: 'codex' });
    expect(summarizeAiReview(parsed(3), false)).toMatchObject({ verdict: 'findings', findings: 3 });
  });

  it('reads pending when superseded by a newer result, carrying the stale items', () => {
    const s = summarizeAiReview(parsed(2), true);
    expect(s!.verdict).toBe('pending');
    expect(s!.findings).toBe(2);
    expect(s!.items).toHaveLength(2);
  });
});

describe('findingsAtApproval', () => {
  const sc = (fromStatus: string | null, toStatus: string | null): ActivityStep =>
    ({ type: 'status_change', fromStatus: fromStatus as never, toStatus: toStatus as never, createdAt: '' });
  const result = (): ActivityStep => ({ type: 'result', fromStatus: null, toStatus: null, createdAt: '', body: 'done' });
  const comment = (body: string): ActivityStep => ({ type: 'comment', fromStatus: null, toStatus: null, createdAt: '', body });
  const findings = (n: number) => review(`${n} findings`, { findings: Array.from({ length: n }, (_, i) => ({ title: `f${i}` })) });

  it('returns null when no ai-review comment precedes the approval', () => {
    expect(findingsAtApproval([
      sc('in_progress', 'in_review'), result(), comment('nice work'), sc('in_review', 'done'),
    ])).toBeNull();
  });

  it('snapshots the latest ai-review findings standing at the approval', () => {
    expect(findingsAtApproval([
      sc('in_progress', 'in_review'), result(), comment(findings(2)), sc('in_review', 'done'),
    ])).toBe(2);
  });

  it('uses the clean verdict at the final approval after a request-changes round', () => {
    expect(findingsAtApproval([
      result(), comment(findings(2)),
      sc('in_review', 'queued'), sc('queued', 'in_progress'), sc('in_progress', 'in_review'),
      result(), comment(review('clean', { findings: [] })), sc('in_review', 'done'),
    ])).toBe(0);
  });

  it('returns null when a newer result superseded the last review (pending at approval, excluded)', () => {
    expect(findingsAtApproval([
      result(), comment(findings(2)),
      sc('in_review', 'queued'), sc('queued', 'in_progress'), sc('in_progress', 'in_review'),
      result(), // resubmitted, not yet re-reviewed
      sc('in_review', 'done'),
    ])).toBeNull();
  });

  it('returns null for a task that is not yet done', () => {
    expect(findingsAtApproval([
      sc('in_progress', 'in_review'), result(), comment(findings(1)),
    ])).toBeNull();
  });
});
