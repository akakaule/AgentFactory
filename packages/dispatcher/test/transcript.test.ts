import { describe, it, expect } from 'vitest';
import { encodeProjectDir } from '../src/transcript.js';

describe('encodeProjectDir', () => {
  it('flattens a Windows absolute path to the projects-dir name', () => {
    expect(encodeProjectDir('C:\\Git\\AgentFactory')).toBe('C--Git-AgentFactory');
  });

  it('flattens a POSIX absolute path', () => {
    expect(encodeProjectDir('/home/u/proj')).toBe('-home-u-proj');
  });

  it('flattens dots (e.g. a worktree path)', () => {
    expect(encodeProjectDir('/a/.worktrees/AF-1')).toBe('-a--worktrees-AF-1');
  });
});
