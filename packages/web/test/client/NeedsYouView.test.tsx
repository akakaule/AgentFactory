import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NeedsYouView } from '../../client/src/views/NeedsYouView.js';
import type { Task } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    listSupervisors: vi.fn().mockResolvedValue([]),
    answerBlock: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({}),
    restart: vi.fn().mockResolvedValue({}),
    addComment: vi.fn().mockResolvedValue({}),
    setStatus: vi.fn().mockResolvedValue({}),
  },
}));

async function api() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as Record<'listSupervisors' | 'answerBlock' | 'approve' | 'restart' | 'addComment' | 'setStatus', ReturnType<typeof vi.fn>>;
}

const now = new Date().toISOString();
function task(key: string, over: Partial<Task>): Task {
  return {
    id: 1, key, title: `Title ${key}`, status: 'backlog', stage: 'implementation', kind: 'code', spec: 's', acceptanceCriteria: 'a',
    resultSummary: null, seq: 1, workspace: 'repo-a', claimedBy: null, claimedAt: null, archivedAt: null,
    aiReview: null, failure: null, delivery: null, unmetDependencyCount: 0, createdAt: now, updatedAt: now, ...over,
  } as Task;
}
const decision = { question: 'Refresh on every request or near expiry?', options: [
  { id: 'expiry', label: 'Only near expiry', detail: 'one refresh per hour' }, { id: 'every', label: 'On every request' },
], recommended: 'expiry' };
const card = (key: string) => screen.getByRole('article', { name: new RegExp(`^${key} `) });

describe('NeedsYouView', () => {
  beforeEach(async () => { for (const fn of Object.values(await api())) fn.mockClear(); });

  it('shows an agent question with its options, the recommended one preselected, and sends the answer', async () => {
    const onChanged = vi.fn();
    render(<NeedsYouView multiWs={false} onOpen={vi.fn()} onChanged={onChanged} tasks={[
      task('AF-1', { status: 'blocked', block: { reason: 'spec is ambiguous', decision, at: now } }),
    ]} />);
    const c = card('AF-1');
    expect(within(c).getByRole('heading', { name: decision.question })).toBeInTheDocument();
    expect(within(c).getByText('spec is ambiguous')).toBeInTheDocument();
    expect(within(c).getByRole('radio', { name: /Only near expiry/ })).toBeChecked();
    await userEvent.click(within(c).getByRole('radio', { name: /On every request/ }));
    await userEvent.click(within(c).getByRole('button', { name: 'Answer and put back in queue' }));
    expect((await api()).answerBlock).toHaveBeenCalledWith('AF-1', { optionId: 'every' });
    expect(onChanged).toHaveBeenCalled();
  });

  it('needs written text for "Something else" and for a plain block', async () => {
    render(<NeedsYouView multiWs={false} onOpen={vi.fn()} onChanged={vi.fn()} tasks={[
      task('AF-2', { status: 'blocked', block: { reason: 'needs a DB password', decision: null, at: now } }),
    ]} />);
    const c = card('AF-2');
    const send = within(c).getByRole('button', { name: 'Answer and put back in queue' });
    expect(send).toBeDisabled();
    await userEvent.type(within(c).getByRole('textbox', { name: 'Your answer' }), 'it is in the vault');
    await userEvent.click(send);
    expect((await api()).answerBlock).toHaveBeenCalledWith('AF-2', { answer: 'it is in the vault' });
  });

  it('offers an inline approve only for a clean, fully met review, naming the submission it approves', async () => {
    const brief = { counts: { must: 0, call: 0, should: 0, fyi: 0, merged: 0, rejected: 0 }, criteria: [{ id: 'AC1', name: null, text: 't', status: 'clear', issueIds: [] }] };
    const clean = { verdict: 'clean' as const, findings: 0, reviewer: 'codex', items: [], binding: 'current' as const };
    render(<NeedsYouView multiWs={false} onOpen={vi.fn()} onChanged={vi.fn()} tasks={[
      task('AF-3', { status: 'in_review', aiReview: clean, reviewBrief: brief as unknown as NonNullable<Task['reviewBrief']>, submission: { id: 4, headSha: 'a41c9e2abcdef' } }),
      task('AF-4', { status: 'in_review', aiReview: { ...clean, verdict: 'findings', findings: 2 } }),
    ]} />);
    expect(within(card('AF-3')).getByText('1 of 1 criteria met')).toBeInTheDocument();
    await userEvent.click(within(card('AF-3')).getByRole('button', { name: 'Approve a41c9e2' }));
    expect((await api()).approve).toHaveBeenCalledWith('AF-3', undefined, { submissionId: 4, headSha: 'a41c9e2abcdef' });
    expect(within(card('AF-4')).queryByRole('button', { name: /Approve/ })).toBeNull();
    expect(within(card('AF-4')).getByRole('button', { name: 'Open the review' })).toBeInTheDocument();
  });

  it('restarts an out-of-attempts task with a note, or cancels it', async () => {
    const failure = { reason: 'timeout', detail: 'tests timed out', source: 'dispatcher', attempt: 3, maxAttempts: 3, skipListed: true, at: now };
    render(<NeedsYouView multiWs={false} onOpen={vi.fn()} onChanged={vi.fn()} tasks={[
      task('AF-5', { status: 'queued', failure }), task('AF-6', { status: 'queued', failure }),
    ]} />);
    const a = card('AF-5');
    await userEvent.type(within(a).getByRole('textbox', { name: 'Note for the next session' }), 'raise the timeout');
    await userEvent.click(within(a).getByRole('button', { name: 'Do it' }));
    const m = await api();
    expect(m.addComment).toHaveBeenCalledWith('AF-5', 'raise the timeout');
    expect(m.restart).toHaveBeenCalledWith('AF-5');
    const b = card('AF-6');
    await userEvent.click(within(b).getByRole('radio', { name: /Cancel the task/ }));
    await userEvent.click(within(b).getByRole('button', { name: 'Do it' }));
    expect(m.setStatus).toHaveBeenCalledWith('AF-6', 'cancelled');
  });

  it('says so when nothing waits, and lists active work beside the list', () => {
    render(<NeedsYouView multiWs={false} onOpen={vi.fn()} onChanged={vi.fn()} tasks={[task('AF-7', { status: 'in_progress' })]} />);
    expect(screen.getByText('Nothing is waiting on you.')).toBeInTheDocument();
    const side = screen.getByRole('complementary', { name: 'All work' });
    expect(within(side).getByText('Title AF-7')).toBeInTheDocument();
    expect(within(side).getByText('Running')).toBeInTheDocument();
  });

  it('shows a banner when a supervisor is offline', async () => {
    (await api()).listSupervisors.mockResolvedValueOnce([{ name: 'reviewer', kind: 'reviewer', healthy: false }]);
    render(<NeedsYouView multiWs={false} onOpen={vi.fn()} onChanged={vi.fn()} tasks={[]} />);
    expect(await screen.findByText(/reviewer is offline/)).toBeInTheDocument();
  });
});
