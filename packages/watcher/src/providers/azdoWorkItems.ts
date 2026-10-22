import type { FetchJson } from '../types.js';
import { azdoGuard, basicPat } from './azdoHttp.js';

/**
 * Azure DevOps work-item REST for the per-workspace import (port of ado-bridge's AdoApi.ps1).
 * Every call needs the PAT to carry Work Items (Read & write) — the claim, the tag-back and the
 * state write-back are all PATCHes.
 */

export interface AdoProject { organization: string; project: string }
export interface AdoWorkItem { id: number; rev: number; fields: Record<string, unknown> }
export interface JsonPatchOp { op: 'add' | 'test'; path: string; value: unknown }

const SCOPE = 'Work Items (Read & write)';
const BATCH = 200; // workitemsbatch accepts at most 200 ids per call

export interface AzdoWorkItemsApi {
  /** Ids matching a WIQL query, in the query's ORDER BY. */
  wiql(p: AdoProject, query: string): Promise<number[]>;
  /** The given items (deleted/inaccessible ids are silently omitted), in the order asked for. */
  batch(p: AdoProject, ids: number[], fields: string[]): Promise<AdoWorkItem[]>;
  /** Apply a JSON-patch; a failing `test /rev` op throws (a concurrent edit won). */
  patch(p: AdoProject, id: number, ops: JsonPatchOp[]): Promise<AdoWorkItem>;
  /** The PAT owner's account name (`user@domain`), the identity claimed items are assigned to. */
  whoAmI(p: AdoProject): Promise<string | null>;
}

export function makeAzdoWorkItems(opts: { fetchJson: FetchJson; pat: string | null; apiVersion: string }): AzdoWorkItemsApi {
  const { fetchJson, pat, apiVersion } = opts;
  const auth: Record<string, string> = { Accept: 'application/json', ...(pat ? { Authorization: basicPat(pat) } : {}) };
  const e = encodeURIComponent;
  const wit = (p: AdoProject) => `https://dev.azure.com/${e(p.organization)}/${e(p.project)}/_apis/wit`;
  const send = async (url: string, method: 'GET' | 'POST' | 'PATCH', body?: unknown, contentType?: string): Promise<unknown> => {
    const headers = contentType ? { ...auth, 'Content-Type': contentType } : auth;
    const res = await fetchJson(url, { headers, method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return azdoGuard(res, url, SCOPE).body;
  };

  return {
    async wiql(p, query) {
      const body = (await send(`${wit(p)}/wiql?api-version=${apiVersion}`, 'POST', { query })) as { workItems?: Array<{ id: number }> } | null;
      return (body?.workItems ?? []).map((w) => Number(w.id));
    },

    async batch(p, ids, fields) {
      const byId = new Map<number, AdoWorkItem>();
      for (let i = 0; i < ids.length; i += BATCH) {
        const body = (await send(`${wit(p)}/workitemsbatch?api-version=${apiVersion}`, 'POST', {
          ids: ids.slice(i, i + BATCH), fields, errorPolicy: 'omit',
        })) as { value?: Array<AdoWorkItem | null> } | null;
        for (const wi of body?.value ?? []) if (wi) byId.set(Number(wi.id), wi);
      }
      return ids.map((id) => byId.get(id)).filter((wi): wi is AdoWorkItem => wi !== undefined);
    },

    async patch(p, id, ops) {
      return (await send(`${wit(p)}/workitems/${id}?api-version=${apiVersion}`, 'PATCH', ops, 'application/json-patch+json')) as AdoWorkItem;
    },

    async whoAmI(p) {
      const body = (await send(`https://dev.azure.com/${e(p.organization)}/_apis/connectionData`, 'GET')) as
        { authenticatedUser?: { properties?: { Account?: { $value?: string } } } } | null;
      return body?.authenticatedUser?.properties?.Account?.$value ?? null;
    },
  };
}
