import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { addComment } from '../src/ops/addComment.js';
import { getTask } from '../src/ops/getTask.js';
import { restartTask } from '../src/ops/restartTask.js';
import { buildFailureComment } from '../src/failure.js';
import { NotFoundError, InvalidTransitionError } from '../src/errors.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (min: number) => () => new Date(BASE + min * 60000).toISOString();

/** A queued task carrying a max_attempts (skip-listed) failure note — the state Restart targets. */
function seedSkipListed(db: ReturnType<typeof makeTestDb>) {
  const task = createTask(db, { title: 'Stuck', spec: 'S', acceptanceCriteria: 'A' }, at(0));
  updateStatus(db, task.key, 'queued', 'human', at(10));
  addComment(db, task.key, {
    actor: 'agent',
    body: buildFailureComment({ reason: 'max_attempts', detail: 'reached maxAttempts (2)', source: 'dispatcher', attempt: 2, maxAttempts: 2 }),
  }, at(20));
  return task;
}

describe('restartTask', () => {
  it('posts a restart/v1 marker that clears the skip-list chip and keeps the task queued', () => {
    const db = makeTestDb();
    const task = seedSkipListed(db);
    expect(getTask(db, task.key).failure).toMatchObject({ reason: 'max_attempts', skipListed: true });

    const detail = restartTask(db, task.key, null, at(30));
    expect(detail.status).toBe('queued');
    expect(detail.failure).toBeNull(); // the marker supersedes the failure note
    const marker = detail.activity.find((a) => a.type === 'comment' && a.body.startsWith('restart/v1'));
    expect(marker).toBeTruthy();
    expect(marker!.actor).toBe('human');
  });

  it('attributes the restart to the acting user', () => {
    const db = makeTestDb();
    const task = seedSkipListed(db);
    const user = { id: 7 };
    const detail = restartTask(db, task.key, user.id, at(30));
    const marker = detail.activity.find((a) => a.body.startsWith('restart/v1'))!;
    expect(marker.actorUserId).toBe(user.id);
  });

  it('rejects a task that is not queued (other states have their own recovery edge)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'Backlog', spec: 'S', acceptanceCriteria: 'A' }, at(0));
    expect(() => restartTask(db, task.key, null, at(30))).toThrow(InvalidTransitionError);
  });

  it('throws NotFoundError for an unknown key', () => {
    const db = makeTestDb();
    expect(() => restartTask(db, 'AF-999', null, at(30))).toThrow(NotFoundError);
  });
});
