/* Typed port of the claude-design analytics computation (analytics.jsx).
   Everything derives from the per-task rows GET /api/analytics ships. */

export interface AnalyticsTaskRow {
  key: string; title?: string; workspace: string; status: string; doneAt: string | null; // title optional: a stale server build omits it
  queueMin: number; workMin: number; reviewMin: number; blockedMin: number;
  deliveringMin?: number; // optional: a stale server build omits it (pre-delivering-bucket)
  rounds: number; reopened: boolean; claimCount: number; worker: string | null;
  branch: string | null; // server-named feature branch; null before the first implementation claim / legacy
  stageTokens: Record<string, number>; // tokens (in+out) per stage they were reported in
  model: string | null; tokensIn: number | null; tokensOut: number | null; costUsd: number | null;
  aiReviewFindings: number | null; // findings at approval; null = no AI review present
}
export interface StrandedRelease { worker: string | null; workspace: string; at: string; }
export interface FailureEvent { reason: string; workspace: string; at: string; }
export interface IntakeAnalytics { assessments: number; unavailable: number; unavailableRate: number; latencyP50: number | null; latencyP95: number | null; failuresByKind: Record<string, number>; coverage: { numerator: number; denominator: number }; reassessments: number; overrides: number; authFailuresIncluded: false; }
export interface AnalyticsData { tasks: AnalyticsTaskRow[]; stranded: StrandedRelease[]; failures: FailureEvent[]; intake?: IntakeAnalytics; }
/** GET /api/analytics/spend: one UTC month of reported usage by day x workspace x model. */
export interface SpendRow { date: string; workspace: string; model: string | null; costUsd: number; tokens: number; unpricedTokens: number; }
export interface SpendMonth { month: string; dataUpTo: string | null; rows: SpendRow[]; }

/** Friendly labels for known supervisor failure reasons; unknown reasons render as-is. */
export const FAILURE_LABELS: Record<string, string> = {
  timeout: 'Timed out', crashed: 'Crashed', stale: 'Stale claim', permission_denied: 'Permission denied',
  max_attempts: 'Out of attempts', review_failed: 'Auto-review failed', ci_failed: 'CI failed',
  pr_closed: 'PR closed', merge_conflict: 'Merge conflict', repair_exhausted: 'Repairs exhausted',
};

export type StageKey = 'queue' | 'work' | 'review' | 'blocked' | 'delivering';
export interface Stage { key: StageKey; label: string; hue: string; val: number; }
/** One done task's spend. Token/cost fields are null when the task never reported them. */
export interface TaskSpend {
  key: string; title: string; workspace: string; doneAt: string;
  tokensIn: number | null; tokensOut: number | null; tokens: number | null; cost: number | null;
}
/** Per-workspace spend over done tasks in range. Token/cost fields are null when no task
 *  in the workspace reported them (unreported is n/a, never zero). */
export interface WorkspaceSpend {
  workspace: string; done: number; reported: number;
  tokensIn: number | null; tokensOut: number | null; tokens: number | null;
  cost: number | null; costReported: number; costPerTask: number | null;
}
export interface ComputedAnalytics {
  intake?: IntakeAnalytics;
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
  workspaceSpend: WorkspaceSpend[];
  taskSpend: TaskSpend[];
  failures: { byReason: Array<{ reason: string; label: string; count: number }>; total: number; max: number };
}

export const STAGES: Array<{ key: StageKey; field: keyof AnalyticsTaskRow; label: string; hue: string }> = [
  { key: 'queue', field: 'queueMin', label: 'Queue wait', hue: 'var(--st-queued)' },
  { key: 'work', field: 'workMin', label: 'Work', hue: 'var(--st-progress)' },
  { key: 'review', field: 'reviewMin', label: 'Review wait', hue: 'var(--st-review)' },
  { key: 'blocked', field: 'blockedMin', label: 'Blocked', hue: 'var(--st-blocked)' },
  { key: 'delivering', field: 'deliveringMin', label: 'Delivery wait', hue: 'var(--st-delivering)' },
];

const UNLABELED = '(unlabeled)';
const cycleOf = (t: AnalyticsTaskRow) => t.queueMin + t.workMin + t.reviewMin + t.blockedMin + (t.deliveringMin ?? 0);
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

  const sumOr = (rows: AnalyticsTaskRow[], f: (t: AnalyticsTaskRow) => number) =>
    rows.length ? rows.reduce((s, t) => s + f(t), 0) : null;
  const wsNames = [...new Set(doneIn.map((t) => t.workspace))];
  const workspaceSpend: WorkspaceSpend[] = wsNames.map((workspace) => {
    const done = doneIn.filter((t) => t.workspace === workspace);
    const rep = done.filter((t) => t.tokensIn != null);
    const priced = done.filter((t) => t.costUsd != null);
    const tokensIn = sumOr(rep, (t) => t.tokensIn ?? 0);
    const tokensOut = sumOr(rep, (t) => t.tokensOut ?? 0);
    const cost = sumOr(priced, (t) => t.costUsd ?? 0);
    return {
      workspace, done: done.length, reported: rep.length,
      tokensIn, tokensOut, tokens: tokensIn == null ? null : tokensIn + (tokensOut ?? 0),
      cost, costReported: priced.length, costPerTask: cost == null ? null : cost / priced.length,
    };
  }).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || (b.tokens ?? -1) - (a.tokens ?? -1));

  // Most expensive first; tasks with tokens but no price next, unreported last.
  const taskSpend: TaskSpend[] = doneIn.map((t) => ({
    key: t.key, title: t.title ?? '', workspace: t.workspace, doneAt: t.doneAt!,
    tokensIn: t.tokensIn, tokensOut: t.tokensOut,
    tokens: t.tokensIn == null ? null : t.tokensIn + (t.tokensOut ?? 0),
    cost: t.costUsd,
  })).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || (b.tokens ?? -1) - (a.tokens ?? -1));

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

  return { hasData: N > 0, ...(data.intake ? { intake: data.intake } : {}), kpis, stages, stageTotal, dominant, throughput, tpMax, tpDays, rounds, tokensByModel, tokMax, tokensByWorkspace, tokWsMax, tokensByBranch, tokBranchMax, tokensByStage, tokStageMax, tokenCoverage, workspaceSpend, taskSpend, failures };
}

