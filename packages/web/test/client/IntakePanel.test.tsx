import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntakePanel } from '../../client/src/components/IntakePanel.js';
import type { TaskDetail } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    getIntakeHistory: vi.fn(),
    overrideIntake: vi.fn().mockResolvedValue({}),
  },
}));

import { api } from '../../client/src/api.js';

const task = {
  key: 'AF-47',
  intake: {
    state: 'current',
    overridden: false,
    policy: {
      policyVersion: 'intake-policy/v1',
      eligibility: 'attention_required',
      reasons: [{ code: 'not_verifiable', message: 'Acceptance criteria are not verifiable' }],
    },
    assessment: {
      schema: 'intake/v1', taskKey: 'AF-47', sourceRevision: 'rev-1', attemptId: null,
      stage: 'implementation', questionSet: 'intake/questions/v1',
      provider: { name: 'test', model: null }, usage: { inputTokens: null, outputTokens: null },
      assessedAt: '2026-09-21T00:00:00.000Z', latencyMs: 10, status: 'assessed',
      decisions: {
        readiness: { probability: 0.39, parts: { outcomeClear: 0.64, scopeBounded: 0.93, verifiable: 0.39 } },
        complexity: { value: 'large', probabilities: { trivial: 0, small: 0, medium: 0, large: 1, architectural: 0 }, confidence: null },
        risk: { value: 'high', probabilities: { low: 0, medium: 0, high: 1, critical: 0 }, confidence: null },
      },
    },
  },
} as unknown as TaskDetail;

describe('IntakePanel acknowledgement', () => {
  beforeEach(() => vi.clearAllMocks());

  it('acknowledges without opening a browser prompt or requiring a reason', async () => {
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, 'prompt');
    render(<IntakePanel task={task} />);

    await user.click(screen.getByRole('button', { name: 'Acknowledge and continue' }));

    expect(prompt).not.toHaveBeenCalled();
    expect(api.overrideIntake).toHaveBeenCalledWith('AF-47', 'rev-1', undefined);
    prompt.mockRestore();
  });

  it('accepts an optional note through an inline field when requested', async () => {
    const user = userEvent.setup();
    render(<IntakePanel task={task} />);

    await user.click(screen.getByRole('button', { name: 'Add optional note' }));
    await user.type(screen.getByLabelText('Optional acknowledgment note'), '  I reviewed the risk.  ');
    await user.click(screen.getByRole('button', { name: 'Acknowledge and continue' }));

    expect(api.overrideIntake).toHaveBeenCalledWith('AF-47', 'rev-1', 'I reviewed the risk.');
  });
});
