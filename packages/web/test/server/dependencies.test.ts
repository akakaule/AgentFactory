import { beforeEach, describe, expect, it } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

describe('task dependency REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  const createTask = (title: string) =>
    core.createTask({ title, spec: 'Spec', acceptanceCriteria: 'Acceptance' });

  it('PUT adds a dependency and is idempotent', async () => {
    const prerequisite = createTask('Prerequisite');
    const dependent = createTask('Dependent');
    const path = `/api/tasks/${dependent.key}/dependencies/${prerequisite.key}`;

    const first = await app.request(path, { method: 'PUT' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      key: dependent.key,
      dependencies: [{ key: prerequisite.key }],
    });

    const repeated = await app.request(path, { method: 'PUT' });
    expect(repeated.status).toBe(200);
    expect((await repeated.json() as { dependencies: unknown[] }).dependencies).toHaveLength(1);
  });

  it('DELETE removes a dependency and is idempotent', async () => {
    const prerequisite = createTask('Prerequisite');
    const dependent = createTask('Dependent');
    const path = `/api/tasks/${dependent.key}/dependencies/${prerequisite.key}`;
    await app.request(path, { method: 'PUT' });

    const first = await app.request(path, { method: 'DELETE' });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ key: dependent.key, dependencies: [] });

    const repeated = await app.request(path, { method: 'DELETE' });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toMatchObject({ key: dependent.key, dependencies: [] });
  });

  it('returns 404 when either endpoint is missing', async () => {
    const existing = createTask('Existing');

    expect((await app.request(
      `/api/tasks/AF-9999/dependencies/${existing.key}`,
      { method: 'PUT' },
    )).status).toBe(404);
    expect((await app.request(
      `/api/tasks/${existing.key}/dependencies/AF-9999`,
      { method: 'PUT' },
    )).status).toBe(404);
  });

  it('returns 400 for a self-dependency', async () => {
    const task = createTask('Task');

    const response = await app.request(
      `/api/tasks/${task.key}/dependencies/${task.key}`,
      { method: 'PUT' },
    );

    expect(response.status).toBe(400);
  });

  it('returns 409 for a dependency cycle', async () => {
    const first = createTask('First');
    const second = createTask('Second');
    expect((await app.request(
      `/api/tasks/${second.key}/dependencies/${first.key}`,
      { method: 'PUT' },
    )).status).toBe(200);

    const response = await app.request(
      `/api/tasks/${first.key}/dependencies/${second.key}`,
      { method: 'PUT' },
    );

    expect(response.status).toBe(409);
  });

  it('returns 409 when adding to an in-progress dependent', async () => {
    const dependent = createTask('Dependent');
    const prerequisite = createTask('Prerequisite');
    core.updateStatus(dependent.key, 'queued', 'human');
    core.claimNextTask();

    const response = await app.request(
      `/api/tasks/${dependent.key}/dependencies/${prerequisite.key}`,
      { method: 'PUT' },
    );

    expect(response.status).toBe(409);
  });

  it('returns 409 when removing from an in-progress dependent', async () => {
    const prerequisite = createTask('Prerequisite');
    const dependent = createTask('Dependent');
    const path = `/api/tasks/${dependent.key}/dependencies/${prerequisite.key}`;
    expect((await app.request(path, { method: 'PUT' })).status).toBe(200);

    core.updateStatus(prerequisite.key, 'queued', 'human');
    core.claimNextTask();
    core.submitResult(prerequisite.key, { summary: 'Done' });
    core.reviewApprove(prerequisite.key);
    core.updateStatus(dependent.key, 'queued', 'human');
    core.claimNextTask();

    const response = await app.request(path, { method: 'DELETE' });

    expect(response.status).toBe(409);
  });
});
