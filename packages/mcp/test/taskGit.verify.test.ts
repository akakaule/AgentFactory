import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import type { Core, GitAuth, RecordVerificationInput } from '@agentfactory/core';
import { makeClient, textOf } from './harness.js';

const clients: Array<Awaited<ReturnType<typeof makeClient>>['client']> = [];
const repos: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const repo of repos.splice(0)) {
    if (dirname(repo) !== realpathSync(tmpdir()) || !basename(repo).startsWith('af-task-verify-') || realpathSync(repo) !== repo) throw new Error('Unexpected temporary fixture path');
    rmSync(repo, { recursive: true, force: true });
  }
});
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

interface FixtureOptions {
  verifyTimeoutMs?: number;
  auth?: GitAuth;
  record?: (key: string, input: RecordVerificationInput) => Promise<unknown>;
}

async function fixture(verifyCommand: string, options: FixtureOptions = {}) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'af-task-verify-')));
  repos.push(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@localhost');
  git(repo, 'commit', '--allow-empty', '-m', 'initial');
  const origin = join(repo, 'origin.git');
  git(repo, 'init', '--bare', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-u', 'origin', 'main');
  const record = vi.fn<(key: string, input: RecordVerificationInput) => Promise<unknown>>();
  const { core, client } = await makeClient(
    { defaultWorkspace: 'test', taskKey: 'AF-1', stage: 'implementation', workerLabel: 'worker',
      ...(options.verifyTimeoutMs !== undefined ? { verifyTimeoutMs: options.verifyTimeoutMs } : {}) },
    (real: Core) => ({
      ...real,
      ...(options.auth ? { resolveGitAuth: () => options.auth! } : {}),
      recordVerification: async (key: string, input: RecordVerificationInput) => {
        record(key, input);
        if (options.record) return options.record(key, input) as never;
        return real.recordVerification(key, input);
      },
    }),
  );
  clients.push(client);
  core.createWorkspace({ name: 'test', repoPath: repo });
  core.updateWorkspace('test', { verifyCommand });
  const task = core.createTask({ workspace: 'test', title: 'Verify', spec: 's', acceptanceCriteria: 'a' });
  core.updateStatus(task.key, 'queued', 'human');
  const claim = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: {} })));
  const call = (action: string) => client.callTool({ name: 'task_git', arguments: { action } });
  expect((await call('prepare')).isError).not.toBe(true);
  const worktree = join(repo, '.worktrees', task.key);
  const verify = async () => {
    const res = await call('verify');
    return { res, body: JSON.parse(textOf(res)) as Record<string, any> };
  };
  return { core, claim, worktree, verify, record, executionId: claim.executionId as string };
}

const recorded = (record: ReturnType<typeof vi.fn>): RecordVerificationInput => {
  expect(record).toHaveBeenCalledTimes(1);
  return record.mock.calls[0]![1] as RecordVerificationInput;
};

// Real git + node subprocesses; slow on Windows under antivirus.
describe('task_git verify', { timeout: 180_000 }, () => {
  it('records a failing command as failed with its exit code', async () => {
    const { verify, record, core, executionId } = await fixture('node -e "process.exit(1)"');
    const { res, body } = await verify();
    expect(res.isError).not.toBe(true);
    expect(body.ok).toBe(true);
    const input = recorded(record);
    expect(input).toMatchObject({ status: 'failed', exitCode: 1, executionId, command: 'node -e "process.exit(1)"' });
    expect(core.latestVerification('AF-1', executionId)).toMatchObject({ status: 'failed', exitCode: 1 });
  });

  it('records a run past the timeout as timed_out', async () => {
    const { verify, record } = await fixture('node -e "setTimeout(()=>{},5000)"', { verifyTimeoutMs: 1000 });
    await verify();
    const input = recorded(record);
    expect(input.status).toBe('timed_out');
    expect(Date.parse(input.finishedAt!) - Date.parse(input.startedAt!)).toBeLessThan(4500);
  });

  it('records a missing executable as errored', async () => {
    const { verify, record } = await fixture('does-not-exist-xyz');
    await verify();
    expect(recorded(record).status).toBe('errored');
  });

  it('records a pass on a clean tree with the HEAD before and after', async () => {
    const { verify, record, worktree } = await fixture('node -e "0"');
    const head = git(worktree, 'rev-parse', 'HEAD');
    await verify();
    const input = recorded(record);
    expect(input).toMatchObject({ status: 'passed', exitCode: 0, headBefore: head, headAfter: head, cleanBefore: true, cleanAfter: true, truncated: false });
    expect(Date.parse(input.startedAt!)).toBeLessThanOrEqual(Date.parse(input.finishedAt!));
  });

  it('records a tree the command dirtied as not clean afterwards', async () => {
    const { verify, record } = await fixture(`node -e "require('fs').writeFileSync('new.txt','x')"`);
    await verify();
    expect(recorded(record)).toMatchObject({ status: 'passed', cleanBefore: true, cleanAfter: false });
  });

  it('keeps the tail of output past the 256 KiB cap', async () => {
    const { verify, record } = await fixture(`node -e "process.stdout.write('x'.repeat(300*1024)+'LAST')"`);
    await verify();
    const input = recorded(record);
    expect(Buffer.byteLength(input.log, 'utf8')).toBeLessThanOrEqual(262144);
    expect(input.log.startsWith('[truncated]')).toBe(true);
    expect(input.log.endsWith('LAST')).toBe(true);
    expect(input.truncated).toBe(true);
  });

  it('redacts the resolved PAT, its header and URL userinfo from the log', async () => {
    const configValue = `Authorization: Basic ${Buffer.from('x-access-token:pat-123').toString('base64')}`;
    const auth: GitAuth = { provider: 'github', remoteUrl: 'https://github.com/o/r.git', originUrl: 'https://github.com/o/r.git',
      configKey: 'http.https://github.com/o/r.git.extraheader', configValue };
    const { verify, record } = await fixture(`node -e "console.log('pat-123 https://x:secret@host')"`, { auth });
    await verify();
    const { log } = recorded(record);
    expect(log).not.toContain('pat-123');
    expect(log).not.toContain('secret');
    expect(log).toContain('[redacted]');
  });

  it('returns ok:false when storing the record fails', async () => {
    const { verify } = await fixture('node -e "0"', { record: () => Promise.reject(new Error('HTTP 500: board unavailable')) });
    const { res, body } = await verify();
    expect(res.isError).toBe(true);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toContain('500');
  });
});
