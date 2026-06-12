import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Core } from '../types.js';
import { NotFoundError, type UpdateTaskInput, type AddTaskMetricsInput } from '@agentfactory/core';
import { createBody, updateBody, commentBody, statusBody, feedbackBody, listQuery, metricsBody, attachmentBody, archiveAllBody } from '../schemas.js';
import { branchDiff } from '../git.js';

export function taskRoutes(core: Core) {
  const r = new Hono();

  r.get('/', zValidator('query', listQuery), (c) => {
    const { status, workspace, archived } = c.req.valid('query');
    return c.json(core.listTasks({ status, workspace, archived: archived === 'true' ? true : undefined }));
  });

  // registered before the /:key routes so the static segment is never read as a task key
  r.post('/archive-done', zValidator('json', archiveAllBody), (c) =>
    c.json(core.archiveDoneTasks({ workspace: c.req.valid('json').workspace })));

  r.get('/:key', (c) => c.json(core.getTask(c.req.param('key'))));

  r.get('/:key/diff', async (c) => {
    const task = core.getTask(c.req.param('key'));
    const branchLink = task.links.filter((l) => l.kind === 'branch').at(-1);
    if (!branchLink) throw new NotFoundError(`no branch link recorded for ${task.key}`);
    const { baseRef, diff, commits } = await branchDiff(task.repoPath, branchLink.label);
    return c.json({ branch: branchLink.label, baseRef, diff, commits });
  });

  r.post('/', zValidator('json', createBody), (c) => c.json(core.createTask(c.req.valid('json')), 201));

  r.patch('/:key', zValidator('json', updateBody), (c) => {
    const b = c.req.valid('json');
    const fields: UpdateTaskInput = {};            // build explicitly to satisfy exactOptionalPropertyTypes
    if (b.title !== undefined) fields.title = b.title;
    if (b.spec !== undefined) fields.spec = b.spec;
    if (b.acceptanceCriteria !== undefined) fields.acceptanceCriteria = b.acceptanceCriteria;
    return c.json(core.updateTask(c.req.param('key'), fields));
  });

  r.delete('/:key', (c) => {
    core.deleteTask(c.req.param('key'));
    return c.body(null, 204);
  });

  r.post('/:key/comment', zValidator('json', commentBody), (c) =>
    c.json(core.addComment(c.req.param('key'), { actor: 'human', body: c.req.valid('json').body }), 201));

  r.post('/:key/status', zValidator('json', statusBody), (c) =>
    c.json(core.updateStatus(c.req.param('key'), c.req.valid('json').status, 'human')));

  r.post('/:key/metrics', zValidator('json', metricsBody), (c) => {
    const b = c.req.valid('json');
    const input: AddTaskMetricsInput = {};         // explicit build for exactOptionalPropertyTypes
    if (b.model !== undefined) input.model = b.model;
    if (b.tokensIn !== undefined) input.tokensIn = b.tokensIn;
    if (b.tokensOut !== undefined) input.tokensOut = b.tokensOut;
    if (b.costUsd !== undefined) input.costUsd = b.costUsd;
    if (b.reportedBy !== undefined) input.reportedBy = b.reportedBy;
    return c.json(core.addTaskMetrics(c.req.param('key'), input), 201);
  });

  r.post('/:key/attachments', zValidator('json', attachmentBody), (c) =>
    c.json(core.addAttachment(c.req.param('key'), c.req.valid('json')), 201));

  r.post('/:key/archive', (c) => c.json(core.archiveTask(c.req.param('key'))));

  r.post('/:key/unarchive', (c) => c.json(core.unarchiveTask(c.req.param('key'))));

  r.post('/:key/approve', (c) => c.json(core.reviewApprove(c.req.param('key'))));

  r.post('/:key/request-changes', zValidator('json', feedbackBody), (c) =>
    c.json(core.reviewRequestChanges(c.req.param('key'), { feedback: c.req.valid('json').feedback })));

  return r;
}
