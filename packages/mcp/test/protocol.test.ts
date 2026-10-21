import { describe, it, expect } from 'vitest';
import { buildProtocol } from '../src/protocol.js';

it.each([true, false])('requires isolated npm workspace dependencies before verification (managed Git: %s)', (managedGit) => {
  const p = buildProtocol({ stage: 'implementation', repoPath: 'C:/Git/AgentFactory', key: 'AF-147',
    branch: 'feature/AF-147-notifications', branchCreated: false, managedGit });
  const setup = p.setup.join('\n');
  expect(setup).toContain('npm ci --cache .npm-cache');
  expect(setup).toContain('package-lock.json');
  expect(setup).toContain('worktree');
  expect(setup).toContain('parent checkout');
  expect(setup).toContain('build before running tests');
});

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
    expect(p.version).toBe(8);
    expect(p.stage).toBe('description');
    expect(p.setup).toEqual([]);
    expect('branch' in p).toBe(false);
    expect('worktree' in p).toBe(false);
    const finish = p.finish.join('\n');
    expect(finish).toContain('acceptanceCriteria');
    expect(finish).toContain('submit_result');
    expect(finish).toContain('Write the spec'); // the spec stage: implementation follows it directly
    expect(finish).not.toMatch(/git /);
  });

  it('plan stage: read-only repo reference (forward slashes), plan-submit finish', () => {
    const p = buildProtocol({ stage: 'plan', repoPath: 'c:\\Git\\App', key: 'AF-3' });
    expect(p.version).toBe(8);
    expect(p.stage).toBe('plan');
    expect(p.setup).toEqual([]);
    const finish = p.finish.join('\n');
    expect(finish).toContain('c:/Git/App');
    expect(finish).not.toContain('\\');
    expect(finish).toContain('plan');
    expect(finish).toContain('submit_result');
    expect(finish).not.toMatch(/git worktree|git push|git commit/);
  });

  // The board wraps text itself; column-wrapped prose renders as a ragged narrow block there.
  it.each(['description', 'plan'] as const)('%s stage tells the writer not to hard-wrap prose', (stage) => {
    const p = buildProtocol({ stage, repoPath: 'c:/Git/App', key: 'AF-4' });
    expect(p.finish.join(' ')).toMatch(/do NOT hard-wrap/);
  });

  it('implementation stage carries the stage discriminator alongside branch/worktree', () => {
    const p = buildProtocol({
      stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-4',
      branch: 'feature/AF-4-w', branchCreated: true,
    });
    expect(p.version).toBe(8);
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

  it('implementation finish includes CI lint, formatting and type checks before push by default', () => {
    const p = buildProtocol({
      stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-7',
      branch: 'feature/AF-7-y', branchCreated: true,
    });
    expect(p.finish.join('\n')).toMatch(/tests and build/i);
    const verifyIdx = p.finish.findIndex(s => /formatting/.test(s));
    expect(verifyIdx).toBeGreaterThanOrEqual(0);
    expect(verifyIdx).toBeLessThan(p.finish.findIndex(s => s.includes('git push')));
    expect(p.finish[verifyIdx]).toMatch(/lint.*formatting.*type checks/);
  });
});

