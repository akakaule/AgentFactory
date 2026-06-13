import { describe, it, expect } from 'vitest';
import { buildProtocol } from '../src/protocol.js';

// Windows repoPaths (c:\Git\...) pasted into a POSIX shell lose their backslashes —
// the worktree lands at a mangled relative path. The protocol must only ever emit
// forward-slash paths, quoted in command strings.
describe('buildProtocol path hygiene', () => {
  it('normalizes a Windows backslash repoPath to forward slashes everywhere', () => {
    const p = buildProtocol({
      stage: 'implementation',
      repoPath: 'c:\\Git\\AgentFactory',
      key: 'AF-13',
      branch: 'feature/AF-13-x',
      branchCreated: true,
    });
    expect(p.worktree).toBe('c:/Git/AgentFactory/.worktrees/AF-13');
    for (const cmd of [...p.setup, ...p.finish]) expect(cmd).not.toContain('\\');
  });

  it('quotes the worktree path in commands so paths with spaces survive', () => {
    const p = buildProtocol({
      stage: 'implementation',
      repoPath: 'c:/My Repos/App',
      key: 'AF-9',
      branch: 'feature/AF-9-y',
      branchCreated: false,
    });
    expect(p.setup[0]).toBe('git worktree add "c:/My Repos/App/.worktrees/AF-9" feature/AF-9-y');
    expect(p.finish).toContain('git worktree remove "c:/My Repos/App/.worktrees/AF-9" && git worktree prune');
  });

  it('trims trailing slashes on repoPath before composing', () => {
    const p = buildProtocol({
      stage: 'implementation',
      repoPath: 'c:\\Git\\AgentFactory\\',
      key: 'AF-1',
      branch: 'feature/AF-1-z',
      branchCreated: true,
    });
    expect(p.worktree).toBe('c:/Git/AgentFactory/.worktrees/AF-1');
  });
});

// One protocol per stage: doc stages carry no git at all — their deliverable goes
// through submit_result fields; only the implementation stage gets branch/worktree.
describe('buildProtocol stage shapes', () => {
  it('description stage: no branch, no worktree, no git commands, doc-submit finish', () => {
    const p = buildProtocol({ stage: 'description', repoPath: 'c:\\Git\\App', key: 'AF-2' });
    expect(p.version).toBe(3);
    expect(p.stage).toBe('description');
    expect(p.setup).toEqual([]);
    expect('branch' in p).toBe(false);
    expect('worktree' in p).toBe(false);
    const finish = p.finish.join('\n');
    expect(finish).toContain('acceptanceCriteria');
    expect(finish).toContain('submit_result');
    expect(finish).not.toMatch(/git /);
  });

  it('plan stage: read-only repo reference (forward slashes), plan-submit finish', () => {
    const p = buildProtocol({ stage: 'plan', repoPath: 'c:\\Git\\App', key: 'AF-3' });
    expect(p.version).toBe(3);
    expect(p.stage).toBe('plan');
    expect(p.setup).toEqual([]);
    const finish = p.finish.join('\n');
    expect(finish).toContain('c:/Git/App');
    expect(finish).not.toContain('\\');
    expect(finish).toContain('plan');
    expect(finish).toContain('submit_result');
    expect(finish).not.toMatch(/git worktree|git push|git commit/);
  });

  it('implementation stage carries the stage discriminator alongside branch/worktree', () => {
    const p = buildProtocol({
      stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-4',
      branch: 'feature/AF-4-w', branchCreated: true,
    });
    expect(p.version).toBe(3);
    expect(p.stage).toBe('implementation');
    expect(p.branch).toBe('feature/AF-4-w');
    expect(p.worktree).toBe('c:/Git/App/.worktrees/AF-4');
  });
});
