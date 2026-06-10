import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { useEventStream } from './useEventStream.js';
import type { Task } from './types.js';

export function useTasks(workspace?: string | null) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const refetch = useCallback(() => {
    api.listTasks(workspace ? { workspace } : {}).then(setTasks).catch(() => {});
  }, [workspace]);
  useEffect(() => { refetch(); }, [refetch]);
  useEventStream(refetch);
  return { tasks, refetch };
}
