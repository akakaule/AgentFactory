import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TaskMetrics } from '../../client/src/components/TaskMetrics.js';
import type { TaskMetricsView } from '../../client/src/types.js';

const base: TaskMetricsView = {
  queueMin: 12, workMin: 38, reviewMin: 66, blockedMin: 0, deliveringMin: 0,
  rounds: 0, reopened: false, claimCount: 1, doneAt: '2026-06-11T10:00:00.000Z',
  model: null, tokensIn: null, tokensOut: null, costUsd: null,
};

describe('TaskMetrics', () => {
  it('expands usage by stage, agent and model with exact counts and reconciled totals', () => {
    render(<TaskMetrics metrics={{ ...base, tokensIn: 1200, tokensOut: 30, tokenBreakdown: [
      { stage: 'plan', agent: 'claude', model: 'claude-test', tokensIn: 200, tokensOut: 10 },
      { stage: 'implementation', agent: 'codex', model: 'gpt-test', tokensIn: 1000, tokensOut: 20 },
    ] }} />);
    fireEvent.click(screen.getByText('Token breakdown'));
    const table = screen.getByRole('table', { name: 'Token usage by stage, agent and model' });
    expect(within(table).getByRole('row', { name: 'Plan Claude claude-test 200 10 210' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'Implementation Codex gpt-test 1,000 20 1,020' })).toBeInTheDocument();
    expect(within(table).getByRole('row', { name: 'All stages 1,200 30 1,230' })).toBeInTheDocument();
    expect(screen.getByText(/Stages are inferred/)).toBeInTheDocument();
  });

  it('shows unknown attribution and output-only usage even when never claimed', () => {
    render(<TaskMetrics metrics={{ ...base, claimCount: 0, tokensOut: 0, tokenBreakdown: [
      { stage: null, agent: null, model: null, tokensIn: null, tokensOut: 0 },
    ] }} />);
    fireEvent.click(screen.getByText('Token breakdown'));
    expect(screen.getByRole('row', { name: 'Unknown Unknown Unknown n/a 0 0' })).toBeInTheDocument();
    expect(screen.queryByText(/hasn't been worked/)).not.toBeInTheDocument();
  });

  it('explains missing breakdowns from older servers without inventing rows', () => {
    render(<TaskMetrics metrics={{ ...base, tokensIn: 15 }} />);
    expect(screen.getByText('Token breakdown unavailable for these reports.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

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

  it('renders the delivering segment when the task waited on PR merge + CI', () => {
    render(<TaskMetrics metrics={{ ...base, deliveringMin: 120 }} />);
    expect(screen.getByText('delivering')).toBeInTheDocument();
    expect(screen.getByText('2h')).toBeInTheDocument();
  });

  it('counts review rounds in the quality chip', () => {
    render(<TaskMetrics metrics={{ ...base, rounds: 2 }} />);
    expect(screen.getByText('2 review rounds')).toBeInTheDocument();
  });
});
