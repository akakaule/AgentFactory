import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskMetrics } from '../../client/src/components/TaskMetrics.js';
import type { TaskMetricsView } from '../../client/src/types.js';

const base: TaskMetricsView = {
  queueMin: 12, workMin: 38, reviewMin: 66, blockedMin: 0,
  rounds: 0, reopened: false, claimCount: 1, doneAt: '2026-06-11T10:00:00.000Z',
  model: null, tokensIn: null, tokensOut: null, costUsd: null,
};

describe('TaskMetrics', () => {
  it('shows the no-metrics line for a never-claimed task', () => {
    render(<TaskMetrics metrics={{ ...base, claimCount: 0, queueMin: 0, workMin: 0, reviewMin: 0 }} />);
    expect(screen.getByText(/hasn't been worked/)).toBeInTheDocument();
  });

  it('renders the stage legend and reported token/cost chips', () => {
    render(<TaskMetrics metrics={{ ...base, model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92 }} />);
    expect(screen.getByText('queued')).toBeInTheDocument();
    expect(screen.getByText('38m')).toBeInTheDocument();
    expect(screen.getByText('first-pass')).toBeInTheDocument();
    expect(screen.getByText('41k')).toBeInTheDocument();
    expect(screen.getByText('claude-fable-5')).toBeInTheDocument();
    expect(screen.getByText(/\$0\.92/)).toBeInTheDocument();
  });

  it('renders dashed n/a chips when nothing was reported', () => {
    render(<TaskMetrics metrics={base} />);
    expect(screen.getByText('tokens n/a')).toBeInTheDocument();
    expect(screen.getByText('cost n/a · not reported')).toBeInTheDocument();
  });

  it('counts review rounds in the quality chip', () => {
    render(<TaskMetrics metrics={{ ...base, rounds: 2 }} />);
    expect(screen.getByText('2 review rounds')).toBeInTheDocument();
  });
});
