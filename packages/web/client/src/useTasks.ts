import { useCallback, useEffect, useState } from 'react';
import { api } from './api.js';
import { useEventStream } from './useEventStream.js';
import type { Task, Status } from './types.js';

export function useTasks(status?: Status) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const refetch = useCallback(() => { api.listTasks(status).then(setTasks).catch(() => {}); }, [status]);
  useEffect(() => { refetch(); }, [refetch]);
  useEventStream(refetch);
  return { tasks, refetch };
}
