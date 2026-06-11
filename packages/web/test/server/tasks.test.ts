import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

// Helpers
const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const patch = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('tasks REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  it('unknown route → 404', async () => {
    const res = await app.request('/nope');
    expect(res.status).toBe(404);
  });

  describe('GET /api/tasks', () => {
    it('returns empty array when no tasks', async () => {
      const res = await app.request('/api/tasks');
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(0);
    });

    it('returns created tasks', async () => {
      await post(app, '/api/tasks', { title: 'Task 1', spec: 'Spec 1', acceptanceCriteria: 'AC 1' });
      await post(app, '/api/tasks', { title: 'Task 2', spec: 'Spec 2', acceptanceCriteria: 'AC 2' });

      const res = await app.request('/api/tasks');
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toHaveLength(2);
    });

    it('filters by status', async () => {
      // Create two tasks via API
      const r1 = await post(app, '/api/tasks', { title: 'Task 1', spec: 'Spec 1', acceptanceCriteria: 'AC 1' });
      const t1 = await r1.json() as { key: string };
      await post(app, '/api/tasks', { title: 'Task 2', spec: 'Spec 2', acceptanceCriteria: 'AC 2' });

      // Move one to queued
      await post(app, `/api/tasks/${t1.key}/status`, { status: 'queued' });

      const res = await app.request('/api/tasks?status=queued');
      expect(res.status).toBe(200);
      const body = await res.json() as unknown[];
      expect(body).toHaveLength(1);

      const backlogRes = await app.request('/api/tasks?status=backlog');
      const backlogBody = await backlogRes.json() as unknown[];
      expect(backlogBody).toHaveLength(1);
    });

    it('invalid status query → 400', async () => {
      const res = await app.request('/api/tasks?status=invalid_status');
      expect(res.status).toBe(400);
    });
  });

  describe('GET /api/tasks/:key', () => {
    it('returns task detail including activity', async () => {
      const r = await post(app, '/api/tasks', { title: 'My Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await app.request(`/api/tasks/${created.key}`);
      expect(res.status).toBe(200);
      const body = await res.json() as { key: string; activity: unknown[]; links: unknown[] };
      expect(body.key).toBe(created.key);
      expect(Array.isArray(body.activity)).toBe(true);
      expect(Array.isArray(body.links)).toBe(true);
    });

    it('unknown key → 404 with message', async () => {
      const res = await app.request('/api/tasks/AF-9999');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /api/tasks', () => {
    it('creates a task with 201, key AF-1, status backlog', async () => {
      const res = await post(app, '/api/tasks', {
        title: 'New Task',
        spec: 'Some spec',
        acceptanceCriteria: 'Some AC',
      });
      expect(res.status).toBe(201);
      const body = await res.json() as { key: string; status: string; title: string };
      expect(body.key).toBe('AF-1');
      expect(body.status).toBe('backlog');
      expect(body.title).toBe('New Task');
    });

    it('missing title → 400', async () => {
      const res = await post(app, '/api/tasks', { spec: 'Spec', acceptanceCriteria: 'AC' });
      expect(res.status).toBe(400);
    });

    it('empty title → 400', async () => {
      const res = await post(app, '/api/tasks', { title: '', spec: 'Spec', acceptanceCriteria: 'AC' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/tasks/:key', () => {
    it('edits a backlog task → 200 with updated title', async () => {
      const r = await post(app, '/api/tasks', { title: 'Original', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await patch(app, `/api/tasks/${created.key}`, { title: 'Updated Title' });
      expect(res.status).toBe(200);
      const body = await res.json() as { title: string };
      expect(body.title).toBe('Updated Title');
    });

    it('editing a non-backlog task → 409', async () => {
      const r = await post(app, '/api/tasks', { title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      // Move to queued
      await post(app, `/api/tasks/${created.key}/status`, { status: 'queued' });

      const res = await patch(app, `/api/tasks/${created.key}`, { title: 'New Title' });
      expect(res.status).toBe(409);
    });
  });

  describe('DELETE /api/tasks/:key', () => {
    it('deletes a task with 204; the task is gone afterward', async () => {
      const r = await post(app, '/api/tasks', { title: 'Doomed', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await app.request(`/api/tasks/${created.key}`, { method: 'DELETE' });
      expect(res.status).toBe(204);

      expect((await app.request(`/api/tasks/${created.key}`)).status).toBe(404);
    });

    it('rejects deleting an in_progress task with 409 JSON', async () => {
      const task = core.createTask({ title: 'Live', spec: 'Spec', acceptanceCriteria: 'AC' });
      core.updateStatus(task.key, 'queued', 'human');
      core.claimNextTask();

      const res = await app.request(`/api/tasks/${task.key}`, { method: 'DELETE' });
      expect(res.status).toBe(409);
      expect((await res.json() as { message: string }).message).toMatch(/release the claim/);

      expect((await app.request(`/api/tasks/${task.key}`)).status).toBe(200);
    });

    it('unknown key → 404', async () => {
      expect((await app.request('/api/tasks/AF-9999', { method: 'DELETE' })).status).toBe(404);
    });
  });

  describe('POST /:key/comment', () => {
    it('adds comment with 201 and actor is human (server-injected)', async () => {
      const r = await post(app, '/api/tasks', { title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await post(app, `/api/tasks/${created.key}/comment`, { body: 'My comment' });
      expect(res.status).toBe(201);
      const activity = await res.json() as { actor: string; body: string; type: string };
      expect(activity.actor).toBe('human');
      expect(activity.body).toBe('My comment');

      // Verify the comment shows up in task detail
      const detail = await app.request(`/api/tasks/${created.key}`);
      const detailBody = await detail.json() as { activity: Array<{ actor: string; type: string }> };
      const comments = detailBody.activity.filter((a) => a.type === 'comment');
      expect(comments.length).toBeGreaterThan(0);
      expect(comments[0]!.actor).toBe('human');
    });

    it('missing body → 400', async () => {
      const r = await post(app, '/api/tasks', { title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await post(app, `/api/tasks/${created.key}/comment`, {});
      expect(res.status).toBe(400);
    });
  });

  describe('POST /:key/status', () => {
    it('valid transition backlog→queued → 200', async () => {
      const r = await post(app, '/api/tasks', { title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await post(app, `/api/tasks/${created.key}/status`, { status: 'queued' });
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('queued');
    });

    it('invalid transition backlog→done → 409', async () => {
      const r = await post(app, '/api/tasks', { title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await post(app, `/api/tasks/${created.key}/status`, { status: 'done' });
      expect(res.status).toBe(409);
    });
  });

  describe('POST /:key/status — release claim', () => {
    it('releases an in_progress task to queued and clears claim metadata', async () => {
      const task = core.createTask({ title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      core.updateStatus(task.key, 'queued', 'human');
      core.claimNextTask({ claimedBy: 'worker-1' });

      const res = await post(app, `/api/tasks/${task.key}/status`, { status: 'queued' });
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; claimedBy: string | null; claimedAt: string | null };
      expect(body).toMatchObject({ status: 'queued', claimedBy: null, claimedAt: null });
    });
  });

  describe('POST /:key/status — reopen', () => {
    it('reopens a done task to queued and clears claim metadata', async () => {
      const task = core.createTask({ title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      core.updateStatus(task.key, 'queued', 'human');
      core.claimNextTask({ claimedBy: 'worker-1' });
      core.submitResult(task.key, { summary: 'Done!' });
      core.reviewApprove(task.key);

      const res = await post(app, `/api/tasks/${task.key}/status`, { status: 'queued' });
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string; claimedBy: string | null; claimedAt: string | null };
      expect(body).toMatchObject({ status: 'queued', claimedBy: null, claimedAt: null });
    });
  });

  describe('POST /:key/approve', () => {
    it('approves a task in_review → 200, status done', async () => {
      // Create task and drive to in_review via core
      const task = core.createTask({ title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      core.updateStatus(task.key, 'queued', 'human');
      core.claimNextTask(); // moves to in_progress
      core.submitResult(task.key, { summary: 'Done!' }); // moves to in_review

      const res = await post(app, `/api/tasks/${task.key}/approve`, {});
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('done');
    });

    it('approving a non-in_review task → 409', async () => {
      const r = await post(app, '/api/tasks', { title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      const created = await r.json() as { key: string };

      const res = await post(app, `/api/tasks/${created.key}/approve`, {});
      expect(res.status).toBe(409);
    });
  });

  describe('POST /:key/request-changes', () => {
    it('requests changes on in_review task → 200, status queued', async () => {
      // Drive to in_review via core
      const task = core.createTask({ title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      core.updateStatus(task.key, 'queued', 'human');
      core.claimNextTask();
      core.submitResult(task.key, { summary: 'Done!' });

      const res = await post(app, `/api/tasks/${task.key}/request-changes`, { feedback: 'Needs more work' });
      expect(res.status).toBe(200);
      const body = await res.json() as { status: string };
      expect(body.status).toBe('queued');
    });

    it('empty feedback → 400', async () => {
      const task = core.createTask({ title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });
      core.updateStatus(task.key, 'queued', 'human');
      core.claimNextTask();
      core.submitResult(task.key, { summary: 'Done!' });

      const res = await post(app, `/api/tasks/${task.key}/request-changes`, { feedback: '' });
      expect(res.status).toBe(400);
    });

    it('requesting changes on a non-in_review task → 409', async () => {
      // Task is backlog, not in_review
      await post(app, '/api/tasks', { title: 'Task', spec: 'Spec', acceptanceCriteria: 'AC' });

      const res = await post(app, '/api/tasks/AF-1/request-changes', { feedback: 'x' });
      expect(res.status).toBe(409);
    });
  });
});
