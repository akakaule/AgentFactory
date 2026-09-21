import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync, readdirSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { gitAuthConfigPairs } from '@agentfactory/core';
import type { McpCore } from '../types.js';
import { localizeRepo, taskGitEnabled, type ServerOptions } from '../server.js';
import { resolveDefaultBranchName } from '../git.js';
import { toToolError } from '../errors.js';

const exec = promisify(execFile);
const samePath = (a: string, b: string): boolean => {
  const normalize = (p: string) => process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  return normalize(a) === normalize(b);
};

/** No arbitrary commands, refs, paths or remotes: every target comes from the owned claim. */
export function registerTaskGit(server: McpServer, core: McpCore, opts: ServerOptions): void {
  if (!taskGitEnabled(opts)) return;
  let busy = false;
  server.registerTool('task_git', {
    title: 'Task Git lifecycle',
    description: 'Perform the required Git writes for this server\'s assigned implementation task. ' +
      'Use prepare before coding, commit with a Conventional Commit message, push after tests pass, ' +
      'then cleanup after publishing. Use status/diff/log to inspect work, merge_default to merge origin default, and continue_merge after resolving conflicts. ' +
      'Cleanup refuses dirty or unpublished work. No force push or branch reset is supported.',
    inputSchema: {
      action: z.enum(['prepare', 'status', 'diff', 'log', 'merge_default', 'continue_merge', 'commit', 'push', 'cleanup']),
      message: z.string().trim().min(1).max(4000).optional(),
    },
  }, async ({ action, message }) => {
    if (busy) return toToolError(new Error('A task Git operation is already running.'));
    busy = true;
    let preservedPath: string | undefined;
    let result: Record<string, unknown> = {};
    try {
      const task = localizeRepo(await core.getTask(opts.taskKey!), opts);
      if (task.workspace !== opts.defaultWorkspace || task.claimedBy !== opts.workerLabel ||
          task.status !== 'in_progress' || task.stage !== 'implementation') {
        throw new Error('Git operations require ownership of the pinned active implementation claim.');
      }
      const branch = task.branch;
      if (!/^AF-\d+$/.test(task.key) || !branch?.startsWith(`feature/${task.key}-`) ||
          !/^(?!.*\.\.)(?!.*@\{)[\w./-]+$/.test(branch)) throw new Error('Invalid task branch.');
      if (!isAbsolute(task.repoPath)) throw new Error('Task repository must be absolute.');
      const repo = realpathSync(task.repoPath);
      const parent = join(repo, '.worktrees');
      const worktree = join(parent, task.key);
      for (const path of [parent, worktree]) {
        if (existsSync(path) && !samePath(realpathSync(path), path)) throw new Error('Task worktree path must not traverse a symlink or junction.');
      }
      const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
      // Inherited Git routing must never redirect an operation away from the claimed repo.
      for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES']) delete env[key];
      const auth = await core.resolveGitAuth(task.workspace);
      if (auth) {
        const n = Number(env['GIT_CONFIG_COUNT'] ?? '0') || 0;
        // The dispatcher may already supply this header. Reset Git's multi-valued
        // extraheader before adding the resolved PAT, avoiding duplicate Authorization.
        const pairs: Array<[string, string]> = [[auth.configKey, ''], ...gitAuthConfigPairs(auth)];
        env['GIT_CONFIG_COUNT'] = String(n + pairs.length);
        pairs.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${n + i}`] = key; env[`GIT_CONFIG_VALUE_${n + i}`] = value; });
      }
      const git = async (cwd: string, args: string[]): Promise<string> => {
        try {
          // Fetch/merge may take time. Recheck ownership before every following operation.
          const current = await core.getTask(task.key);
          if (current.status !== 'in_progress' || current.stage !== 'implementation' || current.claimedBy !== task.claimedBy ||
              current.claimedAt !== task.claimedAt || current.branch !== branch || current.workspace !== task.workspace)
            throw new Error('Task claim changed during Git operation.');
          // The broker performs Git bookkeeping only; repository hook scripts belong in
          // the worker's verification command, where the worker's sandbox still applies.
          const { stdout } = await exec('git', ['-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, ...args],
            { cwd, env, windowsHide: true, encoding: 'utf8', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
          return stdout.trimEnd();
        } catch (err) {
          const detail = (err as { stderr?: string }).stderr || (err instanceof Error ? err.message : 'Git could not run.');
          // Never return credential-bearing URLs or managed headers to the worker transcript.
          throw new Error(detail.replace(/https?:\/\/[^\s/@]+@/g, 'https://[redacted]@')
            .replaceAll(auth?.configValue ?? '\0', '[redacted]').slice(-4000));
        }
      };
      const hasRef = async (ref: string) => {
        try { await git(repo, ['show-ref', '--verify', '--quiet', ref]); return true; } catch { return false; }
      };
      if (!samePath(await git(repo, ['rev-parse', '--show-toplevel']), repo)) throw new Error('Task repository must be the checkout root.');
      const common = await git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      const verifyWorktree = async () => {
        if (!existsSync(worktree) || !samePath(await git(worktree, ['rev-parse', '--show-toplevel']), worktree) ||
            !samePath(await git(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']), common) ||
            await git(worktree, ['branch', '--show-current']) !== branch) {
          throw new Error('Task worktree does not match the assigned repository and branch.');
        }
      };
      const mergeHead = async (): Promise<string | null> => {
        const path = await git(worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']);
        return existsSync(resolve(worktree, path)) ? await git(worktree, ['rev-parse', 'MERGE_HEAD']) : null;
      };
      const conflicts = async () => (await git(worktree, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
      const inspect = async () => {
        const entries = (await git(worktree, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
        const files: Array<{ status: string; path: string; originalPath?: string }> = [];
        for (let i = 0; i < entries.length; i++) {
          const entry = entries[i];
          if (!entry) continue;
          const status = entry.slice(0, 2);
          const file: (typeof files)[number] = { status, path: entry.slice(3) };
          if (/[RC]/.test(status)) file.originalPath = entries[++i] ?? '';
          files.push(file);
        }
        const defaultBranch = await resolveDefaultBranchName(repo);
        const defaultRef = defaultBranch ? `refs/remotes/origin/${defaultBranch}` : null;
        const counts = defaultRef && await hasRef(defaultRef)
          ? (await git(worktree, ['rev-list', '--left-right', '--count', `HEAD...${defaultRef}`])).split(/\s+/).map(Number) : null;
        return { head: await git(worktree, ['rev-parse', 'HEAD']), files, mergeHead: await mergeHead(), conflicts: await conflicts(),
          defaultBranch, ahead: counts?.[0] ?? null, behind: counts?.[1] ?? null, comparison: 'last fetched origin default branch' };
      };
      if (action === 'prepare') {
        const registered = (await git(repo, ['worktree', 'list', '--porcelain', '-z'])).split('\0')
          .some(line => line.startsWith('worktree ') && samePath(line.slice(9), worktree));
        if (registered || existsSync(join(worktree, '.git'))) {
          await verifyWorktree();
        } else {
          const hasOrigin = (await git(repo, ['remote'])).split(/\r?\n/).includes('origin');
          if (hasOrigin) await git(repo, ['fetch', 'origin']);
          if (existsSync(worktree) && readdirSync(worktree).length > 0) {
            // A late tool/cache write can recreate the directory after cleanup.
            // Preserve every file; only Git may remove a registered worktree.
            const destination = join(parent, `${task.key}-preserved-${randomUUID()}`);
            if (!samePath(resolve(worktree, '..'), parent) || !samePath(resolve(destination, '..'), parent) || existsSync(destination)) {
              throw new Error('Cannot safely preserve the leftover task directory.');
            }
            renameSync(worktree, destination);
            preservedPath = destination;
          }
          if (await hasRef(`refs/heads/${branch}`)) {
            await git(repo, ['worktree', 'add', worktree, branch]);
          } else {
            const name = await resolveDefaultBranchName(repo);
            const base = await hasRef(`refs/remotes/origin/${branch}`) ? `origin/${branch}`
              : name && await hasRef(`refs/remotes/origin/${name}`) ? `origin/${name}` : name ?? 'HEAD';
            await git(repo, ['worktree', 'add', '-b', branch, worktree, base]);
          }
          await verifyWorktree();
        }
      } else {
        await verifyWorktree();
        const merging = await mergeHead();
        if (action === 'status') {
          result = await inspect();
        } else if (action === 'diff') {
          const status = await inspect();
          const defaultRef = status.defaultBranch ? `refs/remotes/origin/${status.defaultBranch}` : null;
          result = { staged: await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', '--cached']),
            working: await git(worktree, ['diff', '--no-ext-diff', '--no-textconv']),
            branchDiff: defaultRef && await hasRef(defaultRef) ? await git(worktree, ['diff', '--no-ext-diff', '--no-textconv', `${defaultRef}...HEAD`]) : null,
            untracked: status.files.filter(f => f.status === '??').map(f => f.path) };
        } else if (action === 'log') {
          result = { commits: (await git(worktree, ['log', '-30', '--format=%H%x00%P%x00%s'])).split('\n').filter(Boolean).map(line => {
            const [sha, parents, subject] = line.split('\0'); return { sha, parents: parents?.split(' ').filter(Boolean), subject };
          }) };
        } else if (action === 'merge_default') {
          if (merging) {
            result = { mergeState: 'conflicts', targetSha: merging, conflicts: await conflicts() };
          } else {
            if (await git(worktree, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Inspect and commit or preserve existing changes before merging; no automatic stash or discard.');
            await git(repo, ['fetch', 'origin']);
            const remoteHead = await git(repo, ['ls-remote', '--symref', 'origin', 'HEAD']);
            const remoteDefault = remoteHead.match(/^ref: refs\/heads\/([^\t\r\n]+)\tHEAD/m)?.[1];
            const name = remoteDefault ?? await resolveDefaultBranchName(repo);
            if (!name || !await hasRef(`refs/remotes/origin/${name}`)) throw new Error('Cannot resolve origin default branch.');
            const targetSha = await git(repo, ['rev-parse', '--verify', `refs/remotes/origin/${name}^{commit}`]);
            try {
              await git(worktree, ['merge', '--no-ff', '--no-edit', targetSha]);
              result = { mergeState: 'merged', targetSha, defaultBranch: name };
            } catch (error) {
              if (!await mergeHead()) throw error;
              result = { mergeState: 'conflicts', targetSha, defaultBranch: name, conflicts: await conflicts() };
            }
          }
        } else if (action === 'continue_merge') {
          if (!merging) throw new Error('No merge is in progress; inspect status before continuing.');
          if (!message) throw new Error('A merge commit message is required.');
          // diff --check rejects leftover conflict markers before staging resolutions.
          await git(worktree, ['diff', '--check']);
          await git(worktree, ['add', '--all', '--', '.']);
          if ((await conflicts()).length) throw new Error('Unresolved merge entries remain.');
          await git(worktree, ['diff', '--cached', '--check']);
          await git(worktree, ['commit', '-m', message]);
          result = { mergeState: 'merged', targetSha: merging };
        } else if (action === 'commit') {
          if (merging) throw new Error('Finish the active merge with continue_merge before committing.');
          if (!message) throw new Error('A commit message is required.');
          await git(worktree, ['add', '--all', '--', '.']);
          const staged = await git(worktree, ['diff', '--cached', '--name-only']);
          if (staged) await git(worktree, ['commit', '-m', message]);
        } else {
          if (merging) throw new Error('Finish the active merge before publishing or cleanup.');
          if (await git(worktree, ['status', '--porcelain', '--untracked-files=all'])) throw new Error('Commit or preserve all uncommitted work before publishing or cleanup.');
          if (action === 'push') {
            await git(worktree, ['push', '-u', 'origin', `${branch}:refs/heads/${branch}`]);
          } else {
            const local = await git(worktree, ['rev-parse', 'HEAD']);
            const remote = await git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch}`]);
            if (remote.split(/\s+/)[0] !== local) throw new Error('Cleanup refused: the task HEAD is not published on origin.');
            // Native Git verifies its own registration; no recursive path deletion or
            // force removal. Ignored build artifacts may be removed by Git itself.
            await git(repo, ['worktree', 'remove', worktree]);
          }
        }
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ action, branch, worktree, ok: true, ...result, ...(preservedPath ? { preservedPath } : {}) }) }] };
    } catch (err) {
      return toToolError(preservedPath ? new Error(`${err instanceof Error ? err.message : String(err)} Leftover files were preserved at ${preservedPath}.`) : err);
    }
    finally { busy = false; }
  });
}
