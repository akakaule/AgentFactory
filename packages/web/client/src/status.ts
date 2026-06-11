import type { Status } from './types.js';

export const LIFECYCLE_ORDER: Status[] = [
  'backlog',
  'queued',
  'in_progress',
  'in_review',
  'blocked',
  'done',
];

export const STATUS_LABELS: Record<Status, string> = {
  backlog: 'Backlog',
  queued: 'Queued',
  in_progress: 'In Progress',
  in_review: 'In Review',
  blocked: 'Blocked',
  done: 'Done',
};

export const STATUS_COLORS: Record<Status, string> = {
  backlog: '#64748B',
  queued: '#60A5FA',
  in_progress: '#F59E0B',
  in_review: '#A78BFA',
  blocked: '#F87171',
  done: '#4ADE80',
};
