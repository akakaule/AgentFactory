import { describe, it, expect } from 'vitest';
import { chipText, opinionVerdict, reviewerShortName, reviewSentence, shortNames } from '../../client/src/reviewText.js';
import { af146Brief, v1Brief } from './fixtures/reviewBrief.js';

describe('reviewer names', () => {
  it('shortens to the part before the slash, capitalized', () => {
    expect(reviewerShortName('claude/claude-fable-5-1')).toBe('Claude');
    expect(reviewerShortName('codex/gpt-6-astra (medium)')).toBe('Codex');
    expect(reviewerShortName('codex')).toBe('Codex');
  });
  it('falls back to the full names when two short names collide', () => {
    expect([...shortNames(['claude/a', 'codex/b']).values()]).toEqual(['Claude', 'Codex']);
    expect([...shortNames(['claude/a', 'claude/b']).values()]).toEqual(['claude/a', 'claude/b']);
  });
});

describe('reviewSentence', () => {
  it('AF-146 with criterion links names the unmet criteria and why the rest are your call', () => {
    expect(reviewSentence(af146Brief({ links: true }))).toBe(
      '2 must-fix issues: AC4 Race and AC6 Liveness aren\'t met. 3 more need your decision: both reviewers agree they\'re real but not on how serious. 2 should-fix.');
  });
  it('says when the reviewers disagree whether something is a problem, and reads singular counts', () => {
    const brief = af146Brief();
    const one = { ...brief, headline: 'your_call' as const, counts: { ...brief.counts, must: 0, should: 0 },
      issues: [{ ...brief.issues.find((i) => i.group === 'call')!, dispute: 'validity' as const }], criteria: [] };
    expect(reviewSentence(one)).toBe('1 needs your decision: the reviewers disagree whether it\'s a problem.');
  });
  it('pending, clean and minor-only reviews', () => {
    expect(reviewSentence(af146Brief({ superseded: true }))).toBe('The reviewer hasn\'t looked at the latest result yet. The issues below are from the previous review.');
    expect(reviewSentence(v1Brief([]))).toBe('Codex found nothing to fix.');
    expect(reviewSentence({ ...v1Brief([]), reviewers: ['claude/a', 'codex/b'] })).toBe('Both reviewers found nothing to fix.');
    expect(reviewSentence(v1Brief([{ severity: 'warning', file: null, line: null, title: 'Slow', detail: null }, { severity: 'info', file: null, line: null, title: 'Naming', detail: null }])))
      .toBe('Nothing blocks approval: 1 should-fix, 1 FYI.');
    expect(reviewSentence(v1Brief([{ severity: 'error', file: null, line: null, title: 'Broken', detail: null, criteria: ['AC2'] }])))
      .toBe('1 must-fix issue: AC2 Logs isn\'t met.');
  });
});

describe('chipText', () => {
  it('per headline', () => {
    expect(chipText(af146Brief())).toEqual({ label: 'Changes needed', detail: '2 must fix · 3 your call' });
    expect(chipText({ ...af146Brief(), headline: 'your_call' })).toEqual({ label: 'Your call · 3', detail: null });
    expect(chipText(v1Brief([{ severity: 'warning', file: null, line: null, title: 'Slow', detail: null }]))).toEqual({ label: 'Minor issues · 1', detail: null });
    expect(chipText(v1Brief([]))).toEqual({ label: 'No issues found', detail: null });
    expect(chipText(af146Brief({ superseded: true }))).toEqual({ label: 'Review pending', detail: null });
  });
});

describe('opinionVerdict', () => {
  it('reads each decision', () => {
    const o = { reviewer: 'x', reason: null, evidence: 'e' };
    expect(opinionVerdict({ ...o, decision: 'confirm', severity: 'warning' }, 'Claude')).toBe('Claude rates it Should fix');
    expect(opinionVerdict({ ...o, decision: 'reject', severity: 'error' }, 'Codex')).toBe('Codex: not a problem');
    expect(opinionVerdict({ ...o, decision: 'uncertain', severity: null }, 'Codex')).toBe('Codex: unsure');
  });
});
