import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { AgentSessionView } from './types.js';

/**
 * Poll the live-agents endpoint while mounted. Heartbeats/milestones deliberately don't
 * bump the SSE version (no board-refetch thrash), so the live surfaces poll instead.
 * Pass active=false to pause (e.g. a closed surface).
 */
export function useLiveAgents(active = true, intervalMs = 2500): AgentSessionView[] {
  const [agents, setAgents] = useState<AgentSessionView[]>([]);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const tick = () => { api.listAgents().then((a) => { if (alive) setAgents(a); }).catch(() => {}); };
    tick();
    const id = setInterval(tick, intervalMs);
    return () => { alive = false; clearInterval(id); };
  }, [active, intervalMs]);
  return agents;
}
