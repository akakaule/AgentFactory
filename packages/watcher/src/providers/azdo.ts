import type { DeliveryChecksState, DeliveryFailingCheck } from '@agentfactory/core';
import type { FetchJson, FetchResponse } from '../types.js';
import { ProviderHttpError, capExcerpts, type DeliveryCheckResult, type DeliveryProviderApi, type PrObservation } from './types.js';

/**
 * Azure DevOps via REST with a PAT (Code Read scope — the watcher never writes to the host).
 * PR search is the ado-bridge `Build-AdoPrSearchPath` shape, broadened from status=completed
 * to status=all so open/abandoned PRs classify too. "Checks" are the PR status records
 * (build-validation policies and external status writers post there); a merged/abandoned
 * PR keeps its final statuses, so the same read works pre- and post-merge.
 */

interface AdoPr {
  pullRequestId: number;
  status: 'active' | 'completed' | 'abandoned' | string;
  lastMergeSourceCommit?: { commitId: string } | null;
  lastMergeCommit?: { commitId: string } | null;
  creationDate?: string;
}
interface AdoPrStatus {
  state: string; // succeeded | failed | error | pending | notSet | notApplicable
  context?: { name?: string; genre?: string } | null;
  targetUrl?: string | null;
}
/** One node of a build's execution tree; each carries any errors/warnings it raised. */
interface AdoTimeline {
  records?: Array<{ issues?: Array<{ type?: string; message?: string }> | null }>;
}

/**
 * A build id from a PR-status targetUrl. Build-validation statuses point at the build results page
 * (`_build/results?buildId=123`); older/vstfs links use `/Build/Build/123`. Null when neither shape
 * matches (e.g. an external non-build status), so that check is simply skipped.
 */
export function parseBuildId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /(?:[?&]buildId=|\/Build\/Build\/)(\d+)/i.exec(url);
  return m ? m[1]! : null;
}

const basicPat = (pat: string): string => `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

/** Human PR web URL (the REST payload's `url` is an API self-link, not a browser link). */
function prWebUrl(remote: { organization: string; project: string; repo: string }, id: number): string {
  const e = encodeURIComponent;
  return `https://dev.azure.com/${e(remote.organization)}/${e(remote.project)}/_git/${e(remote.repo)}/pullrequest/${id}`;
}

function toPr(remote: { organization: string; project: string; repo: string }, pr: AdoPr): PrObservation {
  return {
    id: `!${pr.pullRequestId}`,
    url: prWebUrl(remote, pr.pullRequestId),
    state: pr.status === 'completed' ? 'merged' : pr.status === 'abandoned' ? 'closed' : 'open',
    headSha: pr.lastMergeSourceCommit?.commitId ?? null,
    mergeCommitSha: pr.lastMergeCommit?.commitId ?? null,
  };
}

/** Fold ADO PR statuses into one verdict (red beats pending beats green; none = no gate configured). */
export function combineAdoStatuses(statuses: AdoPrStatus[]): { state: DeliveryChecksState; failing: DeliveryFailingCheck[] } {
  const failing: DeliveryFailingCheck[] = [];
  let pending = false;
  for (const s of statuses) {
    const name = s.context?.name ?? 'status';
    if (s.state === 'failed' || s.state === 'error') failing.push({ name, url: s.targetUrl ?? null });
    else if (s.state === 'pending' || s.state === 'notSet') pending = true;
  }
  if (failing.length > 0) return { state: 'failing', failing };
  if (pending) return { state: 'pending', failing: [] };
  if (statuses.length === 0) return { state: 'none', failing: [] };
  return { state: 'passing', failing: [] };
}

