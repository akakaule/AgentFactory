/**
 * End-to-end multi-workspace test (spec acceptance criterion #6).
 *
 * Two workspaces, two scoped "workers" (separate Core connections on the same
 * temp FILE database, like e2e.loop.test.ts), one human driving the Hono HTTP
 * API. Proves: scoped claims never cross workspaces, claimed payloads carry
 * workspace + repoPath, and both loops complete to done.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { openDb, runMigrations, createCore, type DB, NotFoundError } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const DB_PATH = join(tmpdir(), 'agentfactory_e2e_workspaces_test.db');

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

describe('e2e: two workspaces, two scoped workers, shared file DB', () => {
  let dbHuman: DB;
  let dbWorkerA: DB;
  let dbWorkerB: DB;

  beforeEach(() => {
    cleanupDbFiles();
  });

  afterEach(() => {
    try { dbHuman.close(); } catch { /* already closed or never opened */ }
    try { dbWorkerA.close(); } catch { /* already closed or never opened */ }
    try { dbWorkerB.close(); } catch { /* already closed or never opened */ }
    cleanupDbFiles();
  });

  it('scoped workers never cross-claim and both loops complete to done', async () => {
    dbHuman = openDb(DB_PATH);
    runMigrations(dbHuman);
    dbWorkerA = openDb(DB_PATH);
    dbWorkerB = openDb(DB_PATH);

    const coreHuman = createCore(dbHuman);
    const workerA = createCore(dbWorkerA); // launched for repo-a (AGENTFACTORY_WORKSPACE=repo-a)
    const workerB = createCore(dbWorkerB); // launched for repo-b
    const app = buildApp(coreHuman);

    // ── Human: create the two workspaces over HTTP ───────────────────────────
    expect((await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/work/repo-a' })).status).toBe(201);
    expect((await post(app, '/api/workspaces', { name: 'repo-b', repoPath: '/work/repo-b' })).status).toBe(201);

    // ── Human: create + queue A1, B1, A2 (interleaved on purpose) ────────────
    const mk = async (title: string, workspace: string) => {
      const res = await post(app, '/api/tasks', { title, spec: 's', acceptanceCriteria: 'a', workspace });
      expect(res.status).toBe(201);
      const t = await res.json() as { key: string };
      expect((await post(app, `/api/tasks/${t.key}/status`, { status: 'queued' })).status).toBe(200);
      return t.key;
    };
    const a1 = await mk('A1', 'repo-a');
    const b1 = await mk('B1', 'repo-b');
    const a2 = await mk('A2', 'repo-a');

    // ── Workers claim with their workspace scope ─────────────────────────────
    const claimedA1 = workerA.claimNextTask({ workspace: 'repo-a' });
    expect(claimedA1).toMatchObject({ key: a1, workspace: 'repo-a', repoPath: '/work/repo-a', status: 'in_progress' });

    const claimedB1 = workerB.claimNextTask({ workspace: 'repo-b' });
    expect(claimedB1).toMatchObject({ key: b1, workspace: 'repo-b', repoPath: '/work/repo-b', status: 'in_progress' });

    const claimedA2 = workerA.claimNextTask({ workspace: 'repo-a' });
    expect(claimedA2).toMatchObject({ key: a2, workspace: 'repo-a' });

    // Queues are drained per workspace — no leaking across.
    expect(workerA.claimNextTask({ workspace: 'repo-a' })).toBeNull();
    expect(workerB.claimNextTask({ workspace: 'repo-b' })).toBeNull();

    // A typo'd worker config fails loudly instead of idling.
    expect(() => workerA.claimNextTask({ workspace: 'nope' })).toThrow(NotFoundError);

    // ── Workers deliver, human approves — both loops reach done ─────────────
    for (const [worker, key] of [[workerA, a1], [workerB, b1], [workerA, a2]] as const) {
      worker.submitResult(key, { summary: `done: ${key}` });
      expect((await post(app, `/api/tasks/${key}/approve`)).status).toBe(200);
    }

    const doneA = await (await app.request('/api/tasks?workspace=repo-a&status=done')).json() as Array<{ key: string }>;
    expect(doneA.map((t) => t.key).sort()).toEqual([a1, a2].sort());
    const doneB = await (await app.request('/api/tasks?workspace=repo-b&status=done')).json() as Array<{ key: string }>;
    expect(doneB.map((t) => t.key)).toEqual([b1]);
  });

  it('a stranded claim is released by the human and the next worker sees full history', async () => {
    dbHuman = openDb(DB_PATH);
    runMigrations(dbHuman);
    dbWorkerA = openDb(DB_PATH);
    dbWorkerB = openDb(DB_PATH);

    const coreHuman = createCore(dbHuman);
    const workerCrash = createCore(dbWorkerA);
    const workerRescue = createCore(dbWorkerB);
    const app = buildApp(coreHuman);

    const created = await post(app, '/api/tasks', { title: 'T', spec: 's', acceptanceCriteria: 'a' });
    const t = await created.json() as { key: string };
    await post(app, `/api/tasks/${t.key}/status`, { status: 'queued' });

    // worker 1 claims with a label, narrates once, then "dies" (no further calls)
    const claimed = workerCrash.claimNextTask({ claimedBy: 'worker-1' });
    expect(claimed).toMatchObject({ key: t.key, claimedBy: 'worker-1' });
    workerCrash.addComment(t.key, { actor: 'agent', body: 'started investigating' });

    // the human sees who has it and since when, and releases the claim over HTTP
    const board = await (await app.request('/api/tasks')).json() as Array<{ status: string; claimedBy: string | null }>;
    expect(board[0]).toMatchObject({ status: 'in_progress', claimedBy: 'worker-1' });
    const release = await post(app, `/api/tasks/${t.key}/status`, { status: 'queued' });
    expect(release.status).toBe(200);
    expect(await release.json()).toMatchObject({ status: 'queued', claimedBy: null, claimedAt: null });

    // a second worker re-claims: metadata is its own, prior history fully visible
    const reclaimed = workerRescue.claimNextTask({ claimedBy: 'worker-2' });
    expect(reclaimed).toMatchObject({ key: t.key, claimedBy: 'worker-2', status: 'in_progress' });
    expect(reclaimed!.activity.some((a) => a.type === 'comment' && a.body === 'started investigating')).toBe(true);
    expect(reclaimed!.activity.some(
      (a) => a.type === 'status_change' && a.fromStatus === 'in_progress' && a.toStatus === 'queued' && a.actor === 'human',
    )).toBe(true);

    // the rescued loop completes
    workerRescue.submitResult(t.key, { summary: 'rescued and finished' });
    expect((await post(app, `/api/tasks/${t.key}/approve`)).status).toBe(200);
  });
});
