/**
 * End-to-end multi-stage pipeline test (description → plan → implementation).
 *
 * Same two-connection WAL-file layout as e2e.loop.test.ts:
 *   - coreHuman → the human/reviewer side through the real Hono HTTP API
 *   - coreAgent → the worker side via Core ops (what the MCP tools call)
 *
 * Proves the stage machine end-to-end: doc stages submit their deliverable
 * through submit_result fields, clean ai-review verdicts auto-advance doc
 * stages, findings escalate to the human, and the implementation gate stays
 * human-only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, existsSync } from 'node:fs';
import { openDb, runMigrations, createCore, type DB } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const DB_PATH = join(tmpdir(), 'agentfactory_e2e_pipeline_test.db');

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
const get = (app: App, path: string) => app.request(path);

const review = (findings: unknown[]) =>
  `ai-review/v1 — ${findings.length} findings (claude)\nReviewed.\n\`\`\`json\n${JSON.stringify({ reviewer: 'claude', verdict: findings.length ? 'findings' : 'clean', findings })}\n\`\`\``;
const CLEAN = review([]);
const FINDINGS = review([{ severity: 'warning', title: 'tighten the acceptance criteria', detail: 'AC 2 is not verifiable' }]);

describe('e2e: multi-stage pipeline (description → plan → implementation)', () => {
  let dbHuman: DB;
  let dbAgent: DB;

  beforeEach(() => { cleanupDbFiles(); });
  afterEach(() => {
    try { dbHuman.close(); } catch { /* already closed or never opened */ }
    try { dbAgent.close(); } catch { /* already closed or never opened */ }
    cleanupDbFiles();
  });

  it('walks all three stages: doc auto-approve on clean, findings escalate, human owns the final gate', async () => {
    dbHuman = openDb(DB_PATH);
    runMigrations(dbHuman);
    dbAgent = openDb(DB_PATH);
    const coreHuman = createCore(dbHuman);
    const coreAgent = createCore(dbAgent);
    const app = buildApp(coreHuman);

    // ── Stage 1: description ────────────────────────────────────────────────
    const createRes = await post(app, '/api/tasks', {
      title: 'Add /ping endpoint',
      spec: 'Raw idea: we want a health check.',
      stage: 'description',
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { key: string; stage: string };
    expect(created.stage).toBe('description');
    const KEY = created.key;

    await post(app, `/api/tasks/${KEY}/status`, { status: 'queued' });

    const claim1 = coreAgent.claimNextTask();
    expect(claim1).toMatchObject({ key: KEY, stage: 'description', branch: null, branchCreated: false });

    coreAgent.submitResult(KEY, {
      summary: 'feature description written',
      spec: 'GET /ping returns 200 {"ok":true}. Used by the uptime monitor.',
      acceptanceCriteria: '- GET /ping responds 200 with {"ok":true}\n- responds within 100ms',
    });

    // reviewer posts a CLEAN verdict through the HTTP comment route (the bridge's path)
    const reviewRes = await post(app, `/api/tasks/${KEY}/comment`, { body: CLEAN });
    expect(reviewRes.status).toBe(201);

    // auto-advance: queued at the plan stage, claimant cleared, agent-actor trail
    const afterDesc = await (await get(app, `/api/tasks/${KEY}`)).json() as {
      status: string; stage: string; claimedBy: string | null; spec: string;
      activity: Array<{ type: string; actor: string; toStatus: string | null; body: string }>;
    };
    expect(afterDesc.status).toBe('queued');
    expect(afterDesc.stage).toBe('plan');
    expect(afterDesc.claimedBy).toBeNull();
    expect(afterDesc.spec).toContain('GET /ping');
    const advance1 = afterDesc.activity.find((a) => a.type === 'status_change' && a.body.includes('auto-approved'));
    expect(advance1).toBeDefined();
    expect(advance1!.actor).toBe('agent');
    expect(advance1!.body).toContain('description → plan');

    // ── Stage 2: plan ───────────────────────────────────────────────────────
    const claim2 = coreAgent.claimNextTask();
    expect(claim2).toMatchObject({ key: KEY, stage: 'plan', branch: null });

    coreAgent.submitResult(KEY, {
      summary: 'implementation plan written',
      plan: '1. add GET /ping route\n2. unit test the 200 body\n3. wire into app.ts',
    });

    // clean verdict via the agent path this time (MCP add_comment posts as agent)
    coreAgent.addComment(KEY, { actor: 'agent', body: CLEAN });

    const afterPlan = await (await get(app, `/api/tasks/${KEY}`)).json() as { status: string; stage: string; plan: string | null };
    expect(afterPlan.status).toBe('queued');
    expect(afterPlan.stage).toBe('implementation');
    expect(afterPlan.plan).toContain('GET /ping route');

    // ── Stage 3: implementation ─────────────────────────────────────────────
    const claim3 = coreAgent.claimNextTask();
    expect(claim3!.stage).toBe('implementation');
    expect(claim3!.branch).not.toBeNull(); // branch named at the FIRST implementation-stage claim
    expect(claim3!.branchCreated).toBe(true);

    coreAgent.submitResult(KEY, {
      summary: 'endpoint implemented',
      links: [{ kind: 'branch', label: claim3!.branch!, url: 'http://example/branch' }],
    });

    // a FINDINGS review must NOT auto-advance the implementation stage
    await post(app, `/api/tasks/${KEY}/comment`, { body: FINDINGS });
    const afterImplReview = await (await get(app, `/api/tasks/${KEY}`)).json() as { status: string; stage: string };
    expect(afterImplReview.status).toBe('in_review');
    expect(afterImplReview.stage).toBe('implementation');

    // human approves (over the open finding → override is logged by core)
    const approveRes = await post(app, `/api/tasks/${KEY}/approve`);
    expect(approveRes.status).toBe(200);
    const approved = await approveRes.json() as { status: string; stage: string };
    expect(approved.status).toBe('done');
    expect(approved.stage).toBe('implementation');

    // queue is empty — the task never duplicated itself across stages
    expect(coreAgent.claimNextTask()).toBeNull();
  });

  it('findings on a doc stage escalate: human requests changes, the stage repeats, then advances clean', async () => {
    dbHuman = openDb(DB_PATH);
    runMigrations(dbHuman);
    dbAgent = openDb(DB_PATH);
    const coreHuman = createCore(dbHuman);
    const coreAgent = createCore(dbAgent);
    const app = buildApp(coreHuman);

    const created = await (await post(app, '/api/tasks', { title: 'T', spec: 'raw', stage: 'description' })).json() as { key: string };
    const KEY = created.key;
    await post(app, `/api/tasks/${KEY}/status`, { status: 'queued' });

    coreAgent.claimNextTask();
    coreAgent.submitResult(KEY, { summary: 'v1', spec: 'draft', acceptanceCriteria: '- vague' });

    // findings → stays in_review at the same stage
    await post(app, `/api/tasks/${KEY}/comment`, { body: FINDINGS });
    let detail = await (await get(app, `/api/tasks/${KEY}`)).json() as { status: string; stage: string };
    expect(detail).toMatchObject({ status: 'in_review', stage: 'description' });

    // human curates and requests changes → re-queued at the SAME stage
    await post(app, `/api/tasks/${KEY}/request-changes`, { feedback: 'make AC 2 measurable' });
    detail = await (await get(app, `/api/tasks/${KEY}`)).json() as { status: string; stage: string };
    expect(detail).toMatchObject({ status: 'queued', stage: 'description' });

    // the reclaim sees the feedback, redoes the description
    const reclaim = coreAgent.claimNextTask();
    expect(reclaim!.stage).toBe('description');
    expect(reclaim!.activity.some((a) => a.type === 'feedback' && a.body.includes('measurable'))).toBe(true);

    coreAgent.submitResult(KEY, { summary: 'v2', spec: 'tight draft', acceptanceCriteria: '- responds in <100ms' });
    await post(app, `/api/tasks/${KEY}/comment`, { body: CLEAN });

    detail = await (await get(app, `/api/tasks/${KEY}`)).json() as { status: string; stage: string };
    expect(detail).toMatchObject({ status: 'queued', stage: 'plan' });
  });
});
