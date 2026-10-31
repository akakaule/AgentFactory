import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { addTaskMetrics } from '../src/ops/addTaskMetrics.js';
import { getTask } from '../src/ops/getTask.js';
import { estimatePastCosts, PAST_COST_CACHED_SHARE } from '../src/ops/estimatePastCosts.js';

describe('task cost split', () => {
  it('splits the reported cost per model, most expensive first, leaving unpriced models out', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addTaskMetrics(db, task.key, { model: 'claude-opus-5-5', tokensIn: 100, tokensOut: 10, costUsd: 3, reportedBy: 'otel:claude-code' });
    addTaskMetrics(db, task.key, { model: 'claude-opus-5-5', tokensIn: 50, tokensOut: 5, costUsd: 1.75, reportedBy: 'otel:claude-code' });
    addTaskMetrics(db, task.key, { model: 'gpt-6.1-sol', tokensIn: 40, tokensOut: 4, costUsd: 0.39, reportedBy: 'otel:codex' });
    addTaskMetrics(db, task.key, { model: 'gpt-6-sol', tokensIn: 30, tokensOut: 3, reportedBy: 'otel:codex' }); // unpriced
    addTaskMetrics(db, task.key, { costUsd: 0.1 }); // cost-only, no model

    const m = getTask(db, task.key).metrics;
    expect(m.costUsd).toBeCloseTo(5.24);
    expect(m.costEstimated).toBe(false);
    expect(m.costByModel).toEqual([
      { model: 'claude-opus-5-5', costUsd: 4.75, estimated: false },
      { model: 'gpt-6.1-sol', costUsd: 0.39, estimated: false },
      { model: null, costUsd: 0.1, estimated: false },
    ]);
  });

  it('carries cost on each breakdown row and reads Claude Code reports as Claude', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addTaskMetrics(db, task.key, { model: 'claude-opus-5-5', tokensIn: 100, tokensOut: 10, costUsd: 3, reportedBy: 'otel:claude-code' });
    addTaskMetrics(db, task.key, { model: 'gpt-6-sol', tokensIn: 30, tokensOut: 3, reportedBy: 'otel:codex' });

    expect(getTask(db, task.key).metrics.tokenBreakdown).toEqual([
      { stage: null, agent: 'claude', model: 'claude-opus-5-5', tokensIn: 100, tokensOut: 10, costUsd: 3, costEstimated: false },
      { stage: null, agent: 'codex', model: 'gpt-6-sol', tokensIn: 30, tokensOut: 3, costUsd: null, costEstimated: false },
    ]);
  });
});

describe('estimatePastCosts', () => {
  const prices = { 'gpt-6-sol': { input: 2, cachedInput: 0.2, output: 10 } };

  it('prices unpriced usage of priced models as an estimate, assuming most input was cached', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addTaskMetrics(db, task.key, { model: 'gpt-6-sol', tokensIn: 1_000_000, tokensOut: 100_000, reportedBy: 'otel:codex' });
    addTaskMetrics(db, task.key, { model: 'gpt-6-sol', tokensIn: 10, tokensOut: 1, costUsd: 0.5, reportedBy: 'otel:codex' }); // already priced
    addTaskMetrics(db, task.key, { model: 'mystery-model', tokensIn: 500, tokensOut: 5 }); // no price
    addTaskMetrics(db, task.key, { model: 'gpt-6-sol' }); // no tokens

    expect(PAST_COST_CACHED_SHARE).toBe(0.9);
    // 100k uncached × $2 + 900k cached × $0.20 + 100k out × $10, per 1M
    expect(estimatePastCosts(db, prices)).toEqual({ rows: 1, usd: 1.38 });

    const m = getTask(db, task.key).metrics;
    expect(m.costUsd).toBeCloseTo(1.88);
    expect(m.costEstimated).toBe(true);
    expect(m.costByModel).toEqual([{ model: 'gpt-6-sol', costUsd: 1.88, estimated: true }]);
    expect(m.tokenBreakdown!.find((r) => r.model === 'gpt-6-sol')).toMatchObject({ costUsd: 1.88, costEstimated: true });

    expect(estimatePastCosts(db, prices)).toEqual({ rows: 0, usd: 0 }); // idempotent
  });
});
