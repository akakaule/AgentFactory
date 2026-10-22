import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { createTask } from '../src/ops/createTask.js';
import { importTask } from '../src/ops/importTask.js';
import { getTask } from '../src/ops/getTask.js';

import { updateStatus } from '../src/ops/updateStatus.js';
import { ValidationError } from '../src/errors.js';

const input = (over: Record<string, unknown> = {}) => ({
  workspace: 'kl-dis', title: 'AB#42: Export invoices', spec: 'ADO Work Item: AB#42 - https://dev.azure.com/o/p/_workitems/edit/42\n\nBody',
  stage: 'description' as const, links: [{ kind: 'url' as const, label: 'AB#42', url: 'https://dev.azure.com/o/p/_workitems/edit/42' }],
  dedupPrefix: 'AB#42:', note: 'Imported from Azure DevOps work item AB#42.', queue: true, ...over,
});

describe('importTask', () => {
  it('creates the task at the given stage, records an ado-import/v1 comment, and queues it as a human', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'kl-dis', repoPath: '/r' });
    const r = importTask(db, input());
    expect(r.created).toBe(true);
    expect(r.task.status).toBe('queued');
    expect(r.task.stage).toBe('description');
    const d = getTask(db, r.task.key);
    expect(d.workspace).toBe('kl-dis');
    expect(d.links.map((l) => l.label)).toContain('AB#42');
    const comment = d.activity.find((a) => a.type === 'comment');
    expect(comment?.body).toMatch(/^ado-import\/v1 — Imported from Azure DevOps work item AB#42\./);
    expect(comment?.actor).toBe('human');
    const queued = d.activity.find((a) => a.type === 'status_change' && a.toStatus === 'queued');
    expect(queued?.actor).toBe('human');
  });

  it('queue: false leaves it in backlog', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'kl-dis', repoPath: '/r' });
    expect(importTask(db, input({ queue: false })).task.status).toBe('backlog');
  });

  it('is idempotent on the dedup prefix (any status, archived too) and never duplicates', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'kl-dis', repoPath: '/r' });
    const first = importTask(db, input());
    const again = importTask(db, input({ title: 'AB#42: renamed upstream' }));
    expect(again.created).toBe(false);
    expect(again.task.key).toBe(first.task.key);
    updateStatus(db, first.task.key, 'in_progress', 'agent');
    updateStatus(db, first.task.key, 'blocked', 'agent');
    expect(importTask(db, input()).created).toBe(false);
    db.prepare("UPDATE task SET status = 'done', archived_at = '2026-01-01' WHERE key = ?").run(first.task.key); // archived done task
    expect(importTask(db, input()).created).toBe(false);
  });

  it('matches a task the PowerShell bridge created (same AB# title prefix) and re-queues it from backlog', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'kl-dis', repoPath: '/r' });
    const old = createTask(db, { workspace: 'kl-dis', title: 'AB#42: Export invoices', spec: 's', stage: 'description' });
    const r = importTask(db, input());
    expect(r.created).toBe(false);
    expect(r.task.key).toBe(old.key);
    expect(r.task.status).toBe('queued');
  });

  it('the prefix is literal (no LIKE wildcards) and scoped to the workspace', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'kl-dis', repoPath: '/r' });
    createWorkspace(db, { name: 'other', repoPath: '/o' });
    createTask(db, { workspace: 'kl-dis', title: 'AB#4_: x', spec: 's', stage: 'description' });
    createTask(db, { workspace: 'other', title: 'AB#42: same id elsewhere', spec: 's', stage: 'description' });
    expect(importTask(db, input()).created).toBe(true);
  });

  it('rejects a title that does not start with the dedup prefix', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'kl-dis', repoPath: '/r' });
    expect(() => importTask(db, input({ dedupPrefix: 'AB#7:' }))).toThrow(ValidationError);
  });
});
