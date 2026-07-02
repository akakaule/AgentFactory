/* Typed port of the claude-design analytics computation (analytics.jsx).
   Everything derives from the per-task rows GET /api/analytics ships. */

export interface AnalyticsTaskRow {
  key: string; workspace: string; status: string; doneAt: string | null;
  queueMin: number; workMin: number; reviewMin: number; blockedMin: number;
  rounds: number; reopened: boolean; claimCount: number; worker: string | null;
  branch: string | null; // server-named feature branch; null before the first implementation claim / legacy
  stageTokens: Record<string, number>; // tokens (in+out) per stage they were reported in
  model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
  aiReviewFindings: number | null; // findings at approval; null = no AI review present
}
export interface StrandedRelease { worker: string | null; workspace: string; at: string; }
export interface FailureEvent { reason: string; workspace: string; at: string; }
export interface AnalyticsData { tasks: AnalyticsTaskRow[]; stranded: StrandedRelease[]; failures: FailureEvent[]; }

/** Friendly labels for known supervisor failure reasons; unknown reasons render as-is. */
export const FAILURE_LABELS: Record<string, string> = {
  timeout: 'Timed out', crashed: 'Crashed', stale: 'Stale claim', permission_denied: 'Permission denied',
  max_attempts: 'Out of attempts', review_failed: 'Auto-review failed',
};

export type StageKey = 'queue' | 'work' | 'review' | 'blocked';
export interface Stage { key: StageKey; label: string; hue: string; val: number; }
export interface WorkerStats {
  name: string; ws: string; claims: number; done: number;
  firstPass: number | null; medWork: number | null; releases: number;
  tokens: number | null; cost: number | null; branch: string | null;
}
export interface ComputedAnalytics {
  hasData: boolean;
  kpis: {
    done: number; delta: number | null; cycle: number | null; work: number | null;
    firstPass: { n: number; d: number; rate: number };
    reopen: { n: number; d: number; rate: number };
    override: { n: number; d: number; rate: number };
    cost: { per: number | null; reported: number; total: number };
  };
  stages: Stage[]; stageTotal: number; dominant: Stage;
  throughput: Array<{ label: string; count: number }>; tpMax: number; tpDays: number;
  rounds: { first: number; one: number; two: number };
  tokensByModel: Array<{ model: string; tokens: number }>; tokMax: number;
  tokensByWorkspace: Array<{ workspace: string; tokens: number }>; tokWsMax: number;
  tokensByBranch: Array<{ branch: string; tokens: number }>; tokBranchMax: number;
  tokensByStage: Array<{ stage: string; tokens: number }>; tokStageMax: number;
  tokenCoverage: { reported: number; total: number };
  workers: WorkerStats[];
  failures: { byReason: Array<{ reason: string; label: string; count: number }>; total: number; max: number };
}

export const STAGES: Array<{ key: StageKey; field: keyof AnalyticsTaskRow; label: string; hue: string }> = [
  { key: 'queue', field: 'queueMin', label: 'Queue wait', hue: 'var(--st-queued)' },
  { key: 'work', field: 'workMin', label: 'Work', hue: 'var(--st-progress)' },
  { key: 'review', field: 'reviewMin', label: 'Review wait', hue: 'var(--st-review)' },
  { key: 'blocked', field: 'blockedMin', label: 'Blocked', hue: 'var(--st-blocked)' },
];

const UNLABELED = '(unlabeled)';
const cycleOf = (t: AnalyticsTaskRow) => t.queueMin + t.workMin + t.reviewMin + t.blockedMin;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);

