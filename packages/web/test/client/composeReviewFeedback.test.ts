import { describe, it, expect } from 'vitest';
import { composeReviewFeedback, defaultDecisions, selectedIssues } from '../../client/src/composeReviewFeedback.js';
import { af146Brief, v1Brief } from './fixtures/reviewBrief.js';

describe('defaultDecisions', () => {
  it('preselects must and should issues; your-call and FYI start undecided; a pending review decides nothing', () => {
    expect(defaultDecisions(af146Brief())).toEqual({ F1: 'must', F6: 'must', F2: 'should', F4: 'should' });
    expect(defaultDecisions(v1Brief([{ severity: 'info', file: null, line: null, title: 'Naming', detail: null }]))).toEqual({});
    expect(defaultDecisions(af146Brief({ superseded: true }))).toEqual({});
  });
});

describe('composeReviewFeedback', () => {
  const brief = af146Brief({ links: true });

  it('sends exactly the issues decided Must fix or Should fix, each with criteria, location, problem and fix, then the note', () => {
    const body = composeReviewFeedback(brief, { F1: 'must', F6: 'dismiss', F3: 'must', F2: 'should' }, '  Keep the API stable.  ');
    const f1 = brief.issues.find((i) => i.id === 'F1')!;
    expect(body).toBe([
      'Changes requested after the AI review of 4699e45 (Claude + Codex), curated by a human.',
      '',
      '## Must fix',
      '',
      `1. F1 · AC6 · ${f1.title} (packages/dispatcher/src/dispatcher.ts:253)`,
      `   Problem: ${f1.problem!.split('\n').join('\n   ')}`,
      '   Fix: Fix for F1.',
      `2. F3 · AC5 · ${brief.issues.find((i) => i.id === 'F3')!.title} (${brief.issues.find((i) => i.id === 'F3')!.file}:${brief.issues.find((i) => i.id === 'F3')!.line})`,
      `   Problem: ${brief.issues.find((i) => i.id === 'F3')!.problem!.split('\n').join('\n   ')}`,
      '   Fix: Fix for F3.',
      '',
      '## Should fix',
      '',
      `1. F2 · AC7 · ${brief.issues.find((i) => i.id === 'F2')!.title} (${brief.issues.find((i) => i.id === 'F2')!.file}:${brief.issues.find((i) => i.id === 'F2')!.line})`,
      `   Problem: ${brief.issues.find((i) => i.id === 'F2')!.problem!.split('\n').join('\n   ')}`,
      '   Fix: Fix for F2.',
      '',
      '## Note from the human reviewer',
      '',
      'Keep the API stable.',
    ].join('\n'));
    expect(body).not.toContain('F6');
    expect(body).not.toContain('F5'); // undecided
  });

  it('leaves out missing parts and empty sections, and the commit when it is unknown', () => {
    const plain = v1Brief([{ severity: 'error', file: null, line: null, title: 'Broken', detail: null }]);
    expect(composeReviewFeedback(plain, { F1: 'must' }, '')).toBe(
      'Changes requested after the AI review (Codex), curated by a human.\n\n## Must fix\n\n1. F1 · Broken');
  });

  it('with nothing decided, or no review at all, the body is the note alone', () => {
    expect(composeReviewFeedback(brief, { F1: 'dismiss' }, 'Only this.')).toBe('Only this.');
    expect(composeReviewFeedback(null, {}, '  Fix the tests  ')).toBe('Fix the tests');
    expect(composeReviewFeedback(null, {}, '   ')).toBe('');
  });

  it('selectedIssues lists what goes out in issue order', () => {
    expect(selectedIssues(brief, { F2: 'should', F1: 'must', F4: 'dismiss' }).map((s) => [s.issue.id, s.as])).toEqual([['F1', 'must'], ['F2', 'should']]);
  });
});
