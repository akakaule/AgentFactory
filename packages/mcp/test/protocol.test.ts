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
    expect(p.setup[0]).toBe(
      'git worktree add "c:/My Repos/App/.worktrees/AF-9" feature/AF-9-y || git worktree add "c:/My Repos/App/.worktrees/AF-9" -b feature/AF-9-y',
    );
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
    expect(p.version).toBe(6);
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
    expect(p.version).toBe(6);
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
    expect(p.version).toBe(6);
    expect(p.stage).toBe('implementation');
    expect(p.branch).toBe('feature/AF-4-w');
    expect(p.worktree).toBe('c:/Git/App/.worktrees/AF-4');
  });

  it('implementation finish runs the workspace verify command before push and worktree removal', () => {
    const p = buildProtocol({
      stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-6',
      branch: 'feature/AF-6-x', branchCreated: true, verifyCommand: 'npm test && npm run build',
    });
    if (p.stage !== 'implementation') throw new Error('expected implementation protocol');
    const verifyIdx = p.finish.findIndex((s) => s.includes('npm test && npm run build'));
    const pushIdx = p.finish.findIndex((s) => s.includes('git push'));
    const removeIdx = p.finish.findIndex((s) => s.includes('git worktree remove'));
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeLessThan(pushIdx);   // must pass before pushing
    expect(verifyIdx).toBeLessThan(removeIdx); // runs while the worktree still exists
    expect(p.finish.join('\n')).toContain('verification');
  });

  it('implementation finish falls back to repo tests + build when no verify command is configured', () => {
    const p = buildProtocol({
      stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-7',
      branch: 'feature/AF-7-y', branchCreated: true,
    });
    expect(p.finish.join('\n')).toMatch(/tests and build/i);
  });
});

// A fresh task branch is created from the latest default branch; reclaims reuse the
// existing pushed branch untouched (re-basing would diverge from its open PR).
describe('buildProtocol worktree base', () => {
  const impl = (extra: Record<string, unknown>) =>
    buildProtocol({ stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-5', branch: 'feature/AF-5-a', ...extra } as Parameters<typeof buildProtocol>[0]);

  it('first claim with a fetchable base: git fetch, then create the branch from that ref', () => {
    const p = impl({ branchCreated: true, base: { ref: 'origin/main', fetch: true } });
    expect(p.setup).toEqual([
      'git fetch origin',
      'git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a origin/main',
    ]);
  });

  it('first claim with a no-fetch base (local default, no origin): create from the ref, no fetch', () => {
    const p = impl({ branchCreated: true, base: { ref: 'master', fetch: false } });
    expect(p.setup).toEqual(['git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a master']);
  });

  it('first claim without a resolvable base: falls back to branching from current HEAD', () => {
    const p = impl({ branchCreated: true });
    expect(p.setup).toEqual(['git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a']);
  });

  it('reclaim ignores any base and reuses the existing branch (no -b, no fetch)', () => {
    const p = impl({ branchCreated: false, base: { ref: 'origin/main', fetch: true } });
    // reuse-first so a real reclaim keeps its commits; create-fallback recovers a branch a
    // prior claim named but died before creating (no base ref on a reclaim → from HEAD).
    expect(p.setup).toEqual([
      'git worktree add "c:/Git/App/.worktrees/AF-5" feature/AF-5-a || git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a',
    ]);
  });

  it('reclaim recovers (does not strand) when the named branch was never created', () => {
    // Stranding scenario: first claim persisted the branch name, then died before its
    // `git worktree add -b` ran, so the ref does not exist. The reclaim setup must contain a
    // create fallback so `git worktree add <wt> <branch>` failing does not brick the task.
    const p = impl({ branchCreated: false });
    expect(p.setup).toHaveLength(1);
    expect(p.setup[0]).toContain(' || git worktree add ');
    expect(p.setup[0]!.endsWith('-b feature/AF-5-a')).toBe(true);
  });

  it('rejects an unsafe base ref (defense-in-depth) and falls back to current HEAD', () => {
    const p = impl({ branchCreated: true, base: { ref: '--upload-pack=evil', fetch: false } });
    expect(p.setup).toEqual(['git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a']);
  });
});

// When origin is GitHub, the finish protocol opens/updates a PR after the push.
describe('buildProtocol GitHub PR step', () => {
  const impl = (extra: Record<string, unknown>) =>
    buildProtocol({ stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-8', branch: 'feature/AF-8-pr', branchCreated: true, ...extra } as Parameters<typeof buildProtocol>[0]);

  it('emits a gh pr step after push and before worktree removal, with --base and a pr link', () => {
    const p = impl({ github: { defaultBranch: 'main' } });
    if (p.stage !== 'implementation') throw new Error('expected implementation protocol');
    const prIdx = p.finish.findIndex((s) => s.includes('gh pr'));
    const pushIdx = p.finish.findIndex((s) => s.includes('git push'));
    const removeIdx = p.finish.findIndex((s) => s.includes('git worktree remove'));
    expect(prIdx).toBeGreaterThan(pushIdx);
    expect(prIdx).toBeLessThan(removeIdx);
    expect(p.finish[prIdx]).toContain('gh pr create --head feature/AF-8-pr --base main --fill');
    expect(p.finish.join('\n')).toContain("the PR link (kind 'pr')");
  });

  it('omits --base when the default branch is unknown (gh picks the repo default)', () => {
    const p = impl({ github: { defaultBranch: null } });
    const pr = p.finish.find((s) => s.includes('gh pr'))!;
    expect(pr).toContain('gh pr create --head feature/AF-8-pr --fill');
    expect(pr).not.toContain('--base');
  });

  it('emits no gh pr step when origin is not GitHub', () => {
    const p = impl({});
    expect(p.finish.join('\n')).not.toContain('gh pr');
    expect(p.finish.join('\n')).not.toContain("(kind 'pr')");
  });
});
