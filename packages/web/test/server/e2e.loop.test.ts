/**
 * End-to-end feed-and-follow-up loop test.
 *
 * Opens TWO separate Core connections on the SAME temp FILE database (WAL mode)
 * so that cross-connection visibility is exercised at every step:
 *   - coreHuman  → drives the human side through the real Hono HTTP API
 *                  (buildApp + app.request)
 *   - coreAgent  → drives the agent side by calling Core ops directly
 *                  (the ops the MCP tools call)
 *
 * This proves the full feed-and-follow-up lifecycle works end-to-end and that
 * both sides see each other's committed writes via the shared SQLite WAL file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { openDb, runMigrations, createCore, type DB, InvalidTransitionError } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

// ── temp file ─────────────────────────────────────────────────────────────────
// Fixed name (no Date.now/Math.random) so tests are deterministic.
const DB_PATH = join(tmpdir(), 'agentfactory_e2e_loop_test.db');

function cleanupDbFiles(): void {
  for (const ext of ['', '-wal', '-shm']) {
    const p = DB_PATH + ext;
    if (existsSync(p)) rmSync(p);
  }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
type App = ReturnType<typeof buildApp>;

const post = (app: App, path: string, body?: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    headers: { 'content-type': 'application/json' },
  });

const get = (app: App, path: string) => app.request(path);

// ── test ──────────────────────────────────────────────────────────────────────
describe('e2e: full feed-and-follow-up loop (human ↔ agent, shared file DB)', () => {
  let dbHuman: DB;
  let dbAgent: DB;

  // Clean before each test — guards against stale files from a prior crashed run.
  beforeEach(() => {
    cleanupDbFiles();
  });

  // Close both DB handles (required on Windows before rmSync can succeed) then
  // remove the file + WAL + SHM sidecars.
  afterEach(() => {
    try { dbHuman.close(); } catch { /* already closed or never opened */ }
    try { dbAgent.close(); } catch { /* already closed or never opened */ }
    cleanupDbFiles();
  });

  it('walks the full lifecycle with cross-connection visibility at every step', async () => {
    // Open two separate raw DB handles on the SAME file so we can close them
    // explicitly in afterEach (required to release the Windows file lock).
    dbHuman = openDb(DB_PATH);
    runMigrations(dbHuman);
    dbAgent = openDb(DB_PATH); // second connection — migrations already applied

    const coreHuman = createCore(dbHuman);
    const coreAgent = createCore(dbAgent);
    const app = buildApp(coreHuman);

    // ── Step 1: Human creates a task ─────────────────────────────────────────
    const createRes = await post(app, '/api/tasks', {
      title: 'Fix bug',
      spec: 'The widget crashes on null input.',
      acceptanceCriteria: 'Widget handles null without throwing.',
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { key: string; status: string };
    expect(created.key).toBe('AF-1');
    expect(created.status).toBe('backlog');

    // Record version after creation — used for version-advancement assertion.
    const versionAfterCreate = coreHuman.getVersion();

    // ── Step 2: Human releases task to queue ─────────────────────────────────
    const releaseRes = await post(app, '/api/tasks/AF-1/status', { status: 'queued' });
    expect(releaseRes.status).toBe(200);
    const released = await releaseRes.json() as { status: string };
    expect(released.status).toBe('queued');

    // Record version after queuing — agent writes must advance this further.
    const versionAfterQueue = coreHuman.getVersion();
    expect(versionAfterQueue >= versionAfterCreate).toBe(true);

    // ── Step 3: Agent claims the task ────────────────────────────────────────
    const claimed = coreAgent.claimNextTask();
    expect(claimed).not.toBeNull();
    expect(claimed!.key).toBe('AF-1');
    expect(claimed!.status).toBe('in_progress');

    // CROSS-CONNECTION CHECK: human side (via HTTP) sees the agent's write.
    const afterClaimRes = await get(app, '/api/tasks/AF-1');
    expect(afterClaimRes.status).toBe(200);
    const afterClaim = await afterClaimRes.json() as { status: string };
    expect(afterClaim.status).toBe('in_progress');

    // ── Step 4: Agent adds a comment ─────────────────────────────────────────
    coreAgent.addComment('AF-1', { actor: 'agent', body: 'investigating' });

    // Human side sees the agent comment.
    const afterCommentRes = await get(app, '/api/tasks/AF-1');
    const afterComment = await afterCommentRes.json() as {
      activity: Array<{ actor: string; type: string; body: string }>;
    };
    const agentComments = afterComment.activity.filter(
      (a) => a.type === 'comment' && a.actor === 'agent',
    );
    expect(agentComments.length).toBeGreaterThan(0);
    expect(agentComments[0]!.body).toBe('investigating');

    // ── Step 5: Agent submits a result ───────────────────────────────────────
    const submitted = coreAgent.submitResult('AF-1', {
      summary: 'patched the null check',
      links: [{ kind: 'pr', label: 'PR #1', url: 'http://example/pr/1' }],
    });
    expect(submitted.status).toBe('in_review');

    // Human side (via HTTP) sees in_review, resultSummary, and the PR link.
    const afterSubmitRes = await get(app, '/api/tasks/AF-1');
    const afterSubmit = await afterSubmitRes.json() as {
      status: string;
      resultSummary: string | null;
      links: Array<{ kind: string; label: string; url: string }>;
    };
    expect(afterSubmit.status).toBe('in_review');
    expect(afterSubmit.resultSummary).toBe('patched the null check');
    expect(afterSubmit.links.some((l) => l.kind === 'pr' && l.label === 'PR #1')).toBe(true);

    // LIVE-UPDATE SIGNAL: version must have strictly advanced since step 2
    // (agent writes are visible to the human-side getVersion call).
    const versionAfterSubmit = coreHuman.getVersion();
    expect(versionAfterSubmit > versionAfterQueue).toBe(true);

    // ── Step 6: Agent CANNOT self-approve (access boundary) ──────────────────
    // in_review → done is human-only; the agent attempting it must throw.
    expect(() => coreAgent.updateStatus('AF-1', 'done', 'agent')).toThrow(InvalidTransitionError);

    // ── Step 7: Human requests changes ───────────────────────────────────────
    const requestChangesRes = await post(app, '/api/tasks/AF-1/request-changes', {
      feedback: 'also handle the empty array case',
    });
    expect(requestChangesRes.status).toBe(200);
    const requestChanges = await requestChangesRes.json() as { status: string };
    expect(requestChanges.status).toBe('queued');

    // ── Step 8: Agent re-claims and SEES THE FEEDBACK ─────────────────────────
    // This is the core value of the whole tool: feedback from the human review
    // round-trip is visible in activity when the agent picks up the task again.
    const reclaimed = coreAgent.claimNextTask();
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.key).toBe('AF-1');
    expect(reclaimed!.status).toBe('in_progress');

    const feedbackEntries = reclaimed!.activity.filter((a) => a.type === 'feedback');
    expect(feedbackEntries.length).toBeGreaterThan(0);
    expect(feedbackEntries[0]!.body).toBe('also handle the empty array case');

    // ── Step 9: Agent submits again ──────────────────────────────────────────
    const submitted2 = coreAgent.submitResult('AF-1', { summary: 'handled empty array' });
    expect(submitted2.status).toBe('in_review');

    // ── Step 10: Human approves ───────────────────────────────────────────────
    const approveRes = await post(app, '/api/tasks/AF-1/approve');
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json() as { status: string };
    expect(approved.status).toBe('done');

    // CROSS-CONNECTION CHECK: agent side sees the human's approval.
    const agentSideDone = coreAgent.getTask('AF-1');
    expect(agentSideDone.status).toBe('done');

    // ── Step 11: No more work in queue ───────────────────────────────────────
    // FIFO/queue correctness: nothing left to claim after approval.
    const noneLeft = coreAgent.claimNextTask();
    expect(noneLeft).toBeNull();
  });
});
