import { Hono } from 'hono';
import type { TelemetryStore } from '../telemetry.js';

/**
 * Live telemetry feed read side. The OTLP receiver (routes/otel.ts) writes into the same
 * in-memory ring; this exposes the most recent events to the board's Telemetry view. Mounted
 * under /api/telemetry, so it inherits the standard /api/* auth guard.
 */
export function telemetryRoutes(store: TelemetryStore): Hono {
  const r = new Hono();

  r.get('/', (c) => {
    const limit = Number(c.req.query('limit'));
    return c.json(store.recent(Number.isFinite(limit) ? limit : undefined));
  });

  return r;
}
