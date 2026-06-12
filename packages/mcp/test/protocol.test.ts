import { describe, it, expect } from 'vitest';
import { buildProtocol } from '../src/protocol.js';

// Windows repoPaths (c:\Git\...) pasted into a POSIX shell lose their backslashes —
// the worktree lands at a mangled relative path. The protocol must only ever emit
// forward-slash paths, quoted in command strings.
describe('buildProtocol path hygiene', () => {
  it('normalizes a Windows backslash repoPath to forward slashes everywhere', () => {
    const p = buildProtocol({
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
      repoPath: 'c:\\Git\\AgentFactory\\',
      key: 'AF-1',
      branch: 'feature/AF-1-z',
      branchCreated: true,
    });
    expect(p.worktree).toBe('c:/Git/AgentFactory/.worktrees/AF-1');
  });
});
