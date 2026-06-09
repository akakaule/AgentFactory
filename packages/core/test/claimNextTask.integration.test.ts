/**
 * Cross-connection integration test for claimNextTask.
 *
 * Uses a REAL temp-file DB (not :memory:) so two separate connections share
 * state via WAL. This proves that connection A's committed claim is visible to
 * connection B without any in-process sharing.
 *
 * NOTE: True concurrent-writer racing (two processes/threads simultaneously
 * issuing BEGIN IMMEDIATE) is handled by BEGIN IMMEDIATE + busy_timeout and is
 * NOT exercised here — that would require separate OS processes or worker threads
 * which are impractical in a synchronous vitest environment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createTask } from '../src/ops/createTask.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';

// Use a fixed name rather than Date.now()/Math.random() to keep tests deterministic.
const DB_PATH = join(tmpdir(), 'agentfactory_claim_integration_test.db');

// Remove the db file plus its WAL/SHM sidecars if present.
function cleanupDbFiles(): void {
  for (const ext of ['', '-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
}

// Clean both before AND after each test: beforeEach guards against a stale file
// left by a prior crashed run, afterEach tidies up on success.
beforeEach(cleanupDbFiles);
afterEach(cleanupDbFiles);

describe('claimNextTask (cross-connection integration)', () => {
  it('connection B sees connection A committed claim via WAL', () => {
    // Connection A: set up schema and seed one queued task
    const connA = openDb(DB_PATH);
    runMigrations(connA);
    const task = createTask(connA, { title: 'Cross-conn Task', spec: 'S', acceptanceCriteria: 'A' });
    connA.prepare("UPDATE task SET status='queued' WHERE key=?").run(task.key);

    // Connection B: opened after the seed — will read via WAL
    const connB = openDb(DB_PATH);

    // A claims the task
    const claimedByA = claimNextTask(connA);
    expect(claimedByA).not.toBeNull();
    expect(claimedByA!.key).toBe(task.key);
    expect(claimedByA!.status).toBe('in_progress');

    // B tries to claim — should see A's committed write and get null
    const claimedByB = claimNextTask(connB);
    expect(claimedByB).toBeNull();

    connA.close();
    connB.close();
  });
});
