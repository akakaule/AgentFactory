import { Hono } from 'hono';
import { isAbsolute } from 'node:path';
import {
  buildInboundWiql, parseRemoteUrl, resolveOriginUrl, resolveBaseRef, effectiveWorkspaceProfile, diagnoseWorkspace, defaultDiagnoseProbes,
  NotFoundError, ValidationError, type Workspace, type EffectiveWorkspaceProfile, type DiagnoseProbes,
} from '@agentfactory/core';
import { validated } from '../validate.js';
import { rejectService } from '../auth.js';
import type { Core } from '../types.js';
import { workspaceBody, workspaceUpdateBody } from '../schemas.js';

/** The git host a workspace's origin points at — what the board UI needs to offer host features. */
export type WorkspaceRemote = { provider: 'github' } | { provider: 'azdo'; organization: string; project: string };
/** A workspace as the board serves it: plus its origin, for an ADO import the WIQL it runs, and its
 *  effective repository profile (each value with where it comes from: configured/detected/default). */
export type WorkspaceView = Workspace & { remote: WorkspaceRemote | null; adoSyncWiql: string | null; profile: EffectiveWorkspaceProfile };

/** The repo's default branch as a bare name (`main`), or null — never throws. Relative paths resolve
 *  to null, like resolveOriginUrl: they depend on the server's cwd. */
async function detectDefaultBranch(repoPath: string): Promise<string | null> {
  if (!isAbsolute(repoPath)) return null;
  try { return (await resolveBaseRef(repoPath)).replace(/^origin\//, ''); } catch { return null; }
}

const ORIGIN_TTL_MS = 60_000;

export function workspaceRoutes(core: Core, opts: {
  resolveOrigin?: ((repoPath: string) => string | null) | undefined;
  detectBaseBranch?: ((repoPath: string) => Promise<string | null>) | undefined;
  diagnoseProbes?: DiagnoseProbes | undefined;
} = {}) {
  const r = new Hono();
  const resolveOrigin = opts.resolveOrigin ?? resolveOriginUrl;
  const detectBaseBranch = opts.detectBaseBranch ?? detectDefaultBranch;
  // the default branch changes about as rarely as the origin — same per-repo-path cache
  const baseCache = new Map<string, { branch: string | null; at: number }>();
  const detectedBaseOf = async (repoPath: string): Promise<string | null> => {
    const hit = baseCache.get(repoPath);
    if (hit && Date.now() - hit.at < ORIGIN_TTL_MS) return hit.branch;
    const branch = await detectBaseBranch(repoPath);
    baseCache.set(repoPath, { branch, at: Date.now() });
    return branch;
  };
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
  const view = async (w: Workspace): Promise<WorkspaceView> => {
    const remote = remoteOf(w.repoPath);
    const adoSyncWiql = remote?.provider === 'azdo' && w.adoSync ? buildInboundWiql(w.adoSync, w.adoSync.assignTo || '@Me') : null;
    // detection only matters (and only spawns git) when no base branch is configured
    const profile = effectiveWorkspaceProfile(w, w.baseBranch === null ? await detectedBaseOf(w.repoPath) : null);
    return { ...w, remote, adoSyncWiql, profile };
  };

  r.get('/', async (c) => c.json(await Promise.all(core.listWorkspaces().map(view))));

  r.post('/', validated('json', workspaceBody), async (c) => c.json(await view(core.createWorkspace(c.req.valid('json'))), 201));

  // PATCH the editable fields of an existing workspace (discipline, PAT, prompts, ADO import).
  r.patch('/:name', validated('json', workspaceUpdateBody), async (c) => {
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
    const updated = core.updateWorkspace(name, body as Parameters<Core['updateWorkspace']>[1]);
    if (body.repoPath !== undefined) baseCache.delete(updated.repoPath); // re-pointed: detect afresh
    return c.json(await view(updated));
  });

  // Read-only setup diagnosis (repo path + case, origin, base ref, git/node, verify executable, PAT
  // presence, host check access). Human-only: it exercises the stored credential against the host.
  // The PAT is passed to core only as a request header — the response never carries it.
  r.get('/:name/diagnose', rejectService, async (c) => {
    const name = c.req.param('name');
    const workspace = core.listWorkspaces().find((w) => w.name === name);
    if (!workspace) throw new NotFoundError(`workspace not found: ${name}`);
    return c.json(await diagnoseWorkspace({ workspace, pat: core.getWorkspacePat(name) }, opts.diagnoseProbes ?? defaultDiagnoseProbes()));
  });

  return r;
}
