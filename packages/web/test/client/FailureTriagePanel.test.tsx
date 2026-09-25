import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FailureBanner } from '../../client/src/components/FailureBanner.js';
import type { FailureSummary, FailureTriageSummary, Activity } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    recordFailureTriageFeedback: vi.fn().mockResolvedValue({}),
    getFailureTriageHistory: vi.fn(),
    getFailureTriageSource: vi.fn(),
  },
}));

import { api } from '../../client/src/api.js';
const mocked = api as unknown as Record<'recordFailureTriageFeedback' | 'getFailureTriageHistory' | 'getFailureTriageSource', ReturnType<typeof vi.fn>>;

const failure: FailureSummary = {
  reason: 'max_attempts', detail: 'reached maxAttempts (3) and is skip-listed', source: 'dispatcher',
  attempt: 3, maxAttempts: 3, skipListed: true, at: '2026-09-25T10:00:00.000Z',
};

const rules = (over: Partial<FailureTriageSummary> = {}): FailureTriageSummary => ({
  sourceActivityId: 12, evidenceActivityId: 11, classifier: 'rules', category: 'access', label: 'Access or credentials',
  suggestion: 'Check the reported credential, account entitlement, or execution permission.',
  rules: { version: 'failure-triage-rules/v1', category: 'access', ruleId: 'access/http-401-403', matchedLine: 'error NU1301: … 401 (Unauthorized).', alsoMatched: ['build_test'] },
  human: null,
  ...over,
});

const banner = (triage: FailureTriageSummary | null, onChanged = vi.fn(), activity: Activity[] = []) =>
  <FailureBanner taskKey="AF-7" failure={failure} activity={activity} triage={triage} onChanged={onChanged} />;

