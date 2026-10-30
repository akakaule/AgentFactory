import { describe, it, expect } from 'vitest';
import { computeAnalytics, computeSpend, fmtDur, fmtNum, fmtUsd, median, monthLabel, niceTicks, providerOf, recentMonths, shortBranch, PROVIDER_COLORS, SERIES_COLORS, type AnalyticsTaskRow, type AnalyticsData, type SpendMonth, type SpendRow } from '../../client/src/metrics.js';

const NOW = Date.parse('2026-06-11T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

let seq = 0;
function doneRow(over: Partial<AnalyticsTaskRow> = {}): AnalyticsTaskRow {
  seq += 1;
  return {
    key: `AF-${seq}`, title: `Task ${seq}`, workspace: 'demo', status: 'done', doneAt: daysAgo(1),
    queueMin: 20, workMin: 40, reviewMin: 60, blockedMin: 0, deliveringMin: 0,
    rounds: 0, reopened: false, claimCount: 1, worker: 'worker-1', branch: `feature/AF-${seq}-t`,
    stageTokens: { implementation: 12000 },
    model: 'claude-fable-5', tokensIn: 10000, tokensOut: 2000, costUsd: 0.5,
    aiReviewFindings: null,
    ...over,
  };
}
const data = (tasks: AnalyticsTaskRow[], stranded: AnalyticsData['stranded'] = [], failures: AnalyticsData['failures'] = []): AnalyticsData => ({ tasks, stranded, failures });

describe('helpers', () => {
  it('fmtDur formats minutes, hours, days, n/a', () => {
    expect(fmtDur(null)).toBe('n/a');
    expect(fmtDur(38)).toBe('38m');
    expect(fmtDur(72)).toBe('1.2h');
    expect(fmtDur(2880)).toBe('2d');
  });
  it('median handles empties and even counts', () => {
    expect(median([])).toBeNull();
    expect(median([1, 3])).toBe(2);
    expect(median([1, 2, 9])).toBe(2);
  });
  it('fmtNum abbreviates', () => {
    expect(fmtNum(950)).toBe('950');
    expect(fmtNum(41000)).toBe('41k');
    expect(fmtNum(1200000)).toBe('1.2M');
  });
  it('shortBranch drops the feature/ prefix', () => {
    expect(shortBranch('feature/AF-12-do-thing')).toBe('AF-12-do-thing');
    expect(shortBranch('weird-branch')).toBe('weird-branch');
  });
});

describe('computeAnalytics', () => {
  it('aggregates KPIs over the range with a delta vs the previous window', () => {
    const a = computeAnalytics(data([
      doneRow({ doneAt: daysAgo(1), rounds: 0 }),
      doneRow({ doneAt: daysAgo(2), rounds: 1 }),
      doneRow({ doneAt: daysAgo(10) }),                       // previous 7d window
    ]), 'all', 7, NOW);
    expect(a.hasData).toBe(true);
    expect(a.kpis.done).toBe(2);
    expect(a.kpis.delta).toBe(1); // 2 now vs 1 in the prior window
    expect(a.kpis.firstPass).toMatchObject({ n: 1, d: 2, rate: 50 });
    expect(a.kpis.work).toBe(40);
    expect(a.kpis.cycle).toBe(20 + 40 + 60);
  });

  it('filters by workspace and range', () => {
    const a = computeAnalytics(data([
      doneRow({ workspace: 'demo' }),
      doneRow({ workspace: 'shop' }),
      doneRow({ workspace: 'demo', doneAt: daysAgo(40) }),
    ]), 'demo', 30, NOW);
    expect(a.kpis.done).toBe(1);
    const all = computeAnalytics(data([doneRow({ doneAt: daysAgo(40) })]), 'all', null, NOW);
    expect(all.kpis.done).toBe(1); // "All" = no cutoff
  });

  it('keeps cost honest under partial coverage', () => {
    const a = computeAnalytics(data([
      doneRow({ costUsd: 1.0, tokensIn: 10000, tokensOut: 1000, model: 'claude-fable-5' }),
      doneRow({ costUsd: null, tokensIn: null, tokensOut: null, model: null }),
    ]), 'all', 7, NOW);
    expect(a.kpis.cost).toMatchObject({ per: 1.0, reported: 1, total: 2 });
    expect(a.tokenCoverage).toMatchObject({ reported: 1, total: 2 });
  });

  it('reports stage medians and the dominant stage', () => {
    const a = computeAnalytics(data([
      doneRow({ queueMin: 10, workMin: 30, reviewMin: 100, blockedMin: 0 }),
      doneRow({ queueMin: 20, workMin: 50, reviewMin: 140, blockedMin: 10, deliveringMin: 0 }),
    ]), 'all', 7, NOW);
    const byKey = Object.fromEntries(a.stages.map((s) => [s.key, s.val]));
    expect(byKey).toMatchObject({ queue: 15, work: 40, review: 120, blocked: 5 });
    expect(a.dominant.key).toBe('review');
  });

  it('computes the AI override rate, excluding tasks with no AI review present', () => {
    const a = computeAnalytics(data([
      doneRow({ aiReviewFindings: 2 }),    // approved past findings → override
      doneRow({ aiReviewFindings: 0 }),    // clean approval
      doneRow({ aiReviewFindings: 1 }),    // override
      doneRow({ aiReviewFindings: null }), // no AI review → excluded from n AND d
    ]), 'all', 7, NOW);
    // d = 3 reviewed (the null is excluded), n = 2 overrides → 67%
    expect(a.kpis.override).toMatchObject({ n: 2, d: 3, rate: 67 });
  });

  it('reports a zero override rate when every AI review was clean', () => {
    const a = computeAnalytics(data([
      doneRow({ aiReviewFindings: 0 }),
      doneRow({ aiReviewFindings: 0 }),
    ]), 'all', 7, NOW);
    expect(a.kpis.override).toMatchObject({ n: 0, d: 2, rate: 0 });
  });

  it('leaves the override denominator at zero when no task had an AI review (n/a, never zero)', () => {
    const a = computeAnalytics(data([
      doneRow({ aiReviewFindings: null }),
      doneRow({ aiReviewFindings: null }),
    ]), 'all', 7, NOW);
    expect(a.kpis.override).toMatchObject({ n: 0, d: 0, rate: 0 });
  });

  it('buckets review round-trips', () => {
    const a = computeAnalytics(data([
      doneRow({ rounds: 0 }), doneRow({ rounds: 0 }), doneRow({ rounds: 1 }), doneRow({ rounds: 3 }),
    ]), 'all', 7, NOW);
    expect(a.rounds).toEqual({ first: 2, one: 1, two: 1 });
  });

  it('sums tokens by model, sorted descending', () => {
    const a = computeAnalytics(data([
      doneRow({ model: 'claude-haiku-4-5', tokensIn: 1000, tokensOut: 100 }),
      doneRow({ model: 'claude-fable-5', tokensIn: 50000, tokensOut: 5000 }),
      doneRow({ model: 'claude-fable-5', tokensIn: 20000, tokensOut: 2000 }),
    ]), 'all', 7, NOW);
    expect(a.tokensByModel).toEqual([
      { model: 'claude-fable-5', tokens: 77000 },
      { model: 'claude-haiku-4-5', tokens: 1100 },
    ]);
  });

  it('sums tokens by workspace, counting only reported tasks, sorted descending', () => {
    const a = computeAnalytics(data([
      doneRow({ workspace: 'demo', tokensIn: 50000, tokensOut: 5000 }),
      doneRow({ workspace: 'demo', tokensIn: 20000, tokensOut: 2000 }),
      doneRow({ workspace: 'demo', tokensIn: null, tokensOut: null, model: null }), // mixed: unreported, excluded from the bar
      doneRow({ workspace: 'shop', tokensIn: 1000, tokensOut: 100 }),
    ]), 'all', 7, NOW);
    expect(a.tokensByWorkspace).toEqual([
      { workspace: 'demo', tokens: 77000 }, // only the two reported demo tasks; the unreported one is excluded, never zero
      { workspace: 'shop', tokens: 1100 },
    ]);
    expect(a.tokWsMax).toBe(77000);
    // coverage spans both groupings identically: 3 of 4 done tasks reported usage
    expect(a.tokenCoverage).toMatchObject({ reported: 3, total: 4 });
  });

  it('sums tokens by branch, bucketing branchless reported tasks into (unlabeled), sorted descending', () => {
    const a = computeAnalytics(data([
      doneRow({ branch: 'feature/AF-1-a', tokensIn: 50000, tokensOut: 5000 }),
      doneRow({ branch: 'feature/AF-1-a', tokensIn: 20000, tokensOut: 2000 }),
      doneRow({ branch: 'feature/AF-2-b', tokensIn: 1000, tokensOut: 100 }),
      doneRow({ branch: null, tokensIn: 3000, tokensOut: 0 }),                        // doc-stage/legacy → (unlabeled)
      doneRow({ branch: 'feature/AF-3-c', tokensIn: null, tokensOut: null, model: null }), // unreported → excluded
    ]), 'all', 7, NOW);
    expect(a.tokensByBranch).toEqual([
      { branch: 'feature/AF-1-a', tokens: 77000 },
      { branch: '(unlabeled)', tokens: 3000 },
      { branch: 'feature/AF-2-b', tokens: 1100 },
    ]);
    expect(a.tokBranchMax).toBe(77000);
  });

  it('sums tokens by the stage they were reported in, sorted descending', () => {
    const a = computeAnalytics(data([
      doneRow({ tokensIn: 50000, tokensOut: 5000, stageTokens: { implementation: 50000, plan: 5000 } }),
      doneRow({ tokensIn: 1000, tokensOut: 100, stageTokens: { description: 1100 } }),
      doneRow({ tokensIn: null, tokensOut: null, model: null, stageTokens: {} }), // unreported → excluded
    ]), 'all', 7, NOW);
    expect(a.tokensByStage).toEqual([
      { stage: 'implementation', tokens: 50000 },
      { stage: 'plan', tokens: 5000 },
      { stage: 'description', tokens: 1100 },
    ]);
    expect(a.tokStageMax).toBe(50000);
  });

  it('tolerates rows missing stageTokens (stale server build)', () => {
    const a = computeAnalytics(data([
      { ...doneRow({ tokensIn: 7000, tokensOut: 0 }), stageTokens: undefined } as unknown as AnalyticsTaskRow,
    ]), 'all', 7, NOW);
    expect(a.tokensByStage).toEqual([]);
    expect(a.tokStageMax).toBe(1);
  });

  it('respects the workspace + range filters for tokensByWorkspace', () => {
    const a = computeAnalytics(data([
      doneRow({ workspace: 'demo', tokensIn: 50000, tokensOut: 5000 }),
      doneRow({ workspace: 'shop', tokensIn: 1000, tokensOut: 100 }),
      doneRow({ workspace: 'demo', doneAt: daysAgo(40), tokensIn: 9000, tokensOut: 9000 }), // out of range
    ]), 'demo', 7, NOW);
    expect(a.tokensByWorkspace).toEqual([{ workspace: 'demo', tokens: 55000 }]);
    expect(a.tokWsMax).toBe(55000);
  });

  it('leaves tokensByWorkspace empty (max 1) when nothing reported', () => {
    const a = computeAnalytics(data([
      doneRow({ tokensIn: null, tokensOut: null, model: null }),
    ]), 'all', 7, NOW);
    expect(a.tokensByWorkspace).toEqual([]);
    expect(a.tokWsMax).toBe(1);
  });

  it('rolls up tokens and cost per workspace, sorted by cost, unreported shown as null', () => {
    const a = computeAnalytics(data([
      doneRow({ workspace: 'demo', tokensIn: 50000, tokensOut: 5000, costUsd: 1.5 }),
      doneRow({ workspace: 'demo', tokensIn: 20000, tokensOut: 2000, costUsd: 0.5 }),
      doneRow({ workspace: 'demo', tokensIn: null, tokensOut: null, costUsd: null, model: null }), // unreported: counted as done, not as zero spend
      doneRow({ workspace: 'shop', tokensIn: 1000, tokensOut: 100, costUsd: 4 }),
      doneRow({ workspace: 'docs', tokensIn: 3000, tokensOut: 300, costUsd: null }), // tokens without a price
      doneRow({ workspace: 'idle', tokensIn: null, tokensOut: null, costUsd: null, model: null }),
      doneRow({ workspace: 'shop', doneAt: daysAgo(40), costUsd: 99 }), // out of range
    ]), 'all', 7, NOW);
    expect(a.workspaceSpend).toEqual([
      { workspace: 'shop', done: 1, reported: 1, tokensIn: 1000, tokensOut: 100, tokens: 1100, cost: 4, costReported: 1, costPerTask: 4 },
      { workspace: 'demo', done: 3, reported: 2, tokensIn: 70000, tokensOut: 7000, tokens: 77000, cost: 2, costReported: 2, costPerTask: 1 },
      { workspace: 'docs', done: 1, reported: 1, tokensIn: 3000, tokensOut: 300, tokens: 3300, cost: null, costReported: 0, costPerTask: null },
      { workspace: 'idle', done: 1, reported: 0, tokensIn: null, tokensOut: null, tokens: null, cost: null, costReported: 0, costPerTask: null },
    ]);
  });

  it('limits workspaceSpend to the selected workspace', () => {
    const a = computeAnalytics(data([
      doneRow({ workspace: 'demo', costUsd: 1 }),
      doneRow({ workspace: 'shop', costUsd: 2 }),
    ]), 'demo', 7, NOW);
    expect(a.workspaceSpend.map((w) => w.workspace)).toEqual(['demo']);
  });

  it('lists done tasks in range with their spend, most expensive first, unreported last', () => {
    const a = computeAnalytics(data([
      doneRow({ key: 'AF-1', title: 'Cheap', workspace: 'demo', tokensIn: 1000, tokensOut: 100, costUsd: 0.1 }),
      doneRow({ key: 'AF-2', title: 'Pricey', workspace: 'shop', tokensIn: 90000, tokensOut: 9000, costUsd: 3 }),
      doneRow({ key: 'AF-3', title: 'Silent', tokensIn: null, tokensOut: null, costUsd: null, model: null }),
      doneRow({ key: 'AF-4', title: 'Unpriced', tokensIn: 5000, tokensOut: 500, costUsd: null }),
      doneRow({ key: 'AF-5', doneAt: daysAgo(40), costUsd: 99 }), // out of range
      { ...doneRow({ key: 'AF-6', costUsd: 50 }), status: 'in_progress', doneAt: null }, // not done
    ]), 'all', 7, NOW);
    expect(a.taskSpend.map((t) => t.key)).toEqual(['AF-2', 'AF-1', 'AF-4', 'AF-3']);
    expect(a.taskSpend[0]).toEqual({
      key: 'AF-2', title: 'Pricey', workspace: 'shop', doneAt: daysAgo(1),
      tokensIn: 90000, tokensOut: 9000, tokens: 99000, cost: 3,
    });
    expect(a.taskSpend[3]).toMatchObject({ tokensIn: null, tokensOut: null, tokens: null, cost: null });
  });

  it('limits taskSpend to the selected workspace and tolerates rows without a title', () => {
    const a = computeAnalytics(data([
      { ...doneRow({ key: 'AF-1', workspace: 'demo' }), title: undefined } as unknown as AnalyticsTaskRow,
      doneRow({ key: 'AF-2', workspace: 'shop' }),
    ]), 'demo', 7, NOW);
    expect(a.taskSpend).toHaveLength(1);
    expect(a.taskSpend[0]).toMatchObject({ key: 'AF-1', title: '' });
  });

  it('builds a throughput series covering the window', () => {
    const a = computeAnalytics(data([doneRow({ doneAt: new Date(NOW - 2 * 3600000).toISOString() })]), 'all', 7, NOW);
    expect(a.throughput).toHaveLength(7);
    expect(a.throughput[6]!.count).toBe(1); // today is the last bucket
    expect(a.tpMax).toBe(1);
  });

  it('flags the empty state', () => {
    expect(computeAnalytics(data([]), 'all', 7, NOW).hasData).toBe(false);
    expect(computeAnalytics(data([doneRow({ doneAt: daysAgo(40) })]), 'all', 7, NOW).hasData).toBe(false);
  });

  it('aggregates failures by reason, labelled and within range/workspace', () => {
    const a = computeAnalytics(
      data([doneRow()], [], [
        { reason: 'timeout', workspace: 'default', at: new Date(NOW - 3600000).toISOString() },
        { reason: 'timeout', workspace: 'default', at: new Date(NOW - 7200000).toISOString() },
        { reason: 'crashed', workspace: 'default', at: new Date(NOW - 7200000).toISOString() },
        { reason: 'timeout', workspace: 'repo-a', at: new Date(NOW - 7200000).toISOString() }, // other workspace
        { reason: 'crashed', workspace: 'default', at: daysAgo(40) }, // out of range
      ]),
      'default', 7, NOW,
    );
    expect(a.failures.total).toBe(3); // two timeouts + one crash in default within 7d
    expect(a.failures.byReason[0]).toEqual({ reason: 'timeout', label: 'Timed out', count: 2 });
    expect(a.failures.byReason[1]).toEqual({ reason: 'crashed', label: 'Crashed', count: 1 });
    expect(a.failures.max).toBe(2);
  });

  it('tolerates a payload with no failures field (stale server)', () => {
    const a = computeAnalytics({ tasks: [doneRow()], stranded: [] } as unknown as AnalyticsData, 'all', 7, NOW);
    expect(a.failures.total).toBe(0);
  });
});

describe('spend', () => {
  const row = (over: Partial<SpendRow>): SpendRow => ({
    date: '2026-10-01', workspace: 'demo', model: 'claude-opus-5-5', costUsd: 0, tokens: 0, unpricedTokens: 0, ...over,
  });
  const month = (rows: SpendRow[], m = '2026-10'): SpendMonth => ({ month: m, dataUpTo: rows.length ? '2026-10-30T11:00:00.000Z' : null, rows });

  it('maps models to providers', () => {
    expect(providerOf('claude-opus-5-5')).toBe('Anthropic');
    expect(providerOf('claude-opus-4-8[1m]')).toBe('Anthropic');
    expect(providerOf('gpt-6.1-sol')).toBe('OpenAI');
    expect(providerOf('GPT-5 Codex')).toBe('OpenAI');
    expect(providerOf('gpt-5-codex')).toBe('OpenAI');
    expect(providerOf('mistral-large')).toBe('Other');
    expect(providerOf(null)).toBe('Other');
  });

  it('lists the current UTC month and the previous ones, labelled', () => {
    expect(recentMonths(Date.parse('2026-01-15T00:00:00.000Z'), 3)).toEqual(['2026-01', '2025-12', '2025-11']);
    expect(monthLabel('2026-10')).toBe('Oct 2026');
  });

  it('formats dollars with cents and thousands separators', () => {
    expect(fmtUsd(9314.04)).toBe('$9,314.04');
    expect(fmtUsd(0)).toBe('$0.00');
  });

  it('picks nice ticks that cover the max', () => {
    expect(niceTicks(520)).toEqual([0, 150, 300, 450, 600]);
    expect(niceTicks(0.8)).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(niceTicks(0)).toEqual([0]);
  });

  it('splits cost by provider in fixed order, zero-fills every day of the month, and keeps unpriced tokens apart', () => {
    const v = computeSpend(month([
      row({ date: '2026-10-01', model: 'gpt-6.1-sol', costUsd: 0.25, tokens: 110, unpricedTokens: 77 }),
      row({ date: '2026-10-01', model: 'claude-opus-5-5', costUsd: 2, tokens: 160 }),
      row({ date: '2026-10-03', model: 'claude-fable-5', costUsd: 1, tokens: 40 }),
    ]), 'provider', 'cost', []);

    expect(v.total).toBe(3.25);
    expect(v.series).toEqual([
      { key: 'Anthropic', color: PROVIDER_COLORS.Anthropic, value: 3 },
      { key: 'OpenAI', color: PROVIDER_COLORS.OpenAI, value: 0.25 },
    ]);
    expect(v.days).toHaveLength(31);
    expect(v.days[0]).toEqual({ date: '2026-10-01', values: { Anthropic: 2, OpenAI: 0.25 }, total: 2.25 });
    expect(v.days[1]).toEqual({ date: '2026-10-02', values: {}, total: 0 });
    expect(v.days[30]!.date).toBe('2026-10-31');
    expect(v.unpricedTokens).toBe(77);
    expect(v.max).toBe(v.ticks.at(-1));
  });

  it('measures tokens instead of cost, so unpriced usage still counts', () => {
    const v = computeSpend(month([
      row({ model: 'gpt-6.1-sol', costUsd: 0, tokens: 110, unpricedTokens: 110 }),
      row({ model: 'claude-opus-5-5', costUsd: 2, tokens: 160 }),
    ]), 'provider', 'tokens', []);
    expect(v.total).toBe(270);
    expect(v.series.map((s) => [s.key, s.value])).toEqual([['Anthropic', 160], ['OpenAI', 110]]);
  });

  it('drops providers whose total is zero in the chosen metric', () => {
    const v = computeSpend(month([row({ model: 'gpt-6.1-sol', tokens: 110, unpricedTokens: 110 })]), 'provider', 'cost', []);
    expect(v.series).toEqual([]);
    expect(v.total).toBe(0);
    expect(v.unpricedTokens).toBe(110);
  });

  it('splits by workspace in board order, giving each a fixed color and folding past seven into Other', () => {
    const names = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8', 'w9'];
    const v = computeSpend(month(names.map((workspace, i) => row({ workspace, costUsd: i + 1 }))), 'workspace', 'cost', [...names].reverse());
    expect(v.series.map((s) => s.key)).toEqual(['w9', 'w8', 'w7', 'w6', 'w5', 'w4', 'w3', 'Other']);
    expect(v.series[0]).toEqual({ key: 'w9', color: SERIES_COLORS[0], value: 9 });
    expect(v.series.at(-1)).toEqual({ key: 'Other', color: 'var(--ink-3)', value: 3 }); // w2 + w1
    expect(v.days[0]!.values.Other).toBe(3);
  });

  it('places workspaces the board does not list after the known ones, alphabetically', () => {
    const v = computeSpend(month([
      row({ workspace: 'zeta', costUsd: 1 }), row({ workspace: 'alpha', costUsd: 1 }), row({ workspace: 'known', costUsd: 1 }),
    ]), 'workspace', 'cost', ['known']);
    expect(v.series.map((s) => s.key)).toEqual(['known', 'alpha', 'zeta']);
  });
});
