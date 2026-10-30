import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AnalyticsView } from '../../client/src/views/AnalyticsView.js';
import { monthLabel, recentMonths, type AnalyticsData, type AnalyticsTaskRow, type SpendMonth } from '../../client/src/metrics.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    getAnalytics: vi.fn(),
    getSpend: vi.fn(),
    listWorkspaces: vi.fn().mockResolvedValue([]),
  },
  eventsUrl: () => '/events',
}));

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as {
    getAnalytics: ReturnType<typeof vi.fn>;
    getSpend: ReturnType<typeof vi.fn>;
    listWorkspaces: ReturnType<typeof vi.fn>;
  };
}

let versionBump: (() => void) | undefined;
beforeEach(async () => {
  vi.resetAllMocks();
  const mocked = await getApiMock();
  mocked.getSpend.mockResolvedValue(spend(0));
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

const MONTHS = recentMonths(Date.now(), 3);
/** One month of spend: an Anthropic row in alpha and (optionally) a partly unpriced OpenAI row in beta. */
function spend(anthropic: number, openai = 0, month = MONTHS[0]!): SpendMonth {
  return {
    month, dataUpTo: anthropic || openai ? `${month}-02T10:00:00.000Z` : null,
    rows: [
      ...(anthropic ? [{ date: `${month}-02`, workspace: 'alpha', model: 'claude-opus-5-5', costUsd: anthropic, tokens: 1000, unpricedTokens: 0 }] : []),
      ...(openai ? [{ date: `${month}-02`, workspace: 'beta', model: 'gpt-6.1-sol', costUsd: openai, tokens: 500, unpricedTokens: 200 }] : []),
    ],
  };
}
const headline = (panel: HTMLElement) => panel.querySelector('.an-spend-total')?.textContent;

const workspace = (id: number, name: string) => ({
  id, name, repoPath: `C:/Git/${name}`, policy: null, verifyCommand: null, hasPat: false,
  promptOverrides: {}, createdAt: '2026-08-01T00:00:00.000Z',
});

let seq = 0;
function doneRow(over: Partial<AnalyticsTaskRow> = {}): AnalyticsTaskRow {
  seq += 1;
  return {
    key: `AF-${seq}`, title: `Task ${seq}`, workspace: 'default', status: 'done', doneAt: new Date(Date.now() - 3600000).toISOString(),
    queueMin: 20, workMin: 40, reviewMin: 60, blockedMin: 0, deliveringMin: 0,
    rounds: 0, reopened: false, claimCount: 1, worker: 'worker-1', branch: `feature/AF-${seq}-t`,
    stageTokens: { implementation: 12000 },
    model: 'claude-fable-5', tokensIn: 10000, tokensOut: 2000, costUsd: 0.5,
    aiReviewFindings: null,
    ...over,
  };
}

describe('AnalyticsView', () => {
  it('lists each task with its tokens and cost and opens it on click', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [
        doneRow({ key: 'AF-7', title: 'Add search', workspace: 'alpha', tokensIn: 40000, tokensOut: 2000, costUsd: 1.25 }),
        doneRow({ key: 'AF-8', title: 'Fix scroll', workspace: 'beta', tokensIn: null, tokensOut: null, costUsd: null, model: null }),
      ],
      stranded: [], failures: [],
    } satisfies AnalyticsData);
    const onOpen = vi.fn();
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} onOpen={onOpen} />);

    const panel = await screen.findByRole('region', { name: 'Spend by task' });
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('AF-7')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Add search')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('40k')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('42k')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('$1.25')).toBeInTheDocument();
    expect(within(rows[1]!).getAllByText('n/a')).toHaveLength(4);

    await user.click(rows[1]!);
    expect(onOpen).toHaveBeenCalledWith('AF-8');
  });

  it('caps the task spend table and reveals the rest on demand', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: Array.from({ length: 30 }, (_, i) => doneRow({ costUsd: i + 1 })),
      stranded: [], failures: [],
    } satisfies AnalyticsData);
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    const panel = await screen.findByRole('region', { name: 'Spend by task' });
    expect(within(panel).getAllByRole('row')).toHaveLength(21); // header + 20
    expect(within(panel).getByText('$30.00')).toBeInTheDocument(); // most expensive first
    await user.click(within(panel).getByRole('button', { name: 'Show all 30 tasks' }));
    expect(within(panel).getAllByRole('row')).toHaveLength(31);
  });

  it('shows tokens and cost per workspace', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({
      tasks: [
        doneRow({ workspace: 'alpha', tokensIn: 40000, tokensOut: 2000, costUsd: 1.25 }),
        doneRow({ workspace: 'alpha', tokensIn: 10000, tokensOut: 1000, costUsd: 0.75 }),
        doneRow({ workspace: 'beta', tokensIn: null, tokensOut: null, costUsd: null, model: null }),
      ],
      stranded: [], failures: [],
    } satisfies AnalyticsData);

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    const panel = await screen.findByRole('region', { name: 'Spend by workspace' });
    const alpha = within(panel).getByRole('row', { name: /alpha/ });
    expect(within(alpha).getByText('50k')).toBeInTheDocument();
    expect(within(alpha).getByText('3k')).toBeInTheDocument();
    expect(within(alpha).getByText('$2.00')).toBeInTheDocument();
    expect(within(alpha).getByText('$1.00')).toBeInTheDocument();
    const beta = within(panel).getByRole('row', { name: /beta/ });
    expect(within(beta).getAllByText('n/a')).toHaveLength(5);
    expect(within(panel).getByText('$2.00 total')).toBeInTheDocument();
  });

  it('renders the monthly spend panel even when there are no completed tasks', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getSpend.mockResolvedValue(spend(2, 0.25));

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);

    expect(await screen.findByText('No completed tasks in this range')).toBeInTheDocument();
    const panel = screen.getByRole('region', { name: 'Spend' });
    expect(within(panel).getByText(`Total spend, all workspaces, ${monthLabel(MONTHS[0]!)}`)).toBeInTheDocument();
    await waitFor(() => expect(headline(panel)).toBe('$2.25'));
    const legend = within(panel.querySelector<HTMLElement>('.an-spend-legend')!);
    expect(legend.getByText('Anthropic')).toBeInTheDocument();
    expect(legend.getByText('$2.00')).toBeInTheDocument();
    expect(legend.getByText('OpenAI')).toBeInTheDocument();
    expect(legend.getByText('$0.25')).toBeInTheDocument();
    expect(within(panel).getByText(/200 tokens have no price/)).toBeInTheDocument();
    expect(within(panel).getByTitle(`${MONTHS[0]}-02 · Anthropic $2.00 · OpenAI $0.25`)).toBeInTheDocument();
    expect(mocked.getSpend).toHaveBeenCalledWith(MONTHS[0], undefined);
  });

  it('fetches the selected month and workspace, passing literal all through', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.listWorkspaces.mockResolvedValue([workspace(1, 'alpha'), workspace(2, 'all')]);
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    const select = await screen.findByRole('combobox', { name: 'Spend workspace' });

    expect(select).toHaveValue('');
    expect(mocked.getSpend).toHaveBeenNthCalledWith(1, MONTHS[0], undefined);

    await user.selectOptions(select, 'alpha');
    await waitFor(() => expect(mocked.getSpend).toHaveBeenLastCalledWith(MONTHS[0], 'alpha'));

    await user.click(screen.getByRole('button', { name: monthLabel(MONTHS[1]!) }));
    await waitFor(() => expect(mocked.getSpend).toHaveBeenLastCalledWith(MONTHS[1], 'alpha'));

    await user.selectOptions(select, 'all');
    await waitFor(() => expect(mocked.getSpend).toHaveBeenLastCalledWith(MONTHS[1], 'all'));

    await user.selectOptions(select, '');
    await waitFor(() => expect(mocked.getSpend).toHaveBeenLastCalledWith(MONTHS[1], undefined));
  });

  it('switches between cost and tokens and between provider and workspace splits without refetching', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getSpend.mockResolvedValue(spend(2, 0.25));
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    const panel = screen.getByRole('region', { name: 'Spend' });
    await waitFor(() => expect(headline(panel)).toBe('$2.25'));

    await user.click(within(panel).getByRole('button', { name: 'Tokens' }));
    expect(headline(panel)).toBe('1.5k');
    expect(within(panel).getByText(`Total tokens, all workspaces, ${monthLabel(MONTHS[0]!)}`)).toBeInTheDocument();

    await user.click(within(panel).getByRole('button', { name: 'By workspace' }));
    expect(within(panel).getAllByText('alpha').length).toBeGreaterThanOrEqual(1);
    expect(within(panel).getAllByText('beta').length).toBeGreaterThanOrEqual(1);
    expect(mocked.getSpend).toHaveBeenCalledTimes(1);
  });

  it('ignores stale results and stale rejections after the selection changes', async () => {
    const mocked = await getApiMock();
    const first = deferred<SpendMonth>();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.listWorkspaces.mockResolvedValue([workspace(1, 'alpha')]);
    mocked.getSpend
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(spend(2200));
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Spend workspace' }), 'alpha');
    const panel = screen.getByRole('region', { name: 'Spend' });
    await waitFor(() => expect(headline(panel)).toBe('$2,200.00'));

    await act(async () => { first.resolve(spend(100)); });
    expect(headline(panel)).toBe('$2,200.00');

    const staleFailure = deferred<SpendMonth>();
    mocked.getSpend
      .mockReturnValueOnce(staleFailure.promise)
      .mockResolvedValueOnce(spend(3300));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Spend workspace' }), '');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Spend workspace' }), 'alpha');
    await waitFor(() => expect(headline(panel)).toBe('$3,300.00'));

    await act(async () => { staleFailure.reject(new Error('stale selection failed')); });
    expect(within(panel).queryByText(/stale selection failed/i)).not.toBeInTheDocument();
    expect(headline(panel)).toBe('$3,300.00');
  });

  it('surfaces the current rejection with its selection and retries it', async () => {
    const mocked = await getApiMock();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.listWorkspaces.mockResolvedValue([workspace(1, 'alpha')]);
    mocked.getSpend
      .mockResolvedValueOnce(spend(700))
      .mockRejectedValueOnce(new Error('spend unavailable'))
      .mockResolvedValueOnce(spend(900));
    const user = userEvent.setup();

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    const panel = screen.getByRole('region', { name: 'Spend' });
    await waitFor(() => expect(headline(panel)).toBe('$700.00'));
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Spend workspace' }), 'alpha');

    expect(await within(panel).findByText(`Couldn't load spend for alpha, ${monthLabel(MONTHS[0]!)}`)).toBeInTheDocument();
    expect(within(panel).getByText('spend unavailable')).toBeInTheDocument();
    expect(headline(panel)).toBeUndefined();

    await user.click(within(panel).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(headline(panel)).toBe('$900.00'));
  });

  it('coalesces repeated stream bumps into exactly one same-selection follow-up', async () => {
    const mocked = await getApiMock();
    const initial = deferred<SpendMonth>();
    const followUp = deferred<SpendMonth>();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getSpend.mockReturnValueOnce(initial.promise).mockReturnValueOnce(followUp.promise);

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await waitFor(() => expect(mocked.getSpend).toHaveBeenCalledTimes(1));

    await act(async () => {
      versionBump?.();
      versionBump?.();
      versionBump?.();
    });
    expect(mocked.getSpend).toHaveBeenCalledTimes(1);

    const panel = screen.getByRole('region', { name: 'Spend' });
    await act(async () => { initial.resolve(spend(100)); });
    await waitFor(() => expect(mocked.getSpend).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(headline(panel)).toBe('$100.00'));

    await act(async () => { followUp.resolve(spend(200)); });
    await waitFor(() => expect(headline(panel)).toBe('$200.00'));
    expect(mocked.getSpend).toHaveBeenCalledTimes(2);
  });

  it('shows a current rejection while still running the one coalesced poll follow-up', async () => {
    const mocked = await getApiMock();
    const initial = deferred<SpendMonth>();
    const followUp = deferred<SpendMonth>();
    mocked.getAnalytics.mockResolvedValue({ tasks: [], stranded: [], failures: [] });
    mocked.getSpend.mockReturnValueOnce(initial.promise).mockReturnValueOnce(followUp.promise);

    render(<AnalyticsView ws="all" rangeDays={7} onRange={vi.fn()} />);
    await waitFor(() => expect(mocked.getSpend).toHaveBeenCalledTimes(1));
    await act(async () => {
      versionBump?.();
      versionBump?.();
    });

    await act(async () => { initial.reject(new Error('temporary spend failure')); });
    const panel = screen.getByRole('region', { name: 'Spend' });
    expect(await within(panel).findByText('temporary spend failure')).toBeInTheDocument();
    await waitFor(() => expect(mocked.getSpend).toHaveBeenCalledTimes(2));

    await act(async () => { followUp.resolve(spend(400)); });
    await waitFor(() => expect(headline(panel)).toBe('$400.00'));
    expect(within(panel).queryByText('temporary spend failure')).not.toBeInTheDocument();
  });

  it('renders KPIs, the coverage banner, and the task spend table from live rows', async () => {
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
    expect(within(screen.getByRole('region', { name: 'Spend by task' })).getAllByRole('row')).toHaveLength(3); // header + 2 tasks
    expect(screen.queryByText('Workers')).not.toBeInTheDocument();
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

    // KPI big value + task-table cells all read n/a
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
    expect(screen.getAllByText('alpha').length).toBeGreaterThanOrEqual(1); // workspace bar (also appears in the spend tables)
    expect(screen.getAllByText('beta').length).toBeGreaterThanOrEqual(1);
    // coverage note persists across both modes
    expect(screen.getByText('2 of 2')).toBeInTheDocument();

    // and back to model
    await user.click(screen.getByRole('button', { name: 'Model' }));
    expect(screen.getByText('Tokens by model')).toBeInTheDocument();
    expect(screen.getByText('claude-fable-5')).toBeInTheDocument();
  });

  it('shows a per-branch tokens grouping with feature/ stripped', async () => {
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

    await screen.findByText('Tasks done');

    // the tokens panel gains a Branch grouping that bars tokens per branch
    await user.click(screen.getByRole('button', { name: 'Branch' }));
    expect(screen.getByText('Tokens by branch')).toBeInTheDocument();
    expect(screen.getByText('AF-100-add-search')).toBeInTheDocument();
    expect(screen.getByText('AF-101-fix-scroll')).toBeInTheDocument();
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
