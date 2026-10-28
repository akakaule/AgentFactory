import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewPanel } from '../../client/src/components/ReviewPanel.js';
import type { TaskDetailView } from '../../client/src/types.js';
import { af146Brief, af146Review, AF146_CRITERIA, v1Brief } from './fixtures/reviewBrief.js';

vi.mock('../../client/src/api.js', () => ({ api: { getDiff: vi.fn() } }));
async function getDiffMock() {
  const mod = await import('../../client/src/api.js');
  return (mod.api as unknown as { getDiff: ReturnType<typeof vi.fn> }).getDiff;
}

const DIFF = [
  'diff --git a/packages/dispatcher/src/dispatcher.ts b/packages/dispatcher/src/dispatcher.ts',
  '--- a/packages/dispatcher/src/dispatcher.ts',
  '+++ b/packages/dispatcher/src/dispatcher.ts',
  '@@ -250,4 +250,5 @@ export class Dispatcher {',
  '   enforceTimeouts(now: number) {',
  '     for (const s of this.sessions) {',
  '+      const age = now - s.startedAtMs;',
  '       if (age > this.max) s.kill();',
  '     }',
  '',
].join('\n');

function task(over: Partial<TaskDetailView> = {}): TaskDetailView {
  const brief = af146Brief({ links: true });
  return {
    id: 146, key: 'AF-146', title: 'Bind executions', spec: 's', acceptanceCriteria: AF146_CRITERIA,
    status: 'in_review', stage: 'implementation', kind: 'code', resultSummary: 'done', seq: 1, workspace: 'agentfactory',
    unmetDependencyCount: 0, claimedBy: null, claimedAt: null, archivedAt: null,
    aiReview: af146Review({ links: true }), reviewBrief: brief, failure: null, delivery: null,
    createdAt: 't', updatedAt: 'u1', activity: [], links: [{ id: 1, taskId: 146, kind: 'branch', label: 'feature/AF-146-x', url: 'u' }],
    attachments: [], dependencies: [], dependents: [], repoPath: '.', branch: 'feature/AF-146-x', plan: null,
    originalSpec: null, originalAcceptanceCriteria: null, policy: null, verifyCommand: null, hasVisualization: false, visualizationGeneratedAt: null,
    metrics: { queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0, deliveringMin: 0, rounds: 0, reopened: false, claimCount: 0, doneAt: null, model: null, tokensIn: null, tokensOut: null, costUsd: null },
    criteriaClaims: [{ id: 'AC6', claim: 'Heartbeats keep a session alive; liveness.test.ts advances the clock.' }],
    ...over,
  };
}

function renderPanel(over: Partial<TaskDetailView> = {}, props: Partial<Parameters<typeof ReviewPanel>[0]> = {}) {
  const onApprove = vi.fn().mockResolvedValue(undefined);
  const onRequestChanges = vi.fn().mockResolvedValue(undefined);
  const onOpenChanges = vi.fn();
  render(<ReviewPanel task={task(over)} willDeliver onApprove={onApprove} onRequestChanges={onRequestChanges} onOpenChanges={onOpenChanges} {...props} />);
  return { onApprove, onRequestChanges, onOpenChanges, user: userEvent.setup() };
}
const row = (id: string) => screen.getByRole('button', { name: new RegExp(`^${id} [^:]*: `) });
const decision = (id: string) => screen.getByRole('radiogroup', { name: `Decision for ${id}` });
const checked = (id: string) => within(decision(id)).queryAllByRole('radio').find((r) => (r as HTMLInputElement).checked)?.getAttribute('value') ?? null;

beforeEach(async () => { (await getDiffMock()).mockReset().mockResolvedValue({ branch: 'feature/AF-146-x', baseRef: 'main', diff: DIFF, commits: 1 }); });