export function fmtUsd(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------- spend panel

export type Provider = 'Anthropic' | 'OpenAI' | 'Other';
export type SpendSplit = 'provider' | 'workspace';
export type SpendMetric = 'cost' | 'tokens';
const PROVIDERS: Provider[] = ['Anthropic', 'OpenAI', 'Other'];

/** Validated (CVD + contrast) against the dark panel surface. Fixed per provider, never by rank. */
export const PROVIDER_COLORS: Record<Provider, string> = { Anthropic: '#9085e9', OpenAI: '#199e70', Other: '#c98500' };
/** Validated dark categorical order for the workspace split: assigned in order, never cycled. */
export const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
const FOLDED = 'Other';
const FOLDED_COLOR = 'var(--ink-3)';
const MAX_NAMED = 7; // the 8th slot and beyond fold into Other

export function providerOf(model: string | null): Provider {
  if (!model) return 'Other';
  if (/claude|anthropic/i.test(model)) return 'Anthropic';
  if (/gpt|codex|openai/i.test(model)) return 'OpenAI';
  return 'Other';
}

/** The current UTC month first, then the `n - 1` before it, as YYYY-MM. */
export function recentMonths(now: number, n: number): string[] {
  const d = new Date(now);
  return Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
}

export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00.000Z`).toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** 0..max in 4-5 round steps (1, 1.5, 2, 2.5, 5 x 10^k); [0] when there is nothing to scale. */
export function niceTicks(max: number): number[] {
  if (max <= 0) return [0];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 1.5, 2, 2.5, 5, 10].find((f) => raw / pow <= f) ?? 10) * pow;
  const count = Math.ceil(max / step - 1e-9);
  return Array.from({ length: count + 1 }, (_, i) => Number((i * step).toFixed(10)));
}

export interface SpendSeries { key: string; color: string; value: number; }
export interface SpendDay { date: string; values: Record<string, number>; total: number; }
export interface SpendView {
  total: number; series: SpendSeries[]; days: SpendDay[];
  ticks: number[]; max: number; unpricedTokens: number;
}

/**
 * Group one month of spend rows into the stacked series the panel draws. Provider series keep a
 * fixed order and color; workspace series follow the board's workspace order (unknown names after,
 * alphabetically), the first seven named and the rest folded into Other. Series with nothing in the
 * chosen metric are dropped. Unpriced tokens never count as $0: they ride along as their own total.
 */
export function computeSpend(month: SpendMonth, split: SpendSplit, metric: SpendMetric, workspaceOrder: string[]): SpendView {
  const valueOf = (r: SpendRow) => (metric === 'cost' ? r.costUsd : r.tokens);
  const rawKey = (r: SpendRow) => (split === 'provider' ? providerOf(r.model) : r.workspace);

  const totals = new Map<string, number>();
  for (const r of month.rows) totals.set(rawKey(r), (totals.get(rawKey(r)) ?? 0) + valueOf(r));
  const present = [...totals].filter(([, v]) => v > 0).map(([k]) => k);

  let ordered: string[];
  const colorOf = new Map<string, string>();
  const keyOf = new Map<string, string>(); // raw key -> drawn series key (folding)
  if (split === 'provider') {
    ordered = PROVIDERS.filter((p) => present.includes(p));
    for (const p of ordered) { colorOf.set(p, PROVIDER_COLORS[p as Provider]); keyOf.set(p, p); }
  } else {
    const rank = (w: string) => { const i = workspaceOrder.indexOf(w); return i === -1 ? Infinity : i; };
    const byBoard = present.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
    const named = byBoard.length > MAX_NAMED + 1 ? byBoard.slice(0, MAX_NAMED) : byBoard;
    named.forEach((w, i) => { colorOf.set(w, SERIES_COLORS[i]!); keyOf.set(w, w); });
    ordered = [...named];
    if (named.length < byBoard.length) {
      for (const w of byBoard.slice(named.length)) keyOf.set(w, FOLDED);
      colorOf.set(FOLDED, FOLDED_COLOR);
      ordered.push(FOLDED);
    }
  }

  const [y, m] = month.month.split('-').map(Number) as [number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days: SpendDay[] = Array.from({ length: daysInMonth }, (_, i) => ({
    date: `${month.month}-${String(i + 1).padStart(2, '0')}`, values: {}, total: 0,
  }));
  const series = new Map<string, number>();
  let unpricedTokens = 0;
  for (const r of month.rows) {
    unpricedTokens += r.unpricedTokens;
    const key = keyOf.get(rawKey(r));
    const v = valueOf(r);
    if (key === undefined || v <= 0) continue;
    const day = days[Number(r.date.slice(8, 10)) - 1];
    if (!day) continue;
    day.values[key] = (day.values[key] ?? 0) + v;
    day.total += v;
    series.set(key, (series.get(key) ?? 0) + v);
  }
  const ticks = niceTicks(Math.max(0, ...days.map((d) => d.total)));
  return {
    total: [...series.values()].reduce((a, b) => a + b, 0),
    series: ordered.map((key) => ({ key, color: colorOf.get(key)!, value: series.get(key) ?? 0 })),
    days, ticks, max: ticks.at(-1) || 1, unpricedTokens,
  };
}
