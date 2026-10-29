import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import type { Core, GitAuth, RecordVerificationInput } from '@agentfactory/core';
import { makeClient, textOf } from './harness.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const configValue = `Authorization: Basic ${Buffer.from('x-access-token:pat-123').toString('base64')}`;
const auth: GitAuth = { provider: 'github', remoteUrl: 'https://github.com/o/r.git', originUrl: 'https://github.com/o/r.git',
  configKey: 'http.https://github.com/o/r.git.extraheader', configValue };

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** One claimed task with a prepared worktree. The verify command is re-read on every call, so
 *  cases share a fixture and swap the command; each real repo + claim costs seconds on Windows. */
async function fixture(verifyTimeoutMs?: number) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'af-task-verify-')));
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@localhost');
  git(repo, 'commit', '--allow-empty', '-m', 'initial');
  const origin = join(repo, 'origin.git');
  git(repo, 'init', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  const record = vi.fn<(key: string, input: RecordVerificationInput) => void>();
  const state: { reject: Error | null } = { reject: null };
  const { core, client } = await makeClient(
    { defaultWorkspace: 'test', taskKey: 'AF-1', stage: 'implementation', workerLabel: 'worker',
      ...(verifyTimeoutMs !== undefined ? { verifyTimeoutMs } : {}) },
    (real: Core) => ({
      ...real,
      resolveGitAuth: () => auth,
      recordVerification: async (key: string, input: RecordVerificationInput) => {
        record(key, input);
        if (state.reject) throw state.reject;
        return real.recordVerification(key, input);
      },
    }),
  );
  core.createWorkspace({ name: 'test', repoPath: repo });
  const task = core.createTask({ workspace: 'test', title: 'Verify', spec: 's', acceptanceCriteria: 'a' });
  core.updateStatus(task.key, 'queued', 'human');
  const claim = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
  const call = (action: string) => client.callTool({ name: 'task_git', arguments: { action } });
  expect((await call('prepare')).isError).not.toBe(true);
  const verify = async (command: string) => {
    core.updateWorkspace('test', { verifyCommand: command });
    record.mockClear();
    const res = await call('verify');
    return { res, body: JSON.parse(textOf(res)) as Record<string, any> };
  };
  const dispose = async () => {
    await client.close();
    if (dirname(repo) !== realpathSync(tmpdir()) || !basename(repo).startsWith('af-task-verify-') || realpathSync(repo) !== repo) throw new Error('Unexpected temporary fixture path');
    rmSync(repo, { recursive: true, force: true });
  };
  return { core, state, worktree: join(repo, '.worktrees', task.key), verify, record, dispose, executionId: claim.executionId as string };
}

const recorded = (record: Fixture['record']): RecordVerificationInput => {
  expect(record).toHaveBeenCalledTimes(1);
  return record.mock.calls[0]![1];
};

// Real git + node subprocesses; slow on Windows under antivirus.
describe('task_git verify', { timeout: 180_000 }, () => {
  let f: Fixture;
  beforeAll(async () => { f = await fixture(); }, 180_000);
  afterAll(async () => { await f?.dispose(); });
  beforeEach(() => { f.state.reject = null; });

  it('records a failing command as failed with its exit code', async () => {
    const { res, body } = await f.verify('node -e "process.exit(1)"');
    expect(res.isError).not.toBe(true);
    expect(body.ok).toBe(true);
    expect(recorded(f.record)).toMatchObject({ status: 'failed', exitCode: 1, executionId: f.executionId, command: 'node -e "process.exit(1)"' });
    expect(f.core.latestVerification('AF-1', f.executionId)).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('records a missing executable as errored', async () => {
    await f.verify('does-not-exist-xyz');
    expect(recorded(f.record).status).toBe('errored');
  });

  it('records a pass on a clean tree with the HEAD before and after', async () => {
    const head = git(f.worktree, 'rev-parse', 'HEAD');
    await f.verify('node -e "0"');
    const input = recorded(f.record);
    expect(input).toMatchObject({ status: 'passed', exitCode: 0, headBefore: head, headAfter: head, cleanBefore: true, cleanAfter: true, truncated: false });
    expect(Date.parse(input.startedAt!)).toBeLessThanOrEqual(Date.parse(input.finishedAt!));
  });

  it('keeps the tail of output past the 256 KiB cap', async () => {
    await f.verify(`node -e "process.stdout.write('x'.repeat(300*1024)+'LAST')"`);
    const input = recorded(f.record);
    expect(Buffer.byteLength(input.log, 'utf8')).toBeLessThanOrEqual(262144);
    expect(input.log.startsWith('[truncated]')).toBe(true);
    expect(input.log.endsWith('LAST')).toBe(true);
    expect(input.truncated).toBe(true);
  });

  it('redacts the resolved PAT, its header and URL userinfo from the log', async () => {
    await f.verify(`node -e "console.log('pat-123 https://x:secret@host')"`);
    const { log } = recorded(f.record);
    expect(log).not.toContain('pat-123');
    expect(log).not.toContain('secret');
    expect(log).toContain('[redacted]');
  });

  it('returns ok:false when storing the record fails', async () => {
    f.state.reject = new Error('HTTP 500: board unavailable');
    const { res, body } = await f.verify('node -e "0"');
    expect(res.isError).toBe(true);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain('500');
  });

  // Last: it leaves the tree dirty.
  it('records a tree the command dirtied as not clean afterwards', async () => {
    await f.verify(`node -e "require('fs').writeFileSync('new.txt','x')"`);
    expect(recorded(f.record)).toMatchObject({ status: 'passed', cleanBefore: true, cleanAfter: false });
  });
});

describe('task_git verify timeout', { timeout: 180_000 }, () => {
  it('records a run past the timeout as timed_out', async () => {
    const f = await fixture(1000);
    try {
      await f.verify('node -e "setTimeout(()=>{},5000)"');
      const input = recorded(f.record);
      expect(input.status).toBe('timed_out');
      expect(Date.parse(input.finishedAt!) - Date.parse(input.startedAt!)).toBeLessThan(4500);
    } finally { await f.dispose(); }
  });
});
