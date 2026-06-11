import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Core } from '../types.js';
import { NotFoundError, type UpdateTaskInput } from '@agentfactory/core';
import { createBody, updateBody, commentBody, statusBody, feedbackBody, listQuery } from '../schemas.js';
import { branchDiff } from '../git.js';

export function taskRoutes(core: Core) {
  const r = new Hono();

  r.get('/', zValidator('query', listQuery), (c) => {
    const { status, workspace } = c.req.valid('query');
    return c.json(core.listTasks({ status, workspace }));
  });

  r.get('/:key', (c) => c.json(core.getTask(c.req.param('key'))));

  r.get('/:key/diff', async (c) => {
    const task = core.getTask(c.req.param('key'));
    const branchLink = task.links.filter((l) => l.kind === 'branch').at(-1);
    if (!branchLink) throw new NotFoundError(`no branch link recorded for ${task.key}`);
    const { baseRef, diff } = await branchDiff(task.repoPath, branchLink.label);
    return c.json({ branch: branchLink.label, baseRef, diff });
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

  r.post('/:key/approve', (c) => c.json(core.reviewApprove(c.req.param('key'))));

  r.post('/:key/request-changes', zValidator('json', feedbackBody), (c) =>
    c.json(core.reviewRequestChanges(c.req.param('key'), { feedback: c.req.valid('json').feedback })));

  return r;
}
