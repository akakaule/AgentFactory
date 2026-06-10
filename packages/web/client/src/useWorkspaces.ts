import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { useEventStream } from './useEventStream.js';
import type { Workspace } from './types.js';

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const refetch = useCallback(() => { api.listWorkspaces().then(setWorkspaces).catch(() => {}); }, []);
  useEffect(() => { refetch(); }, [refetch]);
  useEventStream(refetch);
  return { workspaces, refetch };
}
