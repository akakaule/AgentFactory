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
  backlog: '#9aa0a6',
  queued: '#5b8def',
  in_progress: '#e0a800',
  in_review: '#7aa0ff',
  blocked: '#e5534b',
  done: '#46c878',
};
