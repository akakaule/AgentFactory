/**
 * In-memory live telemetry feed — a bounded ring of recent OTel token events.
 *
 * The OTLP receiver (routes/otel.ts) flattens every event into the durable per-task
 * aggregate (task_metric). That aggregate can't answer "what's flowing right now, from which
 * worker/agent/model?" — so the receiver ALSO pushes each parsed event here. This is the only
 * "storage" the live Telemetry view reads from: ephemeral and current-state. A restart refills it
 * from the newest OTel rows in task_metric (`seedFromMetrics`), which keep no worker or cached
 * split — so restored events carry `worker: null` and `tokensCached: null`. Like the aggregate,
 * the receiver only pushes task-attributed events here — unattributed usage (no task key) is dropped.
 */
import type { RecentTokenMetric } from '@agentfactory/core';

export interface TelemetryEvent {
  /** Monotonic id — a stable key for the client and the natural newest-first sort. */
  seq: number;
  /** Server receive time (ISO). Receive ≈ event time for a live feed. */
  at: string;
  /** Correlated task, or null when the event arrived unattributed. */
  taskKey: string | null;
  /** From the `af.workspace` resource attribute (the dispatcher stamps it), else null. */
  workspace: string | null;
  /** From the `af.worker` resource attribute (the dispatcher stamps it), else null. */
  worker: string | null;
  /** Which CLI emitted it, inferred from the event name. */
  agent: 'claude-code' | 'codex';
  model: string | null;
  tokensIn: number;
  /** Cache-hit portion already included in `tokensIn` (a breakdown, not additive); null when
   *  restored from task_metric, which does not keep it. */
  tokensCached: number | null;
  tokensOut: number;
  costUsd: number | null;
}

export interface TelemetryStore {
  /** Append an event (seq is assigned here); drops the oldest past the cap. */
  add(e: Omit<TelemetryEvent, 'seq'>): void;
  /** The most recent `limit` events, newest first. */
  recent(limit?: number): TelemetryEvent[];
}

export const DEFAULT_CAP = 500;
const DEFAULT_LIMIT = 200;

export function createTelemetryStore(cap = DEFAULT_CAP): TelemetryStore {
  const buf: TelemetryEvent[] = [];
  let seq = 0;
  return {
    add(e) {
      buf.push({ ...e, seq: ++seq });
      if (buf.length > cap) buf.splice(0, buf.length - cap);
    },
    recent(limit = DEFAULT_LIMIT) {
      const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT;
      return buf.slice(-n).reverse();
    },
  };
}

/** Refill a fresh store from task_metric's newest OTel rows (given newest-first), oldest first so
 *  `seq` and the newest-first read order match the original arrival order. */
export function seedFromMetrics(store: TelemetryStore, rows: RecentTokenMetric[]): void {
  for (const r of [...rows].reverse()) {
    store.add({
      at: r.createdAt,
      taskKey: r.taskKey,
      workspace: r.workspace,
      worker: null,
      agent: r.reportedBy === 'otel:codex' ? 'codex' : 'claude-code',
      model: r.model,
      tokensIn: r.tokensIn ?? 0,
      tokensCached: null,
      tokensOut: r.tokensOut ?? 0,
      costUsd: r.costUsd,
    });
  }
}
