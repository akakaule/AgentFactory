import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Core } from '../types.js';
import type { UpdateTaskInput } from '@agentfactory/core';
import { createBody, updateBody, commentBody, statusBody, feedbackBody, listQuery } from '../schemas.js';

export function taskRoutes(core: Core) {
  const r = new Hono();

  r.get('/', zValidator('query', listQuery), (c) => {
    const { status } = c.req.valid('query');
    return c.json(core.listTasks(status !== undefined ? { status } : {}));
  });

  r.get('/:key', (c) => c.json(core.getTask(c.req.param('key'))));

  r.post('/', zValidator('json', createBody), (c) => c.json(core.createTask(c.req.valid('json')), 201));

  r.patch('/:key', zValidator('json', updateBody), (c) => {
    const b = c.req.valid('json');
    const fields: UpdateTaskInput = {};            // build explicitly to satisfy exactOptionalPropertyTypes
    if (b.title !== undefined) fields.title = b.title;
    if (b.spec !== undefined) fields.spec = b.spec;
    if (b.acceptanceCriteria !== undefined) fields.acceptanceCriteria = b.acceptanceCriteria;
    return c.json(core.updateTask(c.req.param('key'), fields));
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
