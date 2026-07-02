/**
 * End-to-end analytics test (spec acceptance criteria #1–#3).
 *
 * Human (HTTP) + worker (separate Core connection on the same temp FILE DB).
 * Proves: a full feed-and-follow-up loop lands in /api/analytics with the right
 * stage data, round count, worker attribution, and worker-reported usage; a
 * released claim shows up as an attributed stranded event.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { openDb, runMigrations, createCore, type DB } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const DB_PATH = join(tmpdir(), 'agentfactory_e2e_analytics_test.db');

function cleanupDbFiles(): void {
  for (const ext of ['', '-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
}

type App = ReturnType<typeof buildApp>;
const post = (app: App, path: string, body?: unknown) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json' } });

describe('e2e: a worked loop lands in the analytics', () => {
  let dbHuman: DB;
  let dbWorker: DB;

  beforeEach(() => { cleanupDbFiles(); });
  afterEach(() => {
    try { dbHuman.close(); } catch { /* already closed or never opened */ }
    try { dbWorker.close(); } catch { /* already closed or never opened */ }
    cleanupDbFiles();
  });

  it('tracks stages, rounds, worker, usage, and stranded releases end to end', { timeout: 30000 }, async () => {
    dbHuman = openDb(DB_PATH);
    runMigrations(dbHuman);
    dbWorker = openDb(DB_PATH);
    const coreHuman = createCore(dbHuman);
    const worker = createCore(dbWorker);
    const app = buildApp(coreHuman);

    // ── Task 1: full loop with one feedback round + reported usage ───────────
    const created = await post(app, '/api/tasks', { title: 'T', spec: 's', acceptanceCriteria: 'a' });
    const t = await created.json() as { key: string };
    await post(app, `/api/tasks/${t.key}/status`, { status: 'queued' });

    worker.claimNextTask({ claimedBy: 'worker-1' });
    worker.submitResult(t.key, { summary: 'v1' });
    await post(app, `/api/tasks/${t.key}/request-changes`, {
      feedback: 'tighten it up',
      // the curation firewall's forward/dismiss split rides the request-changes over HTTP
      curation: { reviewer: 'codex', dispositions: [
        { severity: 'warning', file: 'src/x.ts', line: 1, title: 'Keep', disposition: 'forwarded' },
        { severity: 'info', file: null, line: null, title: 'Drop', disposition: 'dismissed' },
      ] },
    });
    worker.claimNextTask({ claimedBy: 'worker-1' });
    worker.submitResult(t.key, { summary: 'v2' });
    await post(app, `/api/tasks/${t.key}/approve`);

    // the loop wrapper reports exact usage post-run, over HTTP
    const rep = await post(app, `/api/tasks/${t.key}/metrics`, {
      model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92, reportedBy: 'wrapper',
    });
    expect(rep.status).toBe(201);

    // ── Task 2: claimed, then stranded and released by the human ────────────
    const c2 = await post(app, '/api/tasks', { title: 'T2', spec: 's', acceptanceCriteria: 'a' });
    const t2 = await c2.json() as { key: string };
    await post(app, `/api/tasks/${t2.key}/status`, { status: 'queued' });
    worker.claimNextTask({ claimedBy: 'worker-2' });
    await post(app, `/api/tasks/${t2.key}/status`, { status: 'queued' }); // release

    // ── The analytics reflect all of it ─────────────────────────────────────
    const res = await app.request('/api/analytics');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      tasks: Array<{
        key: string; status: string; doneAt: string | null; worker: string | null;
        rounds: number; queueMin: number; workMin: number; reviewMin: number;
        model: string | null; tokensIn: number | null; costUsd: number | null;
      }>;
      stranded: Array<{ worker: string | null; workspace: string }>;
      curations: Array<{ reviewer: string | null; workspace: string; disposition: string; taskKey: string }>;
    };

    const row = body.tasks.find((x) => x.key === t.key)!;
    expect(row).toMatchObject({
      status: 'done', worker: 'worker-1', rounds: 1,
      model: 'claude-fable-5', tokensIn: 41000, costUsd: 0.92,
    });
    expect(row.doneAt).toBeTruthy();
    expect(row.workMin).toBeGreaterThanOrEqual(0);

    expect(body.stranded).toHaveLength(1);
    expect(body.stranded[0]).toMatchObject({ worker: 'worker-2', workspace: 'default' });

    // the curation ledger flowed end-to-end: HTTP request-changes → curation/v1 comment → analytics
    const curations = body.curations.filter((c) => c.taskKey === t.key);
    expect(curations).toHaveLength(2);
    expect(curations.every((c) => c.reviewer === 'codex' && c.workspace === 'default')).toBe(true);
    expect(curations.map((c) => c.disposition).sort()).toEqual(['dismissed', 'forwarded']);
  });
});
