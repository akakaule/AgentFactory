import { describe, it, expect } from 'vitest';
import { computeAnalytics, fmtDur, fmtNum, median, shortBranch, type AnalyticsTaskRow, type AnalyticsData } from '../../client/src/metrics.js';

const NOW = Date.parse('2026-06-11T12:00:00.000Z');
const daysAgo = (d: number) => new Date(NOW - d * 86400000).toISOString();

let seq = 0;
function doneRow(over: Partial<AnalyticsTaskRow> = {}): AnalyticsTaskRow {
  seq += 1;
  return {
    key: `AF-${seq}`, workspace: 'demo', status: 'done', doneAt: daysAgo(1),
    queueMin: 20, workMin: 40, reviewMin: 60, blockedMin: 0,
    rounds: 0, reopened: false, claimCount: 1, worker: 'worker-1', branch: `feature/AF-${seq}-t`,
    stageTokens: { implementation: 12000 },
    model: 'claude-fable-5', tokensIn: 10000, tokensOut: 2000, costUsd: 0.5,
    aiReviewFindings: null,
    ...over,
  };
}
const data = (
  tasks: AnalyticsTaskRow[],
  stranded: AnalyticsData['stranded'] = [],
  failures: AnalyticsData['failures'] = [],
  curations: AnalyticsData['curations'] = [],
): AnalyticsData => ({ tasks, stranded, failures, curations });

let cseq = 0;
function curation(over: Partial<AnalyticsData['curations'][number]> = {}): AnalyticsData['curations'][number] {
  cseq += 1;
  return { reviewer: 'codex', workspace: 'demo', disposition: 'forwarded', taskKey: `AF-${cseq}`, at: daysAgo(1), reopened: false, failed: false, ...over };
}

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
      doneRow({ queueMin: 20, workMin: 50, reviewMin: 140, blockedMin: 10 }),
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

  it('groups workers, excludes null workers, and rolls stranded releases into "(unlabeled)"', () => {
    const a = computeAnalytics(data([
      doneRow({ worker: 'worker-1', rounds: 0 }),
      doneRow({ worker: 'worker-1', rounds: 1 }),
      doneRow({ worker: null }),                                   // counts toward coverage, no row
      { ...doneRow({ worker: 'worker-2' }), status: 'in_progress', doneAt: null },
    ], [
      { worker: 'worker-2', workspace: 'demo', at: daysAgo(1) },
      { worker: null, workspace: 'demo', at: daysAgo(2) },
    ]), 'all', 7, NOW);

    const w1 = a.workers.find((w) => w.name === 'worker-1')!;
    expect(w1).toMatchObject({ done: 2, claims: 2, firstPass: 50, releases: 0 });
    const w2 = a.workers.find((w) => w.name === 'worker-2')!;
    expect(w2).toMatchObject({ done: 0, claims: 2, releases: 1 }); // 1 in-progress + 1 release
    const unl = a.workers.find((w) => w.name === '(unlabeled)')!;
    expect(unl).toMatchObject({ releases: 1 });
    expect(a.workers.some((w) => w.name === '' || w.name === null)).toBe(false);
  });

  it('derives each worker branch from its first branch-bearing task (done, else in-progress)', () => {
    const a = computeAnalytics(data([
      doneRow({ worker: 'worker-1', branch: 'feature/AF-9-thing' }),
      doneRow({ worker: 'worker-2', branch: null }),                                              // branchless task → null
      { ...doneRow({ worker: 'worker-3', branch: 'feature/AF-11-wip' }), status: 'in_progress', doneAt: null },
    ]), 'all', 7, NOW);
    expect(a.workers.find((w) => w.name === 'worker-1')!.branch).toBe('feature/AF-9-thing');
    expect(a.workers.find((w) => w.name === 'worker-2')!.branch).toBeNull();
    expect(a.workers.find((w) => w.name === 'worker-3')!.branch).toBe('feature/AF-11-wip');      // from the in-progress task
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

  describe('reviewer precision', () => {
    it('derives per-engine precision = forwarded / all dispositioned findings', () => {
      const a = computeAnalytics(data([doneRow()], [], [], [
        curation({ reviewer: 'codex', disposition: 'forwarded' }),
        curation({ reviewer: 'codex', disposition: 'forwarded' }),
        curation({ reviewer: 'codex', disposition: 'dismissed' }),
        curation({ reviewer: 'codex', disposition: 'overridden' }),
        curation({ reviewer: 'claude', disposition: 'forwarded' }),
      ]), 'all', 7, NOW);
      const codex = a.reviewerPrecision.find((r) => r.reviewer === 'codex')!;
      expect(codex).toMatchObject({ forwarded: 2, dismissed: 1, overridden: 1, total: 4 });
      expect(codex.precision).toBeCloseTo(0.5);
      const claude = a.reviewerPrecision.find((r) => r.reviewer === 'claude')!;
      expect(claude).toMatchObject({ forwarded: 1, total: 1, precision: 1 });
      // sorted by total desc → codex first
      expect(a.reviewerPrecision[0]!.reviewer).toBe('codex');
    });

    it('correlates forwarded findings with reopened/failed tasks, deduped per task', () => {
      const a = computeAnalytics(data([doneRow()], [], [], [
        // task A: two forwarded findings, task later reopened → counts once
        curation({ reviewer: 'codex', taskKey: 'AF-A', disposition: 'forwarded', reopened: true }),
        curation({ reviewer: 'codex', taskKey: 'AF-A', disposition: 'forwarded', reopened: true }),
        // task B: forwarded, task failed CI → counts once
        curation({ reviewer: 'codex', taskKey: 'AF-B', disposition: 'forwarded', failed: true }),
        // task C: forwarded, clean → not counted
        curation({ reviewer: 'codex', taskKey: 'AF-C', disposition: 'forwarded' }),
        // a dismissed finding on a reopened task does NOT count (only forwarded correlate)
        curation({ reviewer: 'codex', taskKey: 'AF-D', disposition: 'dismissed', reopened: true }),
      ]), 'all', 7, NOW);
      const codex = a.reviewerPrecision.find((r) => r.reviewer === 'codex')!;
      expect(codex.tasksForwarded).toBe(3); // A, B, C
      expect(codex.fwdReopenedOrFailed).toBe(2); // A + B
    });

    it('labels a null reviewer as (unattributed) and filters by workspace + range', () => {
      const a = computeAnalytics(data([doneRow()], [], [], [
        curation({ reviewer: null, workspace: 'demo' }),
        curation({ reviewer: 'codex', workspace: 'shop' }),      // other workspace → excluded
        curation({ reviewer: 'codex', workspace: 'demo', at: daysAgo(40) }), // out of range → excluded
      ]), 'demo', 7, NOW);
      expect(a.reviewerPrecision).toHaveLength(1);
      expect(a.reviewerPrecision[0]!.reviewer).toBe('(unattributed)');
    });

    it('tolerates a payload with no curations field (stale server)', () => {
      const a = computeAnalytics({ tasks: [doneRow()], stranded: [], failures: [] } as unknown as AnalyticsData, 'all', 7, NOW);
      expect(a.reviewerPrecision).toEqual([]);
    });
  });
});
