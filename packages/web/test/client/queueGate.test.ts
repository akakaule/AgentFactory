import { describe, it, expect } from 'vitest';
import { queueBlockMessage } from '../../client/src/queueGate.js';
import type { Task } from '../../client/src/types.js';

const task = (over: Partial<Task>): Task => ({ key: 'AF-1', status: 'backlog', queueGate: null, ...over } as Task);
const reasons = [{ code: 'outcome_unclear' as const, message: 'the requested outcome is unclear' }, { code: 'risk_at_or_above' as const, message: 'risk is high' }];

describe('queueBlockMessage', () => {
  it('names every reason when Task Intelligence blocks queueing', () => {
    expect(queueBlockMessage(task({ queueGate: { action: 'block', reasons } })))
      .toBe('Task Intelligence blocks queueing: the requested outcome is unclear; risk is high');
  });

  it('is null when the task may be queued or only needs an acknowledgment', () => {
    expect(queueBlockMessage(task({ queueGate: { action: 'allow', reasons: [] } }))).toBeNull();
    expect(queueBlockMessage(task({ queueGate: { action: 'acknowledge', reasons } }))).toBeNull();
    expect(queueBlockMessage(task({}))).toBeNull();
  });
});