// A fresh task branch is created from the latest default branch; reclaims reuse the
// existing pushed branch untouched (re-basing would diverge from its open PR).
describe('buildProtocol worktree base', () => {
  const impl = (extra: Record<string, unknown>) =>
    buildProtocol({ stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-5', branch: 'feature/AF-5-a', ...extra } as Parameters<typeof buildProtocol>[0]);

  it('first claim with a fetchable base: git fetch, then create the branch from that ref', () => {
    const p = impl({ branchCreated: true, base: { ref: 'origin/main', fetch: true } });
    expect(p.setup.slice(0, -1)).toEqual([
      'git fetch origin',
      'git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a origin/main',
    ]);
  });

  it('first claim with a no-fetch base (local default, no origin): create from the ref, no fetch', () => {
    const p = impl({ branchCreated: true, base: { ref: 'master', fetch: false } });
    expect(p.setup.slice(0, -1)).toEqual(['git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a master']);
  });

  it('first claim without a resolvable base: falls back to branching from current HEAD', () => {
    const p = impl({ branchCreated: true });
    expect(p.setup.slice(0, -1)).toEqual(['git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a']);
  });

  it('reclaim ignores any base and reuses the existing branch (no -b, no fetch)', () => {
    const p = impl({ branchCreated: false, base: { ref: 'origin/main', fetch: true } });
    // reuse-first so a real reclaim keeps its commits; create-fallback recovers a branch a
    // prior claim named but died before creating (no base ref on a reclaim → from HEAD).
    expect(p.setup.slice(0, -1)).toEqual([
      'git worktree add "c:/Git/App/.worktrees/AF-5" feature/AF-5-a || git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a',
    ]);
  });

  it('reclaim recovers (does not strand) when the named branch was never created', () => {
    // Stranding scenario: first claim persisted the branch name, then died before its
    // `git worktree add -b` ran, so the ref does not exist. The reclaim setup must contain a
    // create fallback so `git worktree add <wt> <branch>` failing does not brick the task.
    const p = impl({ branchCreated: false });
    expect(p.setup.slice(0, -1)).toHaveLength(1);
    expect(p.setup[0]).toContain(' || git worktree add ');
    expect(p.setup[0]!.endsWith('-b feature/AF-5-a')).toBe(true);
  });

  it('rejects an unsafe base ref (defense-in-depth) and falls back to current HEAD', () => {
    const p = impl({ branchCreated: true, base: { ref: '--upload-pack=evil', fetch: false } });
    expect(p.setup.slice(0, -1)).toEqual(['git worktree add "c:/Git/App/.worktrees/AF-5" -b feature/AF-5-a']);
  });
});

// Protocol v7: the worker never opens a PR. It pushes before review; the watcher opens the PR
// after the implementation review is approved (GitHub and Azure DevOps alike).
describe('buildProtocol: criterion claims (v8)', () => {
  const impl = (criteria?: Array<{ id: string; name: string | null }>) =>
    buildProtocol({ stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-9', branch: 'feature/AF-9-x', branchCreated: true, ...(criteria ? { criteria } : {}) });

  it('the submit step asks for one claim per criterion and lists the task\'s ids', () => {
    const submit = impl([{ id: 'AC1', name: 'Race' }, { id: 'AC2', name: null }, { id: 'AC3', name: 'Logs' }]).finish.find((s) => s.includes('submit_result'))!;
    expect(submit).toContain('`criteria`: one `{ id, claim }` per acceptance criterion');
    expect(submit).toContain('which test proves it');
    expect(submit).toContain('Ids: AC1 Race, AC2, AC3 Logs.');
  });

  it('asks for no claims when the task has no criteria', () => {
    for (const p of [impl(), impl([])]) expect(p.finish.join('\n')).not.toContain('`criteria`');
  });

  it('the spec stage asks for numbered, named acceptance criteria so they parse', () => {
    const finish = buildProtocol({ stage: 'description', repoPath: 'c:/Git/App', key: 'AF-2' }).finish.join('\n');
    expect(finish).toContain('Write the acceptance criteria as a numbered list, one verifiable criterion per item, each starting with a short name and a dash (`4. Race — two supervisors …`).');
  });
});

describe('buildProtocol: no worker PR step (v7)', () => {
  const impl = (extra: Record<string, unknown>) =>
    buildProtocol({ stage: 'implementation', repoPath: 'c:/Git/App', key: 'AF-8', branch: 'feature/AF-8-pr', branchCreated: true, ...extra } as Parameters<typeof buildProtocol>[0]);

  it('emits no gh pr step and asks for no PR link, plain or managed git', () => {
    for (const p of [impl({}), impl({ managedGit: true })]) {
      const all = [...p.setup, ...p.finish].join('\n');
      expect(all).not.toContain('gh pr');
      expect(all).not.toContain("(kind 'pr')");
    }
  });

  it('still pushes before removing the worktree and submitting (push before review)', () => {
    const p = impl({});
    const pushIdx = p.finish.findIndex((s) => s.includes('git push'));
    const removeIdx = p.finish.findIndex((s) => s.includes('git worktree remove'));
    const submitIdx = p.finish.findIndex((s) => s.includes('submit_result'));
    expect(pushIdx).toBeGreaterThanOrEqual(0);
    expect(pushIdx).toBeLessThan(removeIdx);
    expect(removeIdx).toBeLessThan(submitIdx);
  });
});
