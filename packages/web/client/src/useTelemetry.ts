import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { TelemetryEvent } from './types.js';

/**
 * Poll the live OTel telemetry feed while mounted. The feed is an ephemeral server-side ring
 * (not part of the SSE version signal), so — like the live-agents surfaces — it polls.
 * Pass active=false to pause (e.g. when the view isn't shown).
 */
export function useTelemetry(active = true, intervalMs = 3000, limit = 200): TelemetryEvent[] {
  const [events, setEvents] = useState<TelemetryEvent[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = () => { api.listTelemetry({ limit }).then((e) => { if (alive) setEvents(e); }).catch(() => {}); };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [active, intervalMs, limit]);
  return events;
}
