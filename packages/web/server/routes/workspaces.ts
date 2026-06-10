import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Core } from '../types.js';
import { workspaceBody } from '../schemas.js';

export function workspaceRoutes(core: Core) {
  const r = new Hono();

  r.get('/', (c) => c.json(core.listWorkspaces()));

  r.post('/', zValidator('json', workspaceBody), (c) => c.json(core.createWorkspace(c.req.valid('json')), 201));

  return r;
}
