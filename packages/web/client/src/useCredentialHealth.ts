import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import type { CredentialHealthView } from './types.js';

/**
 * Poll the recorded git-credential health (outside the SSE version, like supervisor heartbeats).
 * `check` probes one workspace now and refreshes the list.
 */
export function useCredentialHealth(intervalMs = 30_000): { health: CredentialHealthView[]; check: (workspace: string) => Promise<void> } {
  const [health, setHealth] = useState<CredentialHealthView[]>([]);
  const refresh = useCallback(() => api.getCredentialHealth().then(setHealth).catch(() => {}), []);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(id);
  }, [refresh, intervalMs]);
  const check = useCallback(async (workspace: string) => {
    await api.checkCredential(workspace);
    await refresh();
  }, [refresh]);
  return { health, check };
}
