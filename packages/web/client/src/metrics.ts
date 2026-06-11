/* Typed port of the claude-design analytics computation (analytics.jsx).
   Everything derives from the per-task rows GET /api/analytics ships. */

export interface AnalyticsTaskRow {
  key: string; workspace: string; status: string; doneAt: string | null;
  queueMin: number; workMin: number; reviewMin: number; blockedMin: number;
  rounds: number; reopened: boolean; claimCount: number; worker: string | null;
  model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
}
export interface StrandedRelease { worker: string | null; workspace: string; at: string; }
export interface AnalyticsData { tasks: AnalyticsTaskRow[]; stranded: StrandedRelease[]; }

export type StageKey = 'queue' | 'work' | 'review' | 'blocked';
export interface Stage { key: StageKey; label: string; hue: string; val: number; }
export interface WorkerStats {
  name: string; ws: string; claims: number; done: number;
  firstPass: number | null; medWork: number | null; releases: number;
  tokens: number | null; cost: number | null;
}
export interface ComputedAnalytics {
  hasData: boolean;
  kpis: {
    done: number; delta: number | null; cycle: number | null; work: number | null;
    firstPass: { n: number; d: number; rate: number };
    reopen: { n: number; d: number; rate: number };
    cost: { per: number | null; reported: number; total: number };
  };
  stages: Stage[]; stageTotal: number; dominant: Stage;
  throughput: Array<{ label: string; count: number }>; tpMax: number; tpDays: number;
  rounds: { first: number; one: number; two: number };
  tokensByModel: Array<{ model: string; tokens: number }>; tokMax: number;
  tokenCoverage: { reported: number; total: number };
  workers: WorkerStats[];
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

  const kpis: ComputedAnalytics['kpis'] = {
    done: N,
    delta: rangeDays ? N - donePrev.length : null,
    cycle: median(doneIn.map(cycleOf)),
    work: median(doneIn.map((t) => t.workMin)),
    firstPass: { n: firstPass, d: N, rate: pct(firstPass, N) },
    reopen: { n: reopened, d: N, rate: pct(reopened, N) },
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
    return {
      name, ws: ws0,
      claims: done.length + claimsInProg + releases,
      done: done.length,
      firstPass: done.length ? pct(fp, done.length) : null,
      medWork: median(done.map((t) => t.workMin)),
      releases,
      tokens: rep.length ? rep.reduce((s, t) => s + (t.tokensIn ?? 0) + (t.tokensOut ?? 0), 0) : null,
      cost: rep.length ? rep.reduce((s, t) => s + (t.costUsd ?? 0), 0) : null,
    };
  }).sort((a, b) => b.done - a.done || b.claims - a.claims);

  return { hasData: N > 0, kpis, stages, stageTotal, dominant, throughput, tpMax, tpDays, rounds, tokensByModel, tokMax, tokenCoverage, workers };
}
