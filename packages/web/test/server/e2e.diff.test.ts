/**
 * End-to-end diff view test (spec acceptance criteria #1 and #2).
 *
 * One human (Hono HTTP API) + one worker (separate Core connection on the same
 * temp FILE database, like e2e.loop.test.ts) + a real temp git repo as the
 * workspace. Proves: the review diff served over HTTP is the worker's actual
 * merge-base diff, and a re-submission after request-changes moves the diff to
 * the new branch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { openDb, runMigrations, createCore, type DB } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';
import { initGitRepo, addBranchWithChange, commitFile, cleanupRepo } from './helpers/gitFixtures.js';

const DB_PATH = join(tmpdir(), 'agentfactory_e2e_diff_test.db');

function cleanupDbFiles(): void {
  for (const ext of ['', '-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
}

type App = ReturnType<typeof buildApp>;

const post = (app: App, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    headers: { 'content-type': 'application/json' },
  });

describe('e2e: review diff over HTTP from a real workspace repo', () => {
  let dbHuman: DB;
  let dbWorker: DB;
  let repoDir: string;

  beforeEach(() => {
    cleanupDbFiles();
    repoDir = initGitRepo();
  });

  afterEach(() => {
    try { dbHuman.close(); } catch { /* already closed or never opened */ }
    try { dbWorker.close(); } catch { /* already closed or never opened */ }
    cleanupDbFiles();
    cleanupRepo(repoDir);
  });

  it('serves the worker diff for review, and follows the branch of a re-submission', async () => {
    dbHuman = openDb(DB_PATH);
    runMigrations(dbHuman);
    dbWorker = openDb(DB_PATH);

    const coreHuman = createCore(dbHuman);
    const worker = createCore(dbWorker);
    const app = buildApp(coreHuman);

    // ── Human: workspace over the real repo; create + queue the task ────────
    expect((await post(app, '/api/workspaces', { name: 'repo', repoPath: repoDir })).status).toBe(201);
    const created = await post(app, '/api/tasks', { title: 'T', spec: 's', acceptanceCriteria: 'a', workspace: 'repo' });
    const t = await (created).json() as { key: string };
    await post(app, `/api/tasks/${t.key}/status`, { status: 'queued' });

    // ── Worker: claim, do real work on task/<key>, submit with the branch link ──
    const claimed = worker.claimNextTask({ workspace: 'repo', claimedBy: 'worker-1' });
    expect(claimed).toMatchObject({ key: t.key, repoPath: repoDir });
    addBranchWithChange(repoDir, `task/${t.key}`, 'feature.txt', 'first attempt\n');
    // main moves on after the branch point — must not pollute the review diff
    commitFile(repoDir, 'mainline.txt', 'unrelated mainline work\n');
    worker.submitResult(t.key, {
      summary: 'first attempt',
      links: [{ kind: 'branch', label: `task/${t.key}`, url: 'http://example.com/b1' }],
    });

    // ── Human: the review diff over HTTP is the worker's actual diff ────────
    const res = await app.request(`/api/tasks/${t.key}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json() as { branch: string; baseRef: string; diff: string };
    expect(body.branch).toBe(`task/${t.key}`);
    expect(body.baseRef).toBe('main');
    expect(body.diff).toContain('+first attempt');
    expect(body.diff).not.toContain('mainline.txt');

    // ── Human requests changes; worker re-submits on a fresh branch ─────────
    expect((await post(app, `/api/tasks/${t.key}/request-changes`, { feedback: 'try again' })).status).toBe(200);
    worker.claimNextTask({ workspace: 'repo', claimedBy: 'worker-1' });
    addBranchWithChange(repoDir, `task/${t.key}-v2`, 'feature2.txt', 'second attempt\n');
    worker.submitResult(t.key, {
      summary: 'second attempt',
      links: [{ kind: 'branch', label: `task/${t.key}-v2`, url: 'http://example.com/b2' }],
    });

    // The diff follows the latest branch link.
    const res2 = await app.request(`/api/tasks/${t.key}/diff`);
    const body2 = await res2.json() as { branch: string; diff: string };
    expect(body2.branch).toBe(`task/${t.key}-v2`);
    expect(body2.diff).toContain('+second attempt');
    expect(body2.diff).not.toContain('first attempt');

    // The rescued loop completes.
    expect((await post(app, `/api/tasks/${t.key}/approve`)).status).toBe(200);
  });
});
