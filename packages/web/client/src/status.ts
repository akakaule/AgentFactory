import type { Status, Stage, Task } from './types.js';

// Tasks arrive ordered by seq ASC (creation order), which is the right reading order for the
// active columns. Done is the exception: it accumulates and the most recently completed task is
// the interesting one, so show Done newest-first by updatedAt (the transition into done bumps it).
export function tasksForColumn(status: Status, tasks: Task[]): Task[] {
  const inColumn = tasks.filter((t) => t.status === status);
  if (status !== 'done') return inColumn;
  return [...inColumn].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const LIFECYCLE_ORDER: Status[] = [
  'backlog',
  'queued',
  'in_progress',
  'in_review',
  'delivering',
  'blocked',
  'done',
];

export const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  queued: 'Queued',
  in_progress: 'In Progress',
  in_review: 'In Review',
  delivering: 'Delivering',
  blocked: 'Blocked',
  done: 'Done',
};

export const STATUS_COLORS: Record<Status, string> = {
  backlog: '#64748B',
  queued: '#60A5FA',
  in_progress: '#F59E0B',
  in_review: '#A78BFA',
  delivering: '#2DD4BF',
  blocked: '#F87171',
  done: '#4ADE80',
};

// pipeline stage chip — the stage rides the card/drawer as a chip since the board
// columns stay status-based (a task cycles through them once per stage)
export const STAGE_LABELS: Record<Stage, string> = {
  description: 'Describe',
  plan: 'Plan',
  implementation: 'Implement',
};

export const STAGE_COLORS: Record<Stage, string> = {
  description: '#38BDF8',
  plan: '#C084FC',
  implementation: '#94A3B8',
};
