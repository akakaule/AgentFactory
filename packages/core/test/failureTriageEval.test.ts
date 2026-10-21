import { describe, it, expect } from 'vitest';
import { FAILURE_TRIAGE_CATEGORIES } from '../src/failureTriage.js';
import { parseFailureComment, buildFailureComment } from '../src/failure.js';
import { classifyCase, classifyReasonOnly, computeMetrics, type Prediction } from './fixtures/failure-triage/evaluate.js';
import { TUNING } from './fixtures/failure-triage/corpus/tuning.js';
import { HELDOUT } from './fixtures/failure-triage/corpus/heldout.js';
import type { CorpusTag } from './fixtures/failure-triage/corpus/types.js';

describe('failure-triage evaluation metrics', () => {
  it('computes the spec §10 metrics on a hand-checked result set', () => {
    const p = (label: Prediction['label'], predicted: Prediction['predicted'], ruleId: string | null): Prediction =>
      ({ id: `${label}-${predicted}`, family: 'f', label, predicted, ruleId });
    const m = computeMetrics([
      p('access', 'access', 'access/a'),     // displayed, right
      p('access', 'unknown', null),          // abstained on a real cause
      p('unknown', 'build_test', 'build/b'), // displayed, wrong (a truly-unknown case got a label)
      p('build_test', 'build_test', 'build/b'),
      p('unknown', 'unknown', null),
    ]);
    expect(m.total).toBe(5);
    expect(m.displayed).toBe(3);
    expect(m.displayedCorrect).toBe(2);
    expect(m.displayedPrecision).toBeCloseTo(2 / 3);
    expect(m.coverage).toBeCloseTo(0.6);
    expect(m.abstention).toBeCloseTo(0.4);
    expect(m.causal).toBe(3);
    expect(m.causalRecall).toBeCloseTo(2 / 3);
    expect(m.unknownMislabeled).toBe(1);
    expect(m.confusion.access.unknown).toBe(1);
    expect(m.confusion.unknown.build_test).toBe(1);
    expect(m.perCategory.build_test).toEqual({ support: 1, predicted: 2, correct: 1 });
    expect(m.perRule).toEqual({ 'access/a': { fired: 1, correct: 1 }, 'build/b': { fired: 2, correct: 1 } });
  });

  it('reports a null precision when nothing is displayed', () => {
    const m = computeMetrics([{ id: 'x', family: 'f', label: 'access', predicted: 'unknown', ruleId: null }]);
    expect(m.displayedPrecision).toBeNull();
    expect(m.coverage).toBe(0);
  });

  it('maps only explicit reasons in the reason-only baseline', () => {
    const one = (reason: string) => classifyReasonOnly({ id: reason, family: 'f', label: 'unknown', why: '', notes: [{ source: 'watcher', reason, detail: 'd' }] }).predicted;
    expect(one('permission_denied')).toBe('access');
    expect(one('merge_conflict')).toBe('delivery');
    expect(one('pr_closed')).toBe('delivery');
    expect(['crashed', 'timeout', 'stale', 'ci_failed', 'review_failed', 'max_attempts'].map(one)).toEqual(Array(6).fill('unknown'));
  });

  it('classifies through the max_attempts episode rule', () => {
    const crash = { source: 'dispatcher' as const, reason: 'crashed', detail: 'session exited', attempt: 2, maxAttempts: 2, body: 'Log tail:\n```\nbash: dotnet: command not found\n```' };
    const max = { source: 'dispatcher' as const, reason: 'max_attempts', detail: 'reached maxAttempts (2)', attempt: 2, maxAttempts: 2 };
    expect(classifyCase({ id: 'a', family: 'f', label: 'configuration', why: '', notes: [crash, max] }).predicted).toBe('configuration');
    expect(classifyCase({ id: 'b', family: 'f', label: 'unknown', why: '', notes: [crash, max], sameEpisode: false }).predicted).toBe('unknown');
  });
});

describe('failure-triage corpus shape (spec §10)', () => {
  const all = [...TUNING, ...HELDOUT];

  it('has at least 100 cases with unique ids', () => {
    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it('has at least ten cases per category and twenty ambiguous/unknown cases', () => {
    for (const category of FAILURE_TRIAGE_CATEGORIES) expect(all.filter((c) => c.label === category).length, category).toBeGreaterThanOrEqual(10);
    expect(all.filter((c) => c.label === 'unknown' || c.tags?.includes('ambiguous')).length).toBeGreaterThanOrEqual(20);
  });

  it('holds out at least 40 cases with every category represented', () => {
    expect(HELDOUT.length).toBeGreaterThanOrEqual(40);
    for (const category of FAILURE_TRIAGE_CATEGORIES) expect(HELDOUT.some((c) => c.label === category), category).toBe(true);
  });

  it('never splits a scenario family across tuning and held-out', () => {
    const tuningFamilies = new Set(TUNING.map((c) => c.family));
    expect(HELDOUT.filter((c) => tuningFamilies.has(c.family)).map((c) => c.id)).toEqual([]);
  });

  it('covers every required scenario kind', () => {
    const required: CorpusTag[] = ['ambiguous', 'disguised-credential', 'bare-timeout', 'max-attempts', 'truncated', 'prompt-like', 'mixed', 'missing-log'];
    for (const tag of required) expect(all.some((c) => c.tags?.includes(tag)), tag).toBe(true);
  });

  it('stores only parseable failure notes in writer shape', () => {
    for (const c of all) {
      for (const n of c.notes) {
        const body = buildFailureComment({ reason: n.reason, detail: n.detail, source: n.source, ...(n.attempt !== undefined ? { attempt: n.attempt } : {}), ...(n.maxAttempts !== undefined ? { maxAttempts: n.maxAttempts } : {}), ...(n.body !== undefined ? { body: n.body } : {}) });
        expect(parseFailureComment(body)?.reason, c.id).toBe(n.reason);
      }
    }
  });
});