describe('ReviewPanel — verdict card', () => {
  it('states the verdict, the groups and where the review came from', () => {
    renderPanel();
    expect(screen.getByRole('heading', { name: 'Changes needed' })).toBeInTheDocument();
    expect(screen.getByText(/^2 must-fix issues: AC4 Race and AC6 Liveness aren't met\./)).toBeInTheDocument();
    const pills = screen.getByRole('group', { name: 'Filter issues by group' });
    expect(within(pills).getAllByRole('button').map((b) => b.textContent)).toEqual(['2Must fix', '3Your call', '2Should fix']);
    expect(screen.getByText('2 duplicates merged · 0 rejected · commit 4699e45 · Claude + Codex')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request changes (4)' })).toHaveClass('af-btn-primary');
    expect(screen.getByText('3 issues need your decision')).toBeInTheDocument();
  });

  it('lists the remaining concerns in order, one item each', () => {
    renderPanel();
    const list = screen.getByLabelText('Remaining concerns');
    expect(within(list).getAllByRole('listitem').map((li) => li.textContent))
      .toEqual(['2 must-fix issues', '3 issues need your decision', 'Criteria not met: AC4 Race, AC6 Liveness']);
  });

  it('a pill filters the issues to its group and a second click clears it', async () => {
    const { user } = renderPanel();
    const pill = screen.getByRole('button', { name: 'Your call · 3' });
    await user.click(pill);
    expect(pill).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('data-issue'))).toEqual(['F3', 'F5', 'F8']);
    await user.click(pill);
    expect(screen.getAllByRole('article')).toHaveLength(7);
  });
});

describe('ReviewPanel — criteria and issues', () => {
  it('lists each criterion with the worker\'s claim and what the reviewers found', async () => {
    const { user } = renderPanel();
    const ac6 = row('AC6');
    expect(ac6).toHaveTextContent('Not met');
    expect(ac6).toHaveTextContent('Liveness');
    expect(ac6).toHaveTextContent('Heartbeats keep a session alive');
    expect(ac6).toHaveTextContent('F1');
    expect(row('AC1')).toHaveTextContent('No claim');
    expect(row('AC1')).toHaveTextContent('Nothing flagged');
    expect(screen.getByText(/^Also required: Each item is covered/)).toBeInTheDocument();
    // a row expands its full text and filters the issues to that criterion
    await user.click(ac6);
    expect(ac6).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/test clock advances past maxSessionMinutes/)).toBeVisible();
    expect(screen.getAllByRole('article').map((a) => a.getAttribute('data-issue'))).toEqual(['F1']);
  });

  it('a legacy review says how many issues are unlinked', () => {
    renderPanel({ reviewBrief: af146Brief(), aiReview: af146Review() });
    expect(screen.getByText('4 issues aren\'t linked to a criterion (this review predates criterion links)')).toBeInTheDocument();
    expect(row('AC1')).toHaveTextContent('No linked issues');
  });

  it('groups the issues in order, preselects must and should, and leaves your-call undecided', () => {
    renderPanel();
    expect(screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual(['Must fix · 2', 'Your call · 3', 'Should fix · 2']);
    expect([checked('F1'), checked('F6'), checked('F3'), checked('F2'), checked('F4')]).toEqual(['must', 'must', null, 'should', 'should']);
    const f3 = screen.getByRole('article', { name: /F3/ });
    expect(within(f3).getByText('Also raised as F9 (Codex)')).toBeInTheDocument();
    expect(within(f3).getByText('Claude rates it Should fix')).toBeInTheDocument();
    expect(within(f3).getByText('Codex rates it Must fix')).toBeInTheDocument();
    expect(within(f3).getByText('claude reason for F3.')).toBeInTheDocument();
    const f1 = screen.getByRole('article', { name: /F1/ });
    expect(within(f1).getByText('Claude and Codex agree: must fix')).toBeInTheDocument();
    expect(within(f1).getByText('Fix for F1.')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: /F4/ })).getByText('Outside the criteria')).toBeInTheDocument();
  });

  it('deciding a your-call issue updates the count and the hint', async () => {
    const { user } = renderPanel();
    await user.click(within(decision('F3')).getByRole('radio', { name: 'Must fix' }));
    expect(screen.getByRole('button', { name: 'Request changes (5)' })).toBeInTheDocument();
    expect(screen.getByText('2 issues need your decision')).toBeInTheDocument();
  });

  it('a pending review shows its issues read-only', () => {
    renderPanel({ reviewBrief: af146Brief({ links: true, superseded: true }) });
    expect(screen.getByRole('heading', { name: 'Review pending' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(7);
    for (const radio of within(decision('F1')).getAllByRole('radio')) expect(radio).toBeDisabled();
    expect(checked('F1')).toBeNull();
  });
});

describe('ReviewPanel — evidence', () => {
  it('opens on file:line with the criterion, the claim, the hunk around the line and every opinion', async () => {
    const { user } = renderPanel();
    await user.click(screen.getAllByRole('button', { name: 'packages/dispatcher/src/dispatcher.ts:253' })[0]!);
    const panel = await screen.findByRole('dialog', { name: /AC6 liveness not met/ });
    expect(within(panel).getByText(/test clock advances past maxSessionMinutes/)).toBeInTheDocument();
    expect(within(panel).getByText('Heartbeats keep a session alive; liveness.test.ts advances the clock.')).toBeInTheDocument();
    expect(within(panel).getByText('reviewed at 4699e45')).toBeInTheDocument();
    const hit = within(panel).getByText('if (age > this.max) s.kill();', { exact: false }).closest('.af-rv-codeline');
    expect(hit).toHaveClass('hit');
    expect(within(within(panel).getByRole('region', { name: 'What each reviewer found' })).getAllByText(/rates it Must fix/)).toHaveLength(2);
    expect(within(within(panel).getByRole('region', { name: 'Merged duplicates' })).getByText('F7')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('says when the line or the file is not in the diff', async () => {
    const getDiff = await getDiffMock();
    getDiff.mockResolvedValue({ branch: 'b', baseRef: 'main', diff: DIFF.replace('@@ -250,4 +250,5 @@', '@@ -10,4 +10,5 @@'), commits: 1 });
    const { user } = renderPanel();
    await user.click(screen.getAllByRole('button', { name: 'packages/dispatcher/src/dispatcher.ts:253' })[0]!);
    expect(await screen.findByText('Line 253 isn\'t among the changed lines.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    const f2 = screen.getByRole('article', { name: /F2/ });
    await user.click(within(f2).getByRole('button', { name: /reviewer\.ts/ }));
    expect(await screen.findByText('This file isn\'t changed on the branch.')).toBeInTheDocument();
  });
});

describe('ReviewPanel — a new review resets the decisions', () => {
  it('even when it reuses the same issue ids and groups', async () => {
    const first = v1Brief([{ severity: 'error', file: null, line: null, title: 'Broken', detail: null }]);
    const user = userEvent.setup();
    const props = { willDeliver: true, onApprove: vi.fn(), onRequestChanges: vi.fn(), onOpenChanges: vi.fn() };
    const { rerender } = render(<ReviewPanel task={task({ reviewBrief: first, aiReview: null })} {...props} />);
    await user.click(within(decision('F1')).getByRole('radio', { name: 'Dismiss' }));
    expect(checked('F1')).toBe('dismiss');
    const second = v1Brief([{ severity: 'error', file: null, line: null, title: 'Still broken after the rework', detail: null }]);
    rerender(<ReviewPanel task={task({ reviewBrief: second, aiReview: null })} {...props} />);
    expect(checked('F1')).toBe('must');
  });
});

describe('ReviewPanel — send back', () => {
  it('previews exactly what the agent gets, lists what is not sent, and posts the composed body', async () => {
    const { user, onRequestChanges } = renderPanel();
    await user.click(within(decision('F2')).getByRole('radio', { name: 'Dismiss' }));
    await user.click(screen.getByRole('button', { name: 'Request changes (3)' }));
    const dialog = screen.getByRole('dialog', { name: 'Send back to the agent' });
    expect(within(dialog).getByText('Not sent')).toBeInTheDocument();
    expect(within(dialog).getByText(/F2 .* · dismissed/)).toBeInTheDocument();
    expect(within(dialog).getByText(/F3 .* · not decided/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Your note to the agent/), 'Keep the API stable.');
    // the exact message, problem text included, is one click away before sending
    const exact = within(dialog).getByText('Show the exact message');
    await user.click(exact);
    const preview = exact.closest('details')!.querySelector('pre')!.textContent!;
    expect(preview).toContain('Problem: enforceTimeouts()');
    expect(preview).toContain('Keep the API stable.');
    await user.click(within(dialog).getByRole('button', { name: 'Send back 3 issues' }));
    const body = onRequestChanges.mock.calls[0]![0] as string;
    expect(body).toBe(preview);
    expect(body).toMatch(/^Changes requested after the AI review of 4699e45 \(Claude \+ Codex\)/);
    expect(body).toContain('F1 · AC6');
    expect(body).toContain('F4 ·');
    expect(body).not.toContain('F2 ·');
    expect(body).not.toContain('F3 ·');
    expect(body).toContain('## Note from the human reviewer\n\nKeep the API stable.');
  });

  it('with nothing decided the button sends a note, and is disabled until there is one', async () => {
    const { user, onRequestChanges } = renderPanel({ reviewBrief: af146Brief({ links: true, superseded: true }) });
    await user.click(screen.getByRole('button', { name: 'Request changes (0)' }));
    const send = screen.getByRole('button', { name: 'Send note' });
    expect(send).toBeDisabled();
    await user.type(screen.getByLabelText(/Your note to the agent/), 'Please rebase.');
    await user.click(send);
    expect(onRequestChanges).toHaveBeenCalledWith('Please rebase.');
  });
});

describe('ReviewPanel — approve', () => {
  it('approving over must-fix issues asks why, and shows a server refusal inline', async () => {
    const { user, onApprove } = renderPanel();
    onApprove.mockRejectedValueOnce(new Error('approving over must-fix issues or open decisions needs a reason'));
    await user.click(screen.getByRole('button', { name: 'Approve anyway…' }));
    const dialog = screen.getByRole('dialog', { name: 'Approve with open issues?' });
    expect(within(dialog).getByText('Criteria not met: AC4 Race, AC6 Liveness')).toBeInTheDocument();
    expect(within(dialog).getByText('Still open: 2 must fix · 3 your call · 2 should fix')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Approve anyway → deliver' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Why is it OK to ship this\?/), 'AC6 moves to AF-150.');
    await user.click(confirm);
    expect(onApprove).toHaveBeenCalledWith('AC6 moves to AF-150.');
    expect(await within(dialog).findByText(/needs a reason/)).toBeInTheDocument();
  });

  it('minor-only and clean reviews approve in one click', async () => {
    const minor = renderPanel({ reviewBrief: v1Brief([{ severity: 'warning', file: null, line: null, title: 'Slow', detail: null }]) });
    await minor.user.click(screen.getByRole('button', { name: 'Approve → deliver' }));
    expect(minor.onApprove).toHaveBeenCalledWith(undefined);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a doc-stage review has no criteria table and approves into implementation', async () => {
    const { user, onApprove } = renderPanel({ stage: 'description', reviewBrief: af146Brief({ links: true, stage: 'description' }) }, { willDeliver: false });
    expect(screen.queryByRole('button', { name: /^AC1 [^:]*: / })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Approve anyway…' }));
    await user.type(screen.getByLabelText(/Why is it OK to ship this\?/), 'The spec gap is tracked.');
    await user.click(screen.getByRole('button', { name: 'Approve anyway → implementation' }));
    expect(onApprove).toHaveBeenCalledWith('The spec gap is tracked.');
  });

  it('with no review yet it offers a plain approve and a note-only send back', async () => {
    const { user, onApprove } = renderPanel({ reviewBrief: null, aiReview: null });
    expect(screen.getByText('No AI review yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve → deliver' }));
    expect(onApprove).toHaveBeenCalledWith(undefined);
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    expect(screen.getByRole('button', { name: 'Send note' })).toBeDisabled();
  });

  it('a single-reviewer review reads "Reported by" and has no your-call group', () => {
    renderPanel({ reviewBrief: v1Brief([{ severity: 'error', file: null, line: null, title: 'Broken', detail: 'It throws.', criteria: ['AC1'] }]), aiReview: null });
    expect(screen.getByText('Reported by codex')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /Your call/ })).toBeNull();
  });
});

describe('ReviewPanel — revision (AF-148)', () => {
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const submission = (over: Partial<NonNullable<TaskDetailView['submission']>> = {}): NonNullable<TaskDetailView['submission']> => ({
    id: 7, stage: 'implementation', executionId: null, branch: 'feature/AF-146-x', headSha: A, baseSha: null, contentHash: null,
    source: 'origin', observedAt: 't', createdAt: 't', lastObservation: null, freshness: 'current', ...over,
  });

  it('names the submission and commit under review', () => {
    renderPanel({ submission: submission() });
    expect(screen.getByText(/Submission #7 · commit aaaaaaa/)).toBeInTheDocument();
  });

  it('a push after submit blocks approval and says why, first in the remaining concerns', () => {
    renderPanel({ submission: submission({ freshness: 'stale', lastObservation: { headSha: B, source: 'git', observedAt: 't2', error: null } }) });
    const items = within(screen.getByLabelText('Remaining concerns')).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toEqual([
      'The branch moved to bbbbbbb after this submission. Approval is blocked until the new revision is submitted and reviewed — request changes.',
      'This AI review names no revision (recorded before revisions were tracked).',
      '2 must-fix issues',
      '3 issues need your decision',
      'Criteria not met: AC4 Race, AC6 Liveness',
    ]);
    expect(screen.getByRole('button', { name: 'Approve anyway…' })).toHaveAttribute('disabled');
  });

  it('a clean review shows no remaining concerns list', () => {
    renderPanel({ reviewBrief: v1Brief([]), aiReview: null, submission: submission() });
    expect(screen.queryByLabelText('Remaining concerns')).toBeNull();
  });

  it('shows unknown freshness with the observation error', () => {
    renderPanel({ submission: submission({ freshness: 'unknown', lastObservation: { headSha: null, source: 'git', observedAt: 't2', error: 'origin unreachable' } }) });
    expect(screen.getByText(/freshness unknown: origin unreachable/i)).toBeInTheDocument();
  });

  it('labels an AI review of an older revision', () => {
    renderPanel({ submission: submission(), aiReview: { ...af146Review({ links: true }), binding: 'stale', revision: { submissionId: 6, headSha: B } } });
    expect(screen.getByText(/AI review is for an older revision/)).toBeInTheDocument();
  });

  it('labels an AI review of a submission that recorded no commit', () => {
    renderPanel({ submission: submission({ headSha: null, freshness: 'unknown' }), aiReview: { ...af146Review({ links: true }), binding: 'unverified', revision: { submissionId: 7, headSha: A } } });
    expect(screen.getByText(/AI review cannot be matched to the submitted commit/)).toBeInTheDocument();
  });

  it('historical tasks (no submission) render without a revision line', () => {
    renderPanel();
    expect(screen.queryByText(/Submission #/)).toBeNull();
  });
});
