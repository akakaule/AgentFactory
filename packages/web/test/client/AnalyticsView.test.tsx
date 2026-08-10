import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsView } from '../../client/src/views/AnalyticsView.js';
import type { AnalyticsData, AnalyticsTaskRow } from '../../client/src/metrics.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    getAnalytics: vi.fn(),
    getTokenTrend: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([]),
  },
  eventsUrl: () => '/events',
}));

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as {
    getAnalytics: ReturnType<typeof vi.fn>;
    getTokenTrend: ReturnType<typeof vi.fn>;
    listWorkspaces: ReturnType<typeof vi.fn>;
  };
}

let versionBump: (() => void) | undefined;
beforeEach(async () => {
  vi.resetAllMocks();
  const mocked = await getApiMock();
  mocked.getTokenTrend.mockResolvedValue([]);
  mocked.listWorkspaces.mockResolvedValue([]);
  versionBump = undefined;
  globalThis.EventSource = vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn((name: string, fn: () => void) => {
      if (name === 'version') versionBump = fn;
    }),
    removeEventListener: vi.fn(), close: vi.fn(),
    get onerror() { return null; }, set onerror(_fn: unknown) {},
  })) as unknown as typeof EventSource;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const trend = (tokensIn: number, tokensOut: number, date = '2026-08-10') =>
  [{ date, tokensIn, tokensOut }];

const workspace = (id: number, name: string) => ({
  id, name, repoPath: `C:/Git/${name}`, policy: null, verifyCommand: null, hasPat: false,
  promptOverrides: {}, createdAt: '2026-08-01T00:00:00.000Z',
});

let seq = 0;
function doneRow(over: Partial<AnalyticsTaskRow> = {}): AnalyticsTaskRow {
  seq += 1;
  return {
    key: `AF-${seq}`, workspace: 'default', status: 'done', doneAt: new Date(Date.now() - 3600000).toISOString(),
    queueMin: 20, workMin: 40, reviewMin: 60, blockedMin: 0, deliveringMin: 0,
    rounds: 0, reopened: false, claimCount: 1, worker: 'worker-1', branch: `feature/AF-${seq}-t`,
    stageTokens: { implementation: 12000 },
    model: 'claude-fable-5', tokensIn: 10000, tokensOut: 2000, costUsd: 0.5,
    aiReviewFindings: null,
    ...over,
  };
}