describe('failure triage in the failure banner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the rule label, the matched local line, the fixed next check, and where the evidence came from', () => {
    render(banner(rules()));
    expect(screen.getByText('Access or credentials')).toBeInTheDocument();
    expect(screen.getByText('rule access/http-401-403')).toBeInTheDocument();
    expect(screen.getByText('error NU1301: … 401 (Unauthorized).')).toBeInTheDocument();
    expect(screen.getByText(/Check the reported credential/)).toBeInTheDocument();
    expect(screen.getByText("Based on attempt 3's log")).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
  });

  it('labels an unclear cause plainly, without a matched line', () => {
    render(banner(rules({ evidenceActivityId: null, category: 'unknown', label: 'Cause unclear', suggestion: 'Inspect the source log; the available evidence does not establish a likely cause.', rules: { version: 'failure-triage-rules/v1', category: 'unknown', ruleId: null, matchedLine: null, alsoMatched: [] } })));
    expect(screen.getByText('Cause unclear')).toBeInTheDocument();
    expect(screen.getByText('no usable log')).toBeInTheDocument();
    expect(screen.queryByText('Matched')).not.toBeInTheDocument();
    expect(screen.queryByText(/Based on attempt/)).not.toBeInTheDocument();
  });

  it('confirms in one click, bound to the shown label, and refreshes the drawer', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const prompt = vi.spyOn(window, 'prompt');
    render(banner(rules(), onChanged));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(mocked.recordFailureTriageFeedback).toHaveBeenCalledWith('AF-7', { sourceActivityId: 12, shownCategory: 'access', action: 'confirm' });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(prompt).not.toHaveBeenCalled();
    prompt.mockRestore();
  });

  it('corrects through an inline, keyboard-focused form with an optional note', async () => {
    const user = userEvent.setup();
    render(banner(rules()));
    await user.click(screen.getByRole('button', { name: 'Correct category' }));
    const select = screen.getByLabelText('Category');
    expect(select).toHaveFocus();
    await user.selectOptions(select, 'infrastructure');
    await user.type(screen.getByLabelText('Optional note'), '  feed was down  ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocked.recordFailureTriageFeedback).toHaveBeenCalledWith('AF-7', { sourceActivityId: 12, shownCategory: 'access', action: 'correct', category: 'infrastructure', note: 'feed was down' });
    await waitFor(() => expect(screen.queryByLabelText('Category')).not.toBeInTheDocument());
  });

  it('cancel closes the form without saving', async () => {
    const user = userEvent.setup();
    render(banner(rules()));
    await user.click(screen.getByRole('button', { name: 'Correct category' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByLabelText('Category')).not.toBeInTheDocument();
    expect(mocked.recordFailureTriageFeedback).not.toHaveBeenCalled();
  });

  it('a newer failure arriving mid-edit is never labeled by the open form', async () => {
    const user = userEvent.setup();
    const { rerender } = render(banner(rules()));
    await user.click(screen.getByRole('button', { name: 'Correct category' }));
    await user.selectOptions(screen.getByLabelText('Category'), 'configuration');
    rerender(banner(rules({ sourceActivityId: 20, evidenceActivityId: 20, category: 'build_test', label: 'Build or test failure' })));
    expect(screen.getByText(/this correction applies to the earlier one/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(mocked.recordFailureTriageFeedback).toHaveBeenCalledWith('AF-7', expect.objectContaining({ sourceActivityId: 12, shownCategory: 'access', category: 'configuration' }));
  });

  it('surfaces a rejected save instead of looking inert', async () => {
    const user = userEvent.setup();
    mocked.recordFailureTriageFeedback.mockRejectedValueOnce(new Error('the failure triage label changed; refresh and try again'));
    render(banner(rules()));
    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('label changed');
  });

  it('shows a human label with its provenance and what the rules said', () => {
    render(banner(rules({
      classifier: 'human', category: 'infrastructure', label: 'Service or resource outage', suggestion: 'Check the reported service availability or resource limit.',
      human: { activityId: 30, sourceActivityId: 12, action: 'correct', category: 'infrastructure', shownCategory: 'access', classifier: 'rules', rulesVersion: 'failure-triage-rules/v1', note: null, actorUserId: 1, actorName: 'Operator', at: '2026-09-25T10:05:00.000Z' },
    })));
    expect(screen.getByText('Human corrected · Operator')).toBeInTheDocument();
    expect(screen.getByText('Rules said')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change category' })).toBeInTheDocument();
  });

  it('pages triage history', async () => {
    const user = userEvent.setup();
    mocked.getFailureTriageHistory
      .mockResolvedValueOnce({ items: [{ sourceActivityId: 12, reason: 'max_attempts', source: 'dispatcher', at: '2026-09-25T10:00:00.000Z', evidenceActivityId: 11, rules: rules().rules, feedback: [] }], nextBeforeId: 12 })
      .mockResolvedValueOnce({ items: [{ sourceActivityId: 5, reason: 'crashed', source: 'dispatcher', at: '2026-09-25T09:00:00.000Z', evidenceActivityId: 5, rules: { ...rules().rules, category: 'build_test' }, feedback: [] }], nextBeforeId: null });
    render(banner(rules()));
    await user.click(screen.getByRole('button', { name: 'Show triage history' }));
    expect(await screen.findByText(/max_attempts · rules: Access or credentials/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load older' }));
    expect(await screen.findByText(/crashed · rules: Build or test failure/)).toBeInTheDocument();
    expect(mocked.getFailureTriageHistory).toHaveBeenLastCalledWith('AF-7', 12);
    expect(screen.queryByRole('button', { name: 'Load older' })).not.toBeInTheDocument();
  });
});

describe('failure banner source log', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reads the evidence note by exact id, even when it is not in recent activity', async () => {
    const user = userEvent.setup();
    mocked.getFailureTriageSource.mockResolvedValue({ id: 11, body: 'failure/v1 — crashed\nLog tail: 401 (Unauthorized)' });
    render(banner(rules()));
    await user.click(screen.getByRole('button', { name: /Show source log/ }));
    expect(await screen.findByText(/Log tail: 401/)).toBeInTheDocument();
    expect(mocked.getFailureTriageSource).toHaveBeenCalledWith('AF-7', 11);
  });

  it('shows a fetch failure (e.g. the task was deleted) instead of spinning', async () => {
    const user = userEvent.setup();
    mocked.getFailureTriageSource.mockRejectedValue(new Error('task not found: AF-7'));
    render(banner(rules()));
    await user.click(screen.getByRole('button', { name: /Show source log/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('task not found');
  });

  it('falls back to recent activity when there is no triage (done/archived tasks)', async () => {
    const user = userEvent.setup();
    const activity = [{ id: 3, taskId: 1, type: 'comment', actor: 'agent', fromStatus: null, toStatus: null, body: 'failure/v1 — old log body', createdAt: '2026-09-25T09:00:00.000Z', actorUserId: null, actorName: null }] as Activity[];
    render(banner(null, vi.fn(), activity));
    expect(screen.queryByText('Likely cause')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show source log/ }));
    expect(screen.getByText('failure/v1 — old log body')).toBeInTheDocument();
    expect(mocked.getFailureTriageSource).not.toHaveBeenCalled();
  });
});
