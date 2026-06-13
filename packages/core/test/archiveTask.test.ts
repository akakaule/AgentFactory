import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { addComment } from '../src/ops/addComment.js';
import { getTask } from '../src/ops/getTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { archiveTask, unarchiveTask, archiveDoneTasks } from '../src/ops/archiveTask.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { NotFoundError, InvalidTransitionError } from '../src/errors.js';
import type { DB } from '../src/db.js';
import type { Status } from '../src/types.js';

/** Drive a fresh task to done through the real lifecycle. */
function makeDoneTask(db: DB, title = 'T', workspace?: string): string {
  const task = createTask(db, { title, spec: 'S', acceptanceCriteria: 'A', ...(workspace ? { workspace } : {}) });
  updateStatus(db, task.key, 'queued', 'human');
  claimNextTask(db, workspace ? { workspace } : {});
  submitResult(db, task.key, { summary: 'done' });
  reviewApprove(db, task.key);
  return task.key;
}

describe('archiveTask', () => {
  it('archives a done task: sets archivedAt, hides it from default listings, keeps it reachable by key', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);

    const detail = archiveTask(db, key);

    expect(detail.archivedAt).not.toBeNull();
    expect(detail.status).toBe('done');
    expect(listTasks(db)).toHaveLength(0);
    expect(listTasks(db, { archived: true }).map((t) => t.key)).toEqual([key]);
    expect(getTask(db, key).archivedAt).not.toBeNull();
  });

  it('preserves spec, acceptance criteria, activity, links, and metrics across archive', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);
    addComment(db, key, { actor: 'human', body: 'a kept note' });
    const task = getTask(db, key);
    db.prepare("INSERT INTO link (task_id, kind, label, url) VALUES (?, 'branch', 'feature/x', 'http://example.com/b')").run(task.id);
    const before = getTask(db, key);

    archiveTask(db, key);

    const after = getTask(db, key);
    expect(after.spec).toBe(before.spec);
    expect(after.acceptanceCriteria).toBe(before.acceptanceCriteria);
    expect(after.links).toEqual(before.links);
    expect(after.attachments).toEqual(before.attachments);
    // all prior activity still present (archive appends its own comment row)
    for (const entry of before.activity) expect(after.activity).toContainEqual(entry);
    expect(after.metrics.claimCount).toBe(before.metrics.claimCount);
  });

  it('appends an auditable activity row', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);

    archiveTask(db, key);

    const last = getTask(db, key).activity.at(-1)!;
    expect(last.type).toBe('comment');
    expect(last.body).toMatch(/archived/i);
  });

  it.each<Status>(['backlog', 'queued', 'in_progress', 'in_review', 'blocked'])(
    'rejects archiving a %s task',
    (status) => {
      const db = makeTestDb();
      const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
      db.prepare('UPDATE task SET status = ? WHERE key = ?').run(status, task.key);

      expect(() => archiveTask(db, task.key)).toThrow(InvalidTransitionError);
      expect(listTasks(db)).toHaveLength(1);
    },
  );

  it('rejects double-archive and unknown keys', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);
    archiveTask(db, key);
    expect(() => archiveTask(db, key)).toThrow(InvalidTransitionError);
    expect(() => archiveTask(db, 'AF-9999')).toThrow(NotFoundError);
  });

  it('blocks status moves on an archived task (no reopen until unarchive)', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);
    archiveTask(db, key);

    expect(() => updateStatus(db, key, 'queued', 'human')).toThrow(InvalidTransitionError);
  });

  it('unarchive restores the task to default listings and allows reopen again', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);
    archiveTask(db, key);

    const detail = unarchiveTask(db, key);

    expect(detail.archivedAt).toBeNull();
    expect(listTasks(db).map((t) => t.key)).toEqual([key]);
    expect(listTasks(db, { archived: true })).toHaveLength(0);
    expect(updateStatus(db, key, 'queued', 'human').status).toBe('queued');
  });

  it('rejects unarchiving a task that is not archived', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);
    expect(() => unarchiveTask(db, key)).toThrow(InvalidTransitionError);
  });
});

describe('archiveDoneTasks', () => {
  it('archives every done task and leaves non-terminal statuses alone', () => {
    const db = makeTestDb();
    const done1 = makeDoneTask(db, 'D1');
    const done2 = makeDoneTask(db, 'D2');
    const open = createTask(db, { title: 'Open', spec: 'S', acceptanceCriteria: 'A' });
    updateStatus(db, open.key, 'queued', 'human');

    expect(archiveDoneTasks(db)).toEqual({ archived: 2 });

    expect(listTasks(db).map((t) => t.key)).toEqual([open.key]);
    expect(listTasks(db, { archived: true }).map((t) => t.key).sort()).toEqual([done1, done2]);
  });

  it('scopes to the given workspace and skips already-archived tasks', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'other', repoPath: '/tmp/other' });
    const inDefault = makeDoneTask(db, 'D-def');
    const inOther = makeDoneTask(db, 'D-oth', 'other');
    archiveTask(db, inDefault);

    expect(archiveDoneTasks(db, { workspace: 'default' })).toEqual({ archived: 0 });
    expect(archiveDoneTasks(db, { workspace: 'other' })).toEqual({ archived: 1 });
    expect(getTask(db, inOther).archivedAt).not.toBeNull();
  });

  it('unknown workspace → NotFoundError', () => {
    const db = makeTestDb();
    expect(() => archiveDoneTasks(db, { workspace: 'nope' })).toThrow(NotFoundError);
  });
});

describe('archived tasks and claiming', () => {
  it('claimNextTask never returns an archived task', () => {
    const db = makeTestDb();
    const key = makeDoneTask(db);
    archiveTask(db, key);
    // force the pathological state: an archived row marked queued must still be unclaimable
    db.prepare("UPDATE task SET status = 'queued' WHERE key = ?").run(key);

    expect(claimNextTask(db)).toBeNull();
  });
});
