import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { trailSteps, StatusTrail } from '../../client/src/components/StatusTrail.js';
import type { Activity, Status, Actor } from '../../client/src/types.js';

// Build a status_change activity log from [from, to, body?] tuples (ids ascending = chronological).
function activities(rows: Array<[Status | null, Status, string?]>): Activity[] {
  return rows.map(([fromStatus, toStatus, body], i) => ({
    id: i + 1, taskId: 1, type: 'status_change' as const, actor: 'agent' as Actor,
    fromStatus, toStatus, body: body ?? '', createdAt: '2026-06-28T10:00:00.000Z',
    actorUserId: null, actorName: null,
  }));
}

describe('trailSteps', () => {
  it('returns a single current step when there is no activity', () => {
    const steps = trailSteps([], 'queued', 'plan');
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ status: 'queued', stage: 'plan' });
  });

  it('keeps every node in the same stage for a single-stage implementation task', () => {
    const steps = trailSteps(activities([
      [null, 'backlog'], ['backlog', 'queued'], ['queued', 'in_progress'], ['in_progress', 'in_review'],
    ]), 'in_review', 'implementation');
    expect(steps.map((s) => s.status)).toEqual(['backlog', 'queued', 'in_progress', 'in_review']);
    expect(steps.every((s) => s.stage === 'implementation')).toBe(true);
  });

  it('assigns each node its stage across description → plan → implementation advances', () => {
    const steps = trailSteps(activities([
      [null, 'backlog'],
      ['backlog', 'queued'],
      ['queued', 'in_progress'],
      ['in_progress', 'in_review'],
      ['in_review', 'queued', 'auto-approved: clean AI review; stage description → plan'],
      ['queued', 'in_progress'],
      ['in_progress', 'in_review'],
      ['in_review', 'queued', 'approved; stage plan → implementation'],
      ['queued', 'in_progress'],
    ]), 'in_progress', 'implementation');
    expect(steps.map((s) => s.stage)).toEqual([
      'description', 'description', 'description', 'description',
      'plan', 'plan', 'plan',
      'implementation', 'implementation',
    ]);
  });

  it('does not advance the stage on a rework loop (in_review → queued with no marker)', () => {
    const steps = trailSteps(activities([
      [null, 'backlog'],
      ['backlog', 'queued'],
      ['queued', 'in_progress'],
      ['in_progress', 'in_review'],
      ['in_review', 'queued'],          // rework rejection — carries no stage marker
      ['queued', 'in_progress'],
      ['in_progress', 'in_review'],
    ]), 'in_review', 'implementation');
    expect(steps).toHaveLength(7);
    expect(steps.every((s) => s.stage === 'implementation')).toBe(true);
  });
});

describe('StatusTrail', () => {
  it('renders one labeled row per pipeline stage', () => {
    const activity = activities([
      [null, 'backlog'], ['backlog', 'queued'], ['queued', 'in_progress'], ['in_progress', 'in_review'],
      ['in_review', 'queued', 'stage description → plan'],
      ['queued', 'in_progress'], ['in_progress', 'in_review'],
      ['in_review', 'queued', 'stage plan → implementation'],
      ['queued', 'in_progress'],
    ]);
    render(<StatusTrail activity={activity} current="in_progress" currentStage="implementation" />);
    expect(screen.getByText('Describe')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Implement')).toBeInTheDocument();
    expect(screen.getAllByText('In Progress').length).toBeGreaterThan(0);
  });
});
