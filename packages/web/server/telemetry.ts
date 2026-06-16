/**
 * In-memory live telemetry feed — a bounded ring of recent OTel token events.
 *
 * The OTLP receiver (routes/otel.ts) flattens every event into the durable per-task
 * aggregate (task_metric). That aggregate can't answer "what's flowing right now, from which
 * worker/agent/model?" — so the receiver ALSO pushes each parsed event here. This is the only
 * "storage" the live Telemetry view reads from: ephemeral, current-state, lost on restart
 * (the durable aggregate is untouched). Unlike the aggregate, it keeps UNATTRIBUTED events
 * (no task key) so the view can show telemetry arriving but not bound to a task.
 */

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
  tokensOut: number;
  costUsd: number | null;
}

export interface TelemetryStore {
  /** Append an event (seq is assigned here); drops the oldest past the cap. */
  add(e: Omit<TelemetryEvent, 'seq'>): void;
  /** The most recent `limit` events, newest first. */
  recent(limit?: number): TelemetryEvent[];
}

const DEFAULT_CAP = 500;
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
