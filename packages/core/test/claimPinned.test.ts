import { describe, it, expect } from 'vitest';
import { openCore } from '../src/index.js';

describe('dispatcher-pinned claims', () => {
  it('claims only the intended key and stage, preserving dependency readiness', () => {
    const core = openCore(':memory:');
    {
      const create = (title: string, stage: 'plan' | 'implementation') => {
        const t = core.createTask({ title, spec: 's', acceptanceCriteria: 'a', stage });
        core.updateStatus(t.key, 'queued', 'human');
        return t.key;
      };
      const first = create('Plan', 'plan');
      const second = create('Implementation', 'implementation');
      core.addTaskDependency(second, first);
      expect(core.claimNextTask({ taskKey: second, stage: 'implementation', claimedBy: 'impl' })).toBeNull();
      core.removeTaskDependency(second, first);
      expect(core.claimNextTask({ taskKey: second, stage: 'plan' })).toBeNull();
      expect(core.claimNextTask({ taskKey: second, stage: 'implementation', claimedBy: 'impl' })?.key).toBe(second);
      expect(core.claimNextTask({ taskKey: second, stage: 'implementation', claimedBy: 'impl' })?.key).toBe(second);
      expect(core.claimNextTask({ taskKey: second, stage: 'implementation', claimedBy: 'other' })).toBeNull();
      expect(core.claimNextTask({ taskKey: first, stage: 'plan', claimedBy: 'impl' })).toBeNull();
      core.createWorkspace({ name: 'other', repoPath: '/other' });
      expect(core.claimNextTask({ taskKey: first, stage: 'plan', workspace: 'other' })).toBeNull();
      expect(core.claimNextTask()?.key).toBe(first);
    }
  });
});
