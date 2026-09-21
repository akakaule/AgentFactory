import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { makeClient, textOf } from './harness.js';

const clients: Array<Awaited<ReturnType<typeof makeClient>>['client']> = [];
const repos: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const repo of repos.splice(0)) {
    if (dirname(repo) !== realpathSync(tmpdir()) || !basename(repo).startsWith('af-task-git-') || realpathSync(repo) !== repo) throw new Error('Unexpected temporary fixture path');
    rmSync(repo, { recursive: true, force: true });
  }
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
async function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'af-task-git-')));
  repos.push(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@localhost');
  git(repo, 'commit', '--allow-empty', '-m', 'initial');
  const origin = join(repo, 'origin.git');
  git(repo, 'init', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  const { core, client } = await makeClient({ defaultWorkspace: 'test', taskKey: 'AF-1', stage: 'implementation', workerLabel: 'worker' });
  clients.push(client);
  core.createWorkspace({ name: 'test', repoPath: repo });
  const task = core.createTask({ workspace: 'test', title: 'Git lifecycle', spec: 's', acceptanceCriteria: 'a' });
  core.updateStatus(task.key, 'queued', 'human');
  const claim = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
  const call = (action: string, extra = {}) => client.callTool({ name: 'task_git', arguments: { action, ...extra } });
  return { repo, origin, core, client, claim, call, worktree: join(repo, '.worktrees', task.key) };
}

describe('task-scoped Git lifecycle', { timeout: 30_000 }, () => {
  it('inspects preserved changes and refuses a dirty merge', async () => {
    const { call, worktree } = await fixture();
    await call('prepare');
    writeFileSync(join(worktree, 'unknown.txt'), 'preserve me');
    const status = JSON.parse(textOf(await call('status')));
    expect(status.files).toContainEqual({ status: '??', path: 'unknown.txt' });
    expect(JSON.parse(textOf(await call('log'))).commits).not.toHaveLength(0);
    expect(JSON.parse(textOf(await call('diff'))).untracked).toContain('unknown.txt');
    expect((await call('merge_default')).isError).toBe(true);
    expect(readFileSync(join(worktree, 'unknown.txt'), 'utf8')).toBe('preserve me');
  });

  it('returns conflicts, resumes an interrupted merge, and publishes without force', async () => {
    const { repo, origin, call, worktree, core } = await fixture();
    writeFileSync(join(repo, 'shared.txt'), 'base\n');
    git(repo, 'add', 'shared.txt'); git(repo, 'commit', '-m', 'base'); git(repo, 'push');
    await call('prepare');
    writeFileSync(join(worktree, 'shared.txt'), 'task\n');
    await call('commit', { message: 'feat: task change' });
    await call('push');
    writeFileSync(join(repo, 'shared.txt'), 'main\n');
    git(repo, 'add', 'shared.txt'); git(repo, 'commit', '-m', 'main change'); git(repo, 'push');
    const merged = JSON.parse(textOf(await call('merge_default')));
    expect(merged.mergeState).toBe('conflicts');
    expect(merged.conflicts).toEqual(['shared.txt']);
    expect((await call('continue_merge', { message: 'merge: main' })).isError).toBe(true);
    expect((await call('push')).isError).toBe(true);
    expect((await call('cleanup')).isError).toBe(true);
    expect((await call('commit', { message: 'fix: bypass' })).isError).toBe(true);
    expect((await call('prepare')).isError).not.toBe(true);
    expect(JSON.parse(textOf(await call('status'))).mergeHead).toBe(merged.targetSha);
    writeFileSync(join(worktree, 'shared.txt'), 'resolved\n');
    expect((await call('continue_merge', { message: 'merge: reconcile main' })).isError).not.toBe(true);
    expect(git(worktree, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3);
    expect((await call('push')).isError).not.toBe(true);
    expect(git(origin, 'rev-parse', core.getTask('AF-1').branch!)).toBe(git(worktree, 'rev-parse', 'HEAD'));
    core.updateStatus('AF-1', 'blocked', 'agent');
    for (const action of ['status', 'diff', 'log', 'merge_default', 'continue_merge']) expect((await call(action)).isError).toBe(true);
  }, 90_000);

  it('merges a clean default-branch update idempotently', async () => {
    const { repo, call, worktree } = await fixture();
    await call('prepare');
    writeFileSync(join(repo, 'new.txt'), 'main update');
    git(repo, 'add', 'new.txt'); git(repo, 'commit', '-m', 'main update'); git(repo, 'push');
    expect(JSON.parse(textOf(await call('merge_default'))).mergeState).toBe('merged');
    const head = git(worktree, 'rev-parse', 'HEAD');
    expect((await call('merge_default')).isError).not.toBe(true);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(head);
    expect(readFileSync(join(worktree, 'new.txt'), 'utf8')).toBe('main update');
  });
  it('routes the pinned worker protocol through task_git', async () => {
    const { claim } = await fixture();
    expect(claim.protocol.setup.join('\n')).toContain('task_git');
    expect(claim.protocol.finish.join('\n')).toContain('task_git');
    expect(claim.protocol.setup.join('\n')).not.toContain('git worktree add');
  });

  it('prepares a missing persisted branch, commits only its worktree, publishes and removes it', async () => {
    const { repo, origin, worktree, call, core } = await fixture();
    const branch = core.getTask('AF-1').branch!;
    writeFileSync(join(repo, 'root-dirty.txt'), 'preserve root work');
    expect((await call('prepare')).isError).not.toBe(true);
    expect((await call('prepare')).isError).not.toBe(true); // retry preserves work
    writeFileSync(join(worktree, 'change.txt'), 'task change');
    writeFileSync(join(worktree, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(worktree, 'node_modules'));
    writeFileSync(join(worktree, 'node_modules', 'cache.txt'), 'ignored build artifact');
    expect((await call('cleanup')).isError).toBe(true);
    expect((await call('commit', { message: 'fix: task change' })).isError).not.toBe(true);
    expect(git(worktree, 'ls-tree', '--name-only', 'HEAD').split(/\r?\n/)).toEqual(['.gitignore', 'change.txt']);
    expect((await call('cleanup')).isError).toBe(true); // unpublished commits survive
    expect((await call('push')).isError).not.toBe(true);
    expect(git(origin, 'rev-parse', branch)).toBe(git(worktree, 'rev-parse', 'HEAD'));
    expect((await call('cleanup')).isError).not.toBe(true);
    expect(existsSync(worktree)).toBe(false);
    expect(existsSync(join(repo, 'root-dirty.txt'))).toBe(true);
    expect(git(repo, 'branch', '--show-current')).toBe('main');
    // A fresh clone/retry may have only the published ref; preserve its commits.
    const published = git(origin, 'rev-parse', branch);
    git(repo, 'branch', '-D', branch);
    expect((await call('prepare')).isError).not.toBe(true);
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(published);
  });

  it('rejects a lost claim and a worktree switched to another branch', async () => {
    const { core, call, worktree } = await fixture();
    expect((await call('prepare')).isError).not.toBe(true);
    git(worktree, 'checkout', '-b', 'other');
    expect((await call('prepare')).isError).toBe(true);
    expect((await call('commit', { message: 'bad commit' })).isError).toBe(true);
    expect((await call('cleanup')).isError).toBe(true);
    core.updateStatus('AF-1', 'blocked', 'agent');
    expect((await call('prepare')).isError).toBe(true);
    core.updateStatus('AF-1', 'queued', 'human');
    core.claimNextTask({ workspace: 'test', claimedBy: 'different-worker' });
    expect((await call('prepare')).isError).toBe(true);
  });

  it('recreates a cleaned worktree on its published branch while preserving leftover files', async () => {
    const { call, worktree, core } = await fixture();
    expect((await call('prepare')).isError).not.toBe(true);
    writeFileSync(join(worktree, 'change.txt'), 'submitted work');
    expect((await call('commit', { message: 'fix: submitted work' })).isError).not.toBe(true);
    const submitted = git(worktree, 'rev-parse', 'HEAD');
    expect((await call('push')).isError).not.toBe(true);
    expect((await call('cleanup')).isError).not.toBe(true);
    mkdirSync(join(worktree, 'node_modules'), { recursive: true });
    writeFileSync(join(worktree, 'node_modules', 'cache.txt'), 'late cache write');
    writeFileSync(join(worktree, 'notes.txt'), 'preserve unknown files too');
    const result = await call('prepare');
    expect(result.isError).not.toBe(true);
    const restored = JSON.parse(textOf(result));
    expect(dirname(restored.preservedPath)).toBe(dirname(worktree));
    expect(readFileSync(join(restored.preservedPath, 'notes.txt'), 'utf8')).toBe('preserve unknown files too');
    expect(readFileSync(join(restored.preservedPath, 'node_modules', 'cache.txt'), 'utf8')).toBe('late cache write');
    expect(git(worktree, 'rev-parse', 'HEAD')).toBe(submitted);
    expect(git(worktree, 'branch', '--show-current')).toBe(core.getTask('AF-1').branch);
    expect((await call('prepare')).isError).not.toBe(true);
  });

  it('refuses to relocate a registered worktree whose Git marker is missing', async () => {
    const { call, worktree } = await fixture();
    expect((await call('prepare')).isError).not.toBe(true);
    rmSync(join(worktree, '.git'));
    writeFileSync(join(worktree, 'notes.txt'), 'keep in place');
    expect((await call('prepare')).isError).toBe(true);
    expect(readFileSync(join(worktree, 'notes.txt'), 'utf8')).toBe('keep in place');
  });

  it('refuses a worktree parent redirected outside its assigned location', async () => {
    const { repo, call } = await fixture();
    const outside = join(repo, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(repo, '.worktrees'), process.platform === 'win32' ? 'junction' : 'dir');
    const result = await call('prepare');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('symlink or junction');
    expect(existsSync(join(outside, 'AF-1'))).toBe(false);
  });

  it('does not expose Git mutations to an unpinned server or planning worker', async () => {
    for (const opts of [{}, { defaultWorkspace: 'test', taskKey: 'AF-1', workerLabel: 'worker', stage: 'plan' as const }]) {
      const { client } = await makeClient(opts);
      clients.push(client);
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain('task_git');
    }
  });
});