export function median(arr: Array<number | null | undefined>): number | null {
  const a = arr.filter((x): x is number => typeof x === 'number' && !isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const mid = Math.floor(a.length / 2);
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

/** minutes → 38m / 1.2h / 2d; null → n/a */
export function fmtDur(min: number | null | undefined): string {
  if (min == null || isNaN(min)) return 'n/a';
  if (min < 1) return '0m';
  if (min < 60) return Math.round(min) + 'm';
  if (min < 1440) { const h = min / 60; return (h < 10 ? h.toFixed(1).replace(/\.0$/, '') : String(Math.round(h))) + 'h'; }
  const d = min / 1440;
  return (d < 10 ? d.toFixed(1).replace(/\.0$/, '') : String(Math.round(d))) + 'd';
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null) return 'n/a';
  if (n >= 1000000) return +(n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return +(n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k';
  return String(n);
}

/** Drop the constant `feature/` prefix for display; the task key already shows elsewhere. */
export const shortBranch = (b: string): string => b.replace(/^feature\//, '');

export function computeAnalytics(data: AnalyticsData, ws: string, rangeDays: number | null, now: number = Date.now()): ComputedAnalytics {
  const matchWs = (w: string) => ws === 'all' || w === ws;
  const cutoff = rangeDays ? now - rangeDays * 86400000 : -Infinity;
  const prevCutoff = rangeDays ? cutoff - rangeDays * 86400000 : null;
  const doneTs = (t: AnalyticsTaskRow) => Date.parse(t.doneAt!);

  const doneAll = data.tasks.filter((t) => t.status === 'done' && t.doneAt && matchWs(t.workspace));
  const doneIn = doneAll.filter((t) => doneTs(t) >= cutoff);
  const donePrev = prevCutoff === null ? [] : doneAll.filter((t) => doneTs(t) >= prevCutoff && doneTs(t) < cutoff);
  const inProg = data.tasks.filter((t) => t.status === 'in_progress' && t.worker && matchWs(t.workspace));
  const stranded = data.stranded
    .filter((s) => matchWs(s.workspace) && Date.parse(s.at) >= cutoff)
    .map((s) => ({ ...s, worker: s.worker ?? UNLABELED }));

  const N = doneIn.length;
  const firstPass = doneIn.filter((t) => t.rounds === 0).length;
  const reopened = doneIn.filter((t) => t.reopened).length;
  const costRep = doneIn.filter((t) => t.costUsd != null);
  const costSum = costRep.reduce((s, t) => s + (t.costUsd ?? 0), 0);
  // Override rate (Cloudflare's quality KPI): of done tasks that HAD an AI review,
  // how many were approved past open findings. Tasks with no AI review are excluded
  // from both n and d — never counted as a clean zero (n/m annotation discipline).
  const aiReviewed = doneIn.filter((t) => t.aiReviewFindings != null);
  const overrides = aiReviewed.filter((t) => (t.aiReviewFindings ?? 0) > 0);

  const kpis: ComputedAnalytics['kpis'] = {
    done: N,
    delta: rangeDays ? N - donePrev.length : null,
    cycle: median(doneIn.map(cycleOf)),
    work: median(doneIn.map((t) => t.workMin)),
    firstPass: { n: firstPass, d: N, rate: pct(firstPass, N) },
    reopen: { n: reopened, d: N, rate: pct(reopened, N) },
    override: { n: overrides.length, d: aiReviewed.length, rate: pct(overrides.length, aiReviewed.length) },
    cost: { per: costRep.length ? costSum / costRep.length : null, reported: costRep.length, total: N },
  };

  const stages: Stage[] = STAGES.map((s) => ({
    key: s.key, label: s.label, hue: s.hue,
    val: median(doneIn.map((t) => t[s.field] as number)) ?? 0,
  }));
  const stageTotal = stages.reduce((a, b) => a + b.val, 0) || 1;
  const dominant = stages.slice().sort((a, b) => b.val - a.val)[0]!;

  const tpDays = rangeDays ? Math.min(rangeDays, 30) : 14;
  const throughput: Array<{ label: string; count: number }> = [];
  for (let i = tpDays - 1; i >= 0; i--) {
    const dayStart = new Date(now - i * 86400000);
    dayStart.setHours(0, 0, 0, 0);
    const s = dayStart.getTime();
    const e = s + 86400000;
    const count = doneAll.filter((t) => doneTs(t) >= s && doneTs(t) < e).length;
    throughput.push({ label: String(dayStart.getDate()).padStart(2, '0'), count });
  }
  const tpMax = Math.max(1, ...throughput.map((d) => d.count));

  const rounds = {
    first: doneIn.filter((t) => t.rounds === 0).length,
    one: doneIn.filter((t) => t.rounds === 1).length,
    two: doneIn.filter((t) => t.rounds >= 2).length,
  };

  const tokRep = doneIn.filter((t) => t.tokensIn != null);
  const byModel: Record<string, number> = {};
  tokRep.forEach((t) => {
    const model = t.model ?? UNLABELED;
    byModel[model] = (byModel[model] ?? 0) + (t.tokensIn ?? 0) + (t.tokensOut ?? 0);
  });
  const tokensByModel = Object.entries(byModel).map(([model, tokens]) => ({ model, tokens })).sort((a, b) => b.tokens - a.tokens);
  const tokMax = Math.max(1, ...tokensByModel.map((x) => x.tokens));
  const byWorkspace: Record<string, number> = {};
  tokRep.forEach((t) => {
    byWorkspace[t.workspace] = (byWorkspace[t.workspace] ?? 0) + (t.tokensIn ?? 0) + (t.tokensOut ?? 0);
  });
  const tokensByWorkspace = Object.entries(byWorkspace).map(([workspace, tokens]) => ({ workspace, tokens })).sort((a, b) => b.tokens - a.tokens);
  const tokWsMax = Math.max(1, ...tokensByWorkspace.map((x) => x.tokens));
  // Per-branch token totals: tokens are read per-task on a PR-branch (feature) basis.
  // Reported tasks without a branch (doc stages / legacy) fall into UNLABELED, mirroring
  // the model grouping so the bars still sum to the coverage banner's reported total.
  const byBranch: Record<string, number> = {};
  tokRep.forEach((t) => {
    const branch = t.branch ?? UNLABELED;
    byBranch[branch] = (byBranch[branch] ?? 0) + (t.tokensIn ?? 0) + (t.tokensOut ?? 0);
  });
  const tokensByBranch = Object.entries(byBranch).map(([branch, tokens]) => ({ branch, tokens })).sort((a, b) => b.tokens - a.tokens);
  const tokBranchMax = Math.max(1, ...tokensByBranch.map((x) => x.tokens));
  // Per-stage token totals: each reported task's tokens split across the pipeline stages
  // (description → plan → implementation) they were spent in. `?? {}` tolerates a stale
  // server build that predates stageTokens.
  const byStage: Record<string, number> = {};
  tokRep.forEach((t) => {
    for (const [stage, tok] of Object.entries(t.stageTokens ?? {})) {
      byStage[stage] = (byStage[stage] ?? 0) + tok;
    }
  });
  const tokensByStage = Object.entries(byStage).map(([stage, tokens]) => ({ stage, tokens })).sort((a, b) => b.tokens - a.tokens);
  const tokStageMax = Math.max(1, ...tokensByStage.map((x) => x.tokens));
  const tokenCoverage = { reported: tokRep.length, total: N };

  const names = new Set<string>();
  doneIn.forEach((t) => { if (t.worker) names.add(t.worker); });
  inProg.forEach((t) => { if (t.worker) names.add(t.worker); });
  stranded.forEach((s) => names.add(s.worker));
  const workers: WorkerStats[] = [...names].map((name) => {
    const done = doneIn.filter((t) => t.worker === name);
    const claimsInProg = inProg.filter((t) => t.worker === name).length;
    const releases = stranded.filter((s) => s.worker === name).length;
    const fp = done.filter((t) => t.rounds === 0).length;
    const rep = done.filter((t) => t.costUsd != null);
    const ws0 = done[0]?.workspace ?? inProg.find((t) => t.worker === name)?.workspace
      ?? data.stranded.find((s) => (s.worker ?? UNLABELED) === name)?.workspace ?? '—';
    // worker is 1:1 with a task, so its first branch-bearing task is its feature branch
    const branch = done.find((t) => t.branch)?.branch
      ?? inProg.find((t) => t.worker === name && t.branch)?.branch ?? null;
    return {
      name, ws: ws0,
      claims: done.length + claimsInProg + releases,
      done: done.length,
      firstPass: done.length ? pct(fp, done.length) : null,
      medWork: median(done.map((t) => t.workMin)),
      releases,
      tokens: rep.length ? rep.reduce((s, t) => s + (t.tokensIn ?? 0) + (t.tokensOut ?? 0), 0) : null,
      cost: rep.length ? rep.reduce((s, t) => s + (t.costUsd ?? 0), 0) : null,
      branch,
    };
  }).sort((a, b) => b.done - a.done || b.claims - a.claims);

  // "Why tasks fail": every supervisor failure occurrence in range/workspace, by reason.
  // Tolerate a payload without `failures` (a stale server build that predates this field).
  const failByReason: Record<string, number> = {};
  (data.failures ?? [])
    .filter((f) => matchWs(f.workspace) && Date.parse(f.at) >= cutoff)
    .forEach((f) => { failByReason[f.reason] = (failByReason[f.reason] ?? 0) + 1; });
  const byReason = Object.entries(failByReason)
    .map(([reason, count]) => ({ reason, label: FAILURE_LABELS[reason] ?? reason, count }))
    .sort((a, b) => b.count - a.count);
  const failures = { byReason, total: byReason.reduce((s, r) => s + r.count, 0), max: Math.max(1, ...byReason.map((r) => r.count)) };

  return { hasData: N > 0, kpis, stages, stageTotal, dominant, throughput, tpMax, tpDays, rounds, tokensByModel, tokMax, tokensByWorkspace, tokWsMax, tokensByBranch, tokBranchMax, tokensByStage, tokStageMax, tokenCoverage, workers, failures };
}
