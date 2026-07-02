import type { Status, Actor } from './types.js';
import { InvalidTransitionError } from './errors.js';

export interface TransitionRule { from: Status; to: Status; by: Actor; }

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'backlog',     to: 'queued',      by: 'human' },
  // a 'pr-review' task is parked straight into review (kind-gated in ops/updateStatus.ts so a
  // 'code' task can never use it to skip implementation)
  { from: 'backlog',     to: 'in_review',   by: 'human' },
  { from: 'queued',      to: 'in_progress', by: 'agent' },
  { from: 'in_progress', to: 'in_review',   by: 'agent' },
  { from: 'in_progress', to: 'blocked',     by: 'agent' },
  { from: 'in_progress', to: 'queued',      by: 'human' }, // release a stranded claim

  { from: 'blocked',     to: 'in_progress', by: 'agent' },
  { from: 'blocked',     to: 'queued',      by: 'human' },
  { from: 'in_review',   to: 'done',        by: 'human' },
  { from: 'in_review',   to: 'queued',      by: 'human' },
  { from: 'done',        to: 'queued',      by: 'human' }, // reopen (e.g. CI failed on the PR)
  // pr-review-only straight-to-review edges (kind-gated in ops/updateStatus.ts): rescue a
  // pr-review task wrongly parked in the queue, and reopen a closed review to re-review.
  { from: 'queued',      to: 'in_review',   by: 'human' },
  { from: 'done',        to: 'in_review',   by: 'human' },

  // Delivery verification (migration #18): approving an implementation review with a recognizable
  // git-host origin routes to 'delivering' instead of 'done'; the watcher supervisor closes or
  // bounces it, and the human edges keep the board operable when there is no CI / no watcher.
  { from: 'in_review',   to: 'delivering',  by: 'human' }, // approve (ops/reviewApprove.ts routes here)
  { from: 'delivering',  to: 'done',        by: 'agent' }, // watcher: PR merged + pipeline green
  { from: 'delivering',  to: 'queued',      by: 'agent' }, // watcher: CI failed / PR closed unmerged
  { from: 'delivering',  to: 'done',        by: 'human' }, // force-complete (no CI configured / watcher down)
  { from: 'delivering',  to: 'queued',      by: 'human' }, // manual pull-back for rework
] as const;

export function isValidTransition(from: Status, to: Status, by: Actor): boolean {
  return TRANSITIONS.some(t => t.from === from && t.to === to && t.by === by);
}

export function assertTransition(from: Status, to: Status, by: Actor): void {
  if (!isValidTransition(from, to, by))
    throw new InvalidTransitionError(`${from} -> ${to} not allowed for ${by}`);
}