describe('AnalyticsView', () => {
  it('renders the 30-day input/output chart even when there are no completed tasks', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getTokenTrend.mockResolvedValue(trend(1200, 300));

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    expect(await screen.findByText('No completed tasks in this range')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Token spend' });
    expect(within(panel).getByText('daily · last 30 days UTC')).toBeInTheDocument();
    expect(within(panel).getByText('Input')).toBeInTheDocument();
    expect(within(panel).getByText('Output')).toBeInTheDocument();
    expect(within(panel).getByTitle('2026-08-10 · input 1,200 · output 300')).toBeInTheDocument();
    expect(within(panel).getByText('1.2k input · 300 output')).toBeInTheDocument();
  });

  it('uses an empty UI sentinel while passing selected workspace names, including literal all', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getTokenTrend.mockResolvedValue([]);
    mocked.listWorkspaces.mockResolvedValue([
      workspace(1, 'alpha'),
      workspace(2, 'all'),
    ]);
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Token spend workspace' });

    expect(select).toHaveValue('');
    expect(mocked.getTokenTrend).toHaveBeenNthCalledWith(1, undefined);

    await user.selectOptions(select, 'alpha');
    await waitFor(() => expect(mocked.getTokenTrend).toHaveBeenLastCalledWith('alpha'));

    await user.selectOptions(select, 'all');
    await waitFor(() => expect(mocked.getTokenTrend).toHaveBeenLastCalledWith('all'));

    await user.selectOptions(select, '');
    await waitFor(() => expect(mocked.getTokenTrend).toHaveBeenLastCalledWith(undefined));
  });

  it('ignores stale results and stale rejections after the chart workspace changes', async () => {
    const mocked = await getApiMock();
    const first = deferred<Array<{ date: string; tokensIn: number; tokensOut: number }>>();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.listWorkspaces.mockResolvedValue([workspace(1, 'alpha')]);
    mocked.getTokenTrend
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(trend(2200, 400));
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Token spend workspace' }), 'alpha');
    const panel = screen.getByRole('region', { name: 'Token spend' });
    expect(await within(panel).findByText('2.2k input · 400 output')).toBeInTheDocument();

    await act(async () => { first.resolve(trend(100, 10)); });
    expect(within(panel).getByText('2.2k input · 400 output')).toBeInTheDocument();
    expect(within(panel).queryByText('100 input · 10 output')).not.toBeInTheDocument();

    const staleFailure = deferred<Array<{ date: string; tokensIn: number; tokensOut: number }>>();
    mocked.getTokenTrend
      .mockReturnValueOnce(staleFailure.promise)
      .mockResolvedValueOnce(trend(3300, 500));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Token spend workspace' }), '');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Token spend workspace' }), 'alpha');
    expect(await within(panel).findByText('3.3k input · 500 output')).toBeInTheDocument();

    await act(async () => { staleFailure.reject(new Error('stale selection failed')); });
    expect(within(panel).queryByText(/stale selection failed/i)).not.toBeInTheDocument();
    expect(within(panel).getByText('3.3k input · 500 output')).toBeInTheDocument();
  });

  it('surfaces the current chart rejection with its workspace and retries it', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.listWorkspaces.mockResolvedValue([workspace(1, 'alpha')]);
    mocked.getTokenTrend
      .mockResolvedValueOnce(trend(700, 70))
      .mockRejectedValueOnce(new Error('trend unavailable'))
      .mockResolvedValueOnce(trend(900, 90));
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    expect(await screen.findByText('700 input · 70 output')).toBeInTheDocument();
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Token spend workspace' }), 'alpha');

    const panel = screen.getByRole('region', { name: 'Token spend' });
    expect(await within(panel).findByText("Couldn't load token spend for alpha")).toBeInTheDocument();
    expect(within(panel).getByText('trend unavailable')).toBeInTheDocument();
    expect(within(panel).queryByText('700 input · 70 output')).not.toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'Retry' }));
    expect(await within(panel).findByText('900 input · 90 output')).toBeInTheDocument();
  });

  it('coalesces repeated stream bumps into exactly one same-selection follow-up', async () => {
    const mocked = await getApiMock();
    const initial = deferred<Array<{ date: string; tokensIn: number; tokensOut: number }>>();
    const followUp = deferred<Array<{ date: string; tokensIn: number; tokensOut: number }>>();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getTokenTrend.mockReturnValueOnce(initial.promise).mockReturnValueOnce(followUp.promise);

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await waitFor(() => expect(mocked.getTokenTrend).toHaveBeenCalledTimes(1));

    await act(async () => {
      versionBump?.();
      versionBump?.();
      versionBump?.();
    });
    expect(mocked.getTokenTrend).toHaveBeenCalledTimes(1);

    await act(async () => { initial.resolve(trend(100, 20)); });
    await waitFor(() => expect(mocked.getTokenTrend).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('100 input · 20 output')).toBeInTheDocument();

    await act(async () => { followUp.resolve(trend(200, 40)); });
    expect(await screen.findByText('200 input · 40 output')).toBeInTheDocument();
    expect(mocked.getTokenTrend).toHaveBeenCalledTimes(2);
  });

  it('shows a current rejection while still running the one coalesced poll follow-up', async () => {
    const mocked = await getApiMock();
    const initial = deferred<Array<{ date: string; tokensIn: number; tokensOut: number }>>();
    const followUp = deferred<Array<{ date: string; tokensIn: number; tokensOut: number }>>();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getTokenTrend.mockReturnValueOnce(initial.promise).mockReturnValueOnce(followUp.promise);

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await waitFor(() => expect(mocked.getTokenTrend).toHaveBeenCalledTimes(1));
    await act(async () => {
      versionBump?.();
      versionBump?.();
    });

    await act(async () => { initial.reject(new Error('temporary trend failure')); });
    const panel = screen.getByRole('region', { name: 'Token spend' });
    expect(await within(panel).findByText('temporary trend failure')).toBeInTheDocument();
    await waitFor(() => expect(mocked.getTokenTrend).toHaveBeenCalledTimes(2));

    await act(async () => { followUp.resolve(trend(400, 80)); });
    expect(await within(panel).findByText('400 input · 80 output')).toBeInTheDocument();
    expect(within(panel).queryByText('temporary trend failure')).not.toBeInTheDocument();
  });

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

  it('shows the worker branch (feature/ stripped) and a per-branch tokens grouping', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [
        doneRow({ worker: 'w-a', branch: 'feature/AF-100-add-search', tokensIn: 50000, tokensOut: 5000 }),
        doneRow({ worker: 'w-b', branch: 'feature/AF-101-fix-scroll', tokensIn: 1000, tokensOut: 100 }),
      ],
      stranded: [],
      failures: [],
    });
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    // BRANCH column in the workers table shows the branch with feature/ stripped
    expect(await screen.findByText('AF-100-add-search')).toBeInTheDocument();

    // the tokens panel gains a Branch grouping that bars tokens per branch
    await user.click(screen.getByRole('button', { name: 'Branch' }));
    expect(screen.getByText('Tokens by branch')).toBeInTheDocument();
    expect(screen.getAllByText('AF-101-fix-scroll').length).toBeGreaterThanOrEqual(1); // workers table + bar
  });

  it('groups token usage by stage when the Stage toggle is selected', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [
        doneRow({ tokensIn: 50000, tokensOut: 5000, stageTokens: { implementation: 50000, plan: 5000 } }),
      ],
      stranded: [],
      failures: [],
    });
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await screen.findByText('Tasks done');

    await user.click(screen.getByRole('button', { name: 'Stage' }));
    expect(screen.getByText('Tokens by stage')).toBeInTheDocument();
    expect(screen.getByText('implementation')).toBeInTheDocument();
    expect(screen.getByText('plan')).toBeInTheDocument();
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

  it('surfaces a failed load with a working Retry instead of an endless "Loading…"', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics
      .mockRejectedValueOnce(new Error('Request timed out — reload the page and try again.'))
      .mockResolvedValueOnce({ tasks: [doneRow()], stranded: [], failures: [] });
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    // the rejection is shown (with its message) rather than swallowed into a stuck spinner
    expect(await screen.findByText("Couldn't load analytics")).toBeInTheDocument();
    expect(screen.getByText(/timed out/i)).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();

    // Retry re-fetches and renders the data
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Tasks done')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load analytics")).not.toBeInTheDocument();
  });
});