export function makeAzdoProvider(opts: { fetchJson: FetchJson; pat: string | null; apiVersion: string }): DeliveryProviderApi {
  const { fetchJson, pat, apiVersion } = opts;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(pat ? { Authorization: basicPat(pat) } : {}),
  };

  const guard = (res: FetchResponse, url: string): FetchResponse => {
    if (res.status === 200) return res;
    // ADO throttling: 429 with Retry-After (also X-RateLimit-Reset on some responses).
    const retryAfter = Number(res.headers['retry-after'] ?? NaN);
    if (res.status === 429) {
      throw new ProviderHttpError(`azdo 429 for ${url}`, 429, Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000);
    }
    // Auth: ADO answers an unauthenticated/failed-PAT request with the Azure AD sign-in page and a
    // 203 (Non-Authoritative Information), not a 401 — so 203/401/403 all mean "the PAT is missing,
    // invalid, expired, or lacks Code (Read) for this org/project", not a transient error.
    if (res.status === 203 || res.status === 401 || res.status === 403) {
      throw new ProviderHttpError(
        `azdo auth failed (${res.status}) — the PAT is missing, invalid, expired, or lacks Code (Read) for this org/project: ${url}`,
        res.status,
      );
    }
    throw new ProviderHttpError(`azdo ${res.status} for ${url}`, res.status);
  };
  const get = async (url: string): Promise<unknown> => guard(await fetchJson(url, { headers }), url).body;

  return {
    key: 'azdo',
    async check(remote, branch, prUrl, _opts): Promise<DeliveryCheckResult> {
      if (remote.provider !== 'azdo') throw new Error('azdo provider got a non-azdo remote');
      const e = encodeURIComponent;
      const base = `https://dev.azure.com/${e(remote.organization)}/${e(remote.project)}/_apis/git/repositories/${e(remote.repo)}`;

      let pr: AdoPr | null = null;
      const num = prUrl ? /\/pullrequest\/(\d+)(?:$|[/?#])/i.exec(prUrl)?.[1] : undefined;
      if (num) {
        pr = (await get(`${base}/pullrequests/${num}?api-version=${apiVersion}`)) as AdoPr;
      } else {
        const list = (await get(
          `${base}/pullrequests?searchCriteria.sourceRefName=${e(`refs/heads/${branch}`)}&searchCriteria.status=all&$top=10&api-version=${apiVersion}`,
        )) as { value?: AdoPr[] };
        const prs = list.value ?? [];
        // a completed (merged) PR wins over an abandoned retry; otherwise the newest id
        pr = prs.find((p) => p.status === 'completed') ?? prs.sort((a, b) => b.pullRequestId - a.pullRequestId)[0] ?? null;
      }
      if (!pr) return { pr: null, checks: { state: 'unknown', failing: [] } };

      const obs = toPr(remote, pr);
      const statuses = (await get(`${base}/pullRequests/${pr.pullRequestId}/statuses?api-version=${apiVersion}`)) as { value?: AdoPrStatus[] };
      return { pr: obs, checks: combineAdoStatuses(statuses.value ?? []) };
    },

    async describeFailures(remote, result): Promise<string[]> {
      if (remote.provider !== 'azdo') return [];
      const e = encodeURIComponent;
      const projectBase = `https://dev.azure.com/${e(remote.organization)}/${e(remote.project)}`;
      // Each failing build-validation status targets a build; pull that build's timeline and
      // collect the error issues (the `##[error]` lines). Dedupe across builds/records.
      const buildIds = new Set<string>();
      for (const f of result.checks.failing) {
        const id = parseBuildId(f.url);
        if (id) buildIds.add(id);
      }
      const messages: string[] = [];
      for (const id of buildIds) {
        try {
          const tl = (await get(`${projectBase}/_apis/build/builds/${id}/timeline?api-version=${apiVersion}`)) as AdoTimeline;
          for (const rec of tl.records ?? []) {
            for (const issue of rec.issues ?? []) {
              if ((issue.type ?? '').toLowerCase() === 'error' && issue.message) messages.push(issue.message);
            }
          }
        } catch {
          // best-effort: a missing build, or a PAT without Build (Read) → this build yields no
          // excerpts; the bounce still carries the check names. Never throws to the watcher.
        }
      }
      return capExcerpts(messages);
    },
  };
}
