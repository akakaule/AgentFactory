import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IntakeChip } from '../../client/src/components/IntakeChip.js';
import type { Task } from '../../client/src/types.js';

const task = (over: Partial<Task>): Task => ({ key: 'AF-1', intake: null, intakeHold: null, ...over } as Task);

describe('IntakeChip', () => {
  it('shows a held task waiting for its intake assessment, with the hold deadline', () => {
    render(<IntakeChip task={task({ intakeHold: { until: '2026-10-23T14:10:00.000Z' } })} />);
    const chip = screen.getByText('Waiting for intake');
    expect(chip.getAttribute('title')).toMatch(/Held until .+ while Task Intelligence assesses the written spec/);
  });

  it("says a blocked task can't be queued, with the reasons as its title", () => {
    render(<IntakeChip task={task({ queueGate: { action: 'block', reasons: [{ code: 'outcome_unclear', message: 'the requested outcome is unclear' }] } })} />);
    expect(screen.getByText("Can't queue").getAttribute('title')).toBe('Task Intelligence blocks queueing: the requested outcome is unclear');
  });

  it('shows nothing for a task that is neither held nor flagged', () => {
    const { container } = render(<IntakeChip task={task({})} />);
    expect(container.textContent).toBe('');
  });
});
