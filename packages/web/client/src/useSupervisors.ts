import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { SupervisorView } from './types.js';

/**
 * Poll the supervisor-health endpoint while mounted. Heartbeats deliberately don't bump the SSE
 * version (no board-refetch thrash), so this polls like useLiveAgents. Pass active=false to pause.
 */
export function useSupervisors(active = true, intervalMs = 5000): SupervisorView[] {
  const [supervisors, setSupervisors] = useState<SupervisorView[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = () => { api.listSupervisors().then((s) => { if (alive) setSupervisors(s); }).catch(() => {}); };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [active, intervalMs]);
  return supervisors;
}
