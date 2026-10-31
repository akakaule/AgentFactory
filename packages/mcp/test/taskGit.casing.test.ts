import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import type { Core, RecordVerificationInput } from '@agentfactory/core';
import { makeClient, textOf } from './harness.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * A workspace stored as `c:\…` must still verify in `C:\…`: Vite/vitest key modules by path string,
 * so a lowercase drive letter loads vitest twice and every test file fails at collection with
 * "Cannot read properties of undefined (reading 'config')" (AF-195).
 */
describe.skipIf(process.platform !== 'win32')('task_git on a workspace path with a lowercase drive letter', { timeout: 180_000 }, () => {
  it('runs verify in the canonical, native-cased worktree path', async () => {
    const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'af-task-casing-')));
    const lowered = repo[0]!.toLowerCase() + repo.slice(1);
    expect(lowered).not.toBe(repo); // the fixture really differs in drive-letter case
    try {
      git(repo, 'init', '-b', 'main');
      git(repo, 'config', 'user.name', 'Test');
      git(repo, 'config', 'user.email', 'test@localhost');
      git(repo, 'commit', '--allow-empty', '-m', 'initial');
      const record = vi.fn<(key: string, input: RecordVerificationInput) => void>();
      const { core, client } = await makeClient(
        { defaultWorkspace: 'test', taskKey: 'AF-1', stage: 'implementation', workerLabel: 'worker' },
        (real: Core) => ({
          ...real,
          recordVerification: async (key: string, input: RecordVerificationInput) => { record(key, input); return real.recordVerification(key, input); },
        }),
      );
      try {
        core.createWorkspace({ name: 'test', repoPath: lowered });
        core.updateWorkspace('test', { verifyCommand: 'node -e "console.log(\'cwd=\' + process.cwd())"' });
        const task = core.createTask({ workspace: 'test', title: 'Casing', spec: 's', acceptanceCriteria: 'a' });
        core.updateStatus(task.key, 'queued', 'human');
        await client.callTool({ name: 'get_next_task', arguments: {} });
        const call = (action: string) => client.callTool({ name: 'task_git', arguments: { action } });
        expect((await call('prepare')).isError).not.toBe(true);

        const res = await call('verify');
        expect(res.isError, textOf(res)).not.toBe(true);
        expect(record).toHaveBeenCalledTimes(1);
        expect(record.mock.calls[0]![1].log).toContain(`cwd=${join(repo, '.worktrees', 'AF-1')}`);
      } finally {
        await client.close();
      }
    } finally {
      if (dirname(repo).toLowerCase() !== realpathSync.native(tmpdir()).toLowerCase() || !basename(repo).startsWith('af-task-casing-')) throw new Error('Unexpected temporary fixture path');
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
