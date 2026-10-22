import { Hono } from 'hono';
import { buildInboundWiql, parseRemoteUrl, resolveOriginUrl, ValidationError, type Workspace } from '@agentfactory/core';
import { validated } from '../validate.js';
import type { Core } from '../types.js';
import { workspaceBody, workspaceUpdateBody } from '../schemas.js';

/** The git host a workspace's origin points at — what the board UI needs to offer host features. */
export type WorkspaceRemote = { provider: 'github' } | { provider: 'azdo'; organization: string; project: string };
/** A workspace as the board serves it: plus its origin and, for an ADO import, the WIQL it runs. */
export type WorkspaceView = Workspace & { remote: WorkspaceRemote | null; adoSyncWiql: string | null };

const ORIGIN_TTL_MS = 60_000;

export function workspaceRoutes(core: Core, opts: { resolveOrigin?: ((repoPath: string) => string | null) | undefined } = {}) {
  const r = new Hono();
  const resolveOrigin = opts.resolveOrigin ?? resolveOriginUrl;
  // `git remote get-url` per workspace on every list would make the client's refetch shell out N
  // times; an origin almost never changes, so cache it per repo path for a minute.
  const originCache = new Map<string, { remote: WorkspaceRemote | null; at: number }>();
  const remoteOf = (repoPath: string): WorkspaceRemote | null => {
    const hit = originCache.get(repoPath);
    if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit.remote;
    const ref = parseRemoteUrl(resolveOrigin(repoPath) ?? '');
    const remote: WorkspaceRemote | null = !ref ? null
      : ref.provider === 'azdo' ? { provider: 'azdo', organization: ref.organization, project: ref.project }
      : { provider: 'github' };
    originCache.set(repoPath, { remote, at: Date.now() });
    return remote;
  };
  const view = (w: Workspace): WorkspaceView => {
    const remote = remoteOf(w.repoPath);
    const adoSyncWiql = remote?.provider === 'azdo' && w.adoSync ? buildInboundWiql(w.adoSync, w.adoSync.assignTo || '@Me') : null;
    return { ...w, remote, adoSyncWiql };
  };

  r.get('/', (c) => c.json(core.listWorkspaces().map(view)));

  r.post('/', validated('json', workspaceBody), (c) => c.json(view(core.createWorkspace(c.req.valid('json'))), 201));

  // PATCH the editable fields of an existing workspace (discipline, PAT, prompts, ADO import).
  r.patch('/:name', validated('json', workspaceUpdateBody), (c) => {
    const name = c.req.param('name');
    const body = c.req.valid('json');
    // the import reads work items from the origin's org/project — refuse to switch it on elsewhere
    if ((body.adoSync as { enabled?: unknown } | null | undefined)?.enabled === true) {
      const current = core.listWorkspaces().find((w) => w.name === name);
      const repoPath = body.repoPath ?? current?.repoPath;
      if (current && repoPath !== undefined && remoteOf(repoPath)?.provider !== 'azdo') {
        throw new ValidationError(`the work-item import needs an Azure DevOps origin; workspace '${name}' has none`);
      }
    }
    return c.json(view(core.updateWorkspace(name, body as Parameters<Core['updateWorkspace']>[1])));
  });

  return r;
}
