import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsView } from '../../client/src/views/AnalyticsView.js';
import type { AnalyticsData, AnalyticsTaskRow } from '../../client/src/metrics.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    getAnalytics: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([]),
  },
  eventsUrl: () => '/events',
}));

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as { getAnalytics: ReturnType<typeof vi.fn>; listWorkspaces: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  globalThis.EventSource = vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(), removeEventListener: vi.fn(), close: vi.fn(),
    get onerror() { return null; }, set onerror(_fn: unknown) {},
  })) as unknown as typeof EventSource;
});

let seq = 0;
function doneRow(over: Partial<AnalyticsTaskRow> = {}): AnalyticsTaskRow {
  seq += 1;
  return {
    key: `AF-${seq}`, workspace: 'default', status: 'done', doneAt: new Date(Date.now() - 3600000).toISOString(),
    queueMin: 20, workMin: 40, reviewMin: 60, blockedMin: 0,
    rounds: 0, reopened: false, claimCount: 1, worker: 'worker-1',
    model: 'claude-fable-5', tokensIn: 10000, tokensOut: 2000, costUsd: 0.5,
    aiReviewFindings: null,
    ...over,
  };
}

describe('AnalyticsView', () => {
  it('renders KPIs, the coverage banner, and the workers table from live rows', async () => {
    const mocked = await getApiMock();
    const data: AnalyticsData = {
      tasks: [doneRow(), doneRow({ tokensIn: null, tokensOut: null, costUsd: null, model: null })],
      stranded: [],
      failures: [],
    };
    mocked.getAnalytics.mockResolvedValue(data);

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    expect(await screen.findByText('Tasks done')).toBeInTheDocument();
    expect(screen.getByText('Where time goes')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument(); // coverage banner
    expect(screen.getByText('worker-1')).toBeInTheDocument();
    // stage row + dominant caption both name the review stage
    expect(screen.getAllByText('Review wait').length).toBeGreaterThanOrEqual(1);
  });

  it('renders the AI override-rate KPI from reviewed rows', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [
        doneRow({ aiReviewFindings: 2 }), // approved past findings → override
        doneRow({ aiReviewFindings: 0 }), // clean
        doneRow({ aiReviewFindings: null }), // no AI review → excluded
      ],
      stranded: [],
    });

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    expect(await screen.findByText('AI override rate')).toBeInTheDocument();
    // 1 override of 2 reviewed = 50%; the third (no review) is excluded
    expect(screen.getByText('1 / 2 approved past findings')).toBeInTheDocument();
    expect(screen.getByText('50%')).toBeInTheDocument();
  });

  it('shows the AI override rate as n/a when no task had an AI review', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [doneRow()], stranded: [] });

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    expect(await screen.findByText('AI override rate')).toBeInTheDocument();
    expect(screen.getByText('no AI reviews')).toBeInTheDocument();
  });

  it('shows n/a cost when nothing is reported', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [doneRow({ tokensIn: null, tokensOut: null, costUsd: null, model: null })],
      stranded: [],
    });

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    // KPI big value + workers-table cells all read n/a
    expect((await screen.findAllByText('n/a')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('0 of 1 reported')).toBeInTheDocument();
  });

  it('shows the intentional empty state when no done tasks match', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [] });

    render(<AnalyticsView ws="shopfloor" rangeDays={7} onRange={vi.fn()} />);

    expect(await screen.findByText('No completed tasks in this range')).toBeInTheDocument();
    expect(screen.getByText(/workspace: shopfloor/)).toBeInTheDocument();
  });

  it('toggles the tokens panel between model and workspace groupings', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [
        doneRow({ workspace: 'alpha', model: 'claude-fable-5', tokensIn: 50000, tokensOut: 5000 }),
        doneRow({ workspace: 'beta', model: 'claude-haiku-4-5', tokensIn: 1000, tokensOut: 100 }),
      ],
      stranded: [],
    });
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    // model grouping by default
    expect(await screen.findByText('Tokens by model')).toBeInTheDocument();
    expect(screen.getByText('claude-fable-5')).toBeInTheDocument();
    expect(screen.getByText('claude-haiku-4-5')).toBeInTheDocument();

    // switch to workspace grouping — title updates, model bars give way to workspace bars
    await user.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(screen.getByText('Tokens by workspace')).toBeInTheDocument();
    expect(screen.queryByText('claude-fable-5')).not.toBeInTheDocument();
    expect(screen.getAllByText('alpha').length).toBeGreaterThanOrEqual(1); // workspace bar (also appears in the workers table)
    expect(screen.getAllByText('beta').length).toBeGreaterThanOrEqual(1);
    // coverage note persists across both modes
    expect(screen.getByText('2 of 2')).toBeInTheDocument();

    // and back to model
    await user.click(screen.getByRole('button', { name: 'Model' }));
    expect(screen.getByText('Tokens by model')).toBeInTheDocument();
    expect(screen.getByText('claude-fable-5')).toBeInTheDocument();
  });

  it('shows the per-grouping empty state in both token modes', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [doneRow({ tokensIn: null, tokensOut: null, costUsd: null, model: null })], // done but no usage reported
      stranded: [],
    });
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await screen.findByText('Tasks done');

    expect(screen.getByText('No worker reported token usage in this range.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(screen.getByText('No worker reported token usage in this range.')).toBeInTheDocument();
  });

  it('range buttons call onRange', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [] });
    const onRange = vi.fn();
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={onRange} />);
    await screen.findByText('No completed tasks in this range');

    await user.click(screen.getByRole('button', { name: '30d' }));
    expect(onRange).toHaveBeenCalledWith(30);
    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(onRange).toHaveBeenCalledWith(null);
  });
});
