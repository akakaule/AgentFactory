import type { DeliveryChecksState, DeliveryFailingCheck } from '@agentfactory/core';
import type { FetchJson, FetchResponse } from '../types.js';
import { ProviderHttpError, capExcerpts, type DeliveryCheckResult, type DeliveryProviderApi, type PrObservation } from './types.js';
import { azdoGuard, basicPat } from './azdoHttp.js';
import { fitBody } from '../prBody.js';

/**
 * Azure DevOps via REST with a PAT. Reads need Code (Read); the one write — opening the PR once a
 * task is delivering — needs Code (Read & write).
 * PR search is the ado-bridge `Build-AdoPrSearchPath` shape, broadened from status=completed
 * to status=all so open/abandoned PRs classify too. "Checks" are the PR status records
 * (build-validation policies and external status writers post there); a merged/abandoned
 * PR keeps its final statuses, so the same read works pre- and post-merge. With postMergeChecks,
 * a completed PR is judged on its merge commit instead: the commit's statuses plus the builds of
 * that commit on the target branch (CI pipelines post no PR status after completion).
 */

interface AdoPr {
  pullRequestId: number;
  status: 'active' | 'completed' | 'abandoned' | string;
  mergeStatus?: 'notSet' | 'queued' | 'conflicts' | 'succeeded' | 'rejectedByPolicy' | 'failure' | string;
  mergeFailureMessage?: string | null;
  lastMergeSourceCommit?: { commitId: string } | null;
  lastMergeCommit?: { commitId: string } | null;
  targetRefName?: string;
  repository?: { id?: string } | null;
  creationDate?: string;
  description?: string | null;
}
/** One Azure Pipelines build (`_apis/build/builds`). */
interface AdoBuild {
  id: number;
  status?: string; // notStarted | inProgress | cancelling | postponed | completed
  result?: string | null; // succeeded | partiallySucceeded | failed | canceled
  sourceVersion?: string;
  definition?: { name?: string } | null;
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


/** Human PR web URL (the REST payload's `url` is an API self-link, not a browser link). */
function prWebUrl(remote: { organization: string; project: string; repo: string }, id: number): string {
  const e = encodeURIComponent;
  return `https://dev.azure.com/${e(remote.organization)}/${e(remote.project)}/_git/${e(remote.repo)}/pullrequest/${id}`;
}

function toPr(remote: { organization: string; project: string; repo: string }, pr: AdoPr): PrObservation {
  const obs: PrObservation = {
    id: `!${pr.pullRequestId}`,
    url: prWebUrl(remote, pr.pullRequestId),
    state: pr.status === 'completed' ? 'merged' : pr.status === 'abandoned' ? 'closed' : 'open',
    headSha: pr.lastMergeSourceCommit?.commitId ?? null,
    mergeCommitSha: pr.lastMergeCommit?.commitId ?? null,
    // Azure DevOps omits the field when the description is empty
    body: pr.description ?? '',
  };
  if (obs.state === 'open' && pr.mergeStatus === 'conflicts') {
    return { ...obs, mergeConflict: { detail: pr.mergeFailureMessage?.trim() || 'Azure DevOps reports mergeStatus=conflicts' } };
  }
  return obs;
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

/**
 * Fold a merge commit's statuses and builds into one verdict (red beats pending beats green).
 * Only builds of `commitId` count; a failed/canceled build fails, an unfinished one is pending.
 */
export function combineAdoMergeCommitChecks(
  statuses: AdoPrStatus[], builds: AdoBuild[], commitId: string, buildUrl: (id: number) => string,
): { state: DeliveryChecksState; failing: DeliveryFailingCheck[] } {
  const fromStatuses = combineAdoStatuses(statuses);
  const failing = [...fromStatuses.failing];
  let pending = fromStatuses.state === 'pending';
  const own = builds.filter((b) => b.sourceVersion === commitId);
  for (const b of own) {
    if (b.status !== 'completed') pending = true;
    else if (b.result === 'failed' || b.result === 'canceled') failing.push({ name: b.definition?.name ?? `build ${b.id}`, url: buildUrl(b.id) });
  }
  if (failing.length > 0) return { state: 'failing', failing };
  if (pending) return { state: 'pending', failing: [] };
  if (statuses.length === 0 && own.length === 0) return { state: 'none', failing: [] };
  return { state: 'passing', failing: [] };
}

export function makeAzdoProvider(opts: { fetchJson: FetchJson; pat: string | null; apiVersion: string }): DeliveryProviderApi {
  const { fetchJson, pat, apiVersion } = opts;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(pat ? { Authorization: basicPat(pat) } : {}),
  };

  const guard = (res: FetchResponse, url: string, write = false): FetchResponse =>
    write ? azdoGuard(res, url, 'Code (Read & write), needed to open the PR,', [200, 201]) : azdoGuard(res, url, 'Code (Read)');
  const get = async (url: string): Promise<unknown> => guard(await fetchJson(url, { headers }), url).body;
  const repoBase = (remote: { organization: string; project: string; repo: string }): string => {
    const e = encodeURIComponent;
    return `https://dev.azure.com/${e(remote.organization)}/${e(remote.project)}/_apis/git/repositories/${e(remote.repo)}`;
  };

  return {
    key: 'azdo',
    async check(remote, branch, prUrl, { postMergeChecks }): Promise<DeliveryCheckResult> {
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
        // a completed (merged) PR wins, then the active one, then the newest id (abandoned retries)
        pr = prs.find((p) => p.status === 'completed') ?? prs.find((p) => p.status === 'active')
          ?? prs.sort((a, b) => b.pullRequestId - a.pullRequestId)[0] ?? null;
      }
      if (!pr) return { pr: null, checks: { state: 'unknown', failing: [] } };

      const obs = toPr(remote, pr);
      if (obs.state === 'open' && obs.mergeConflict) {
        return { pr: obs, checks: { state: 'failing', failing: [{ name: 'merge conflict', url: obs.url }] } };
      }
      const mergeCommit = obs.state === 'merged' && postMergeChecks ? obs.mergeCommitSha : null;
      if (mergeCommit) {
        // Post-merge evidence: the merge commit's own statuses + the builds of that commit.
        const projectBase = `https://dev.azure.com/${e(remote.organization)}/${e(remote.project)}`;
        const repoId = pr.repository?.id ?? ((await get(`${base}?api-version=${apiVersion}`)) as { id?: string }).id ?? remote.repo;
        const commitStatuses = (await get(`${base}/commits/${e(mergeCommit)}/statuses?latestOnly=true&api-version=${apiVersion}`)) as { value?: AdoPrStatus[] };
        const builds = (await get(
          `${projectBase}/_apis/build/builds?repositoryId=${e(repoId)}&repositoryType=TfsGit` +
          `${pr.targetRefName ? `&branchName=${e(pr.targetRefName)}` : ''}&queryOrder=queueTimeDescending&$top=50&api-version=${apiVersion}`,
        )) as { value?: AdoBuild[] };
        const checks = combineAdoMergeCommitChecks(commitStatuses.value ?? [], builds.value ?? [], mergeCommit,
          (id) => `${projectBase}/_build/results?buildId=${id}`);
        return { pr: obs, checks, checksTarget: 'merge_commit' };
      }
      const statuses = (await get(`${base}/pullRequests/${pr.pullRequestId}/statuses?api-version=${apiVersion}`)) as { value?: AdoPrStatus[] };
      const checks = combineAdoStatuses(statuses.value ?? []);
      // Merge completion is independent of checks; preserve the provider's actual status evidence.
      // PR statuses describe the PR, never the merge commit, so they are not post-merge evidence.
      return { pr: obs, checks, checksTarget: 'head' };
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

    async openPullRequest(remote, { branch, title, body }): Promise<PrObservation | null> {
      if (remote.provider !== 'azdo') throw new Error('azdo provider got a non-azdo remote');
      const base = repoBase(remote);
      const info = (await get(`${base}?api-version=${apiVersion}`)) as { defaultBranch?: string };
      if (!info.defaultBranch) throw new ProviderHttpError(`azdo reports no default branch for ${base}`, 0);
      const url = `${base}/pullrequests?api-version=${apiVersion}`;
      const res = await fetchJson(url, {
        headers, method: 'POST',
        body: JSON.stringify({
          sourceRefName: `refs/heads/${branch}`,
          targetRefName: info.defaultBranch,
          title,
          description: fitBody(body, MAX_DESCRIPTION),
        }),
      });
      // TF401179: an active PR for this source/target pair already exists — the search finds it next tick.
      if (res.status === 409) return null;
      return toPr(remote, guard(res, url, true).body as AdoPr);
    },

    async updatePullRequestBody(remote, prId, body): Promise<void> {
      if (remote.provider !== 'azdo') throw new Error('azdo provider got a non-azdo remote');
      const num = /^!(\d+)$/.exec(prId)?.[1];
      if (!num) throw new Error(`not an Azure DevOps PR id: ${prId}`);
      const url = `${repoBase(remote)}/pullrequests/${num}?api-version=${apiVersion}`;
      // Never truncate here: the text outside the markers belongs to humans.
      if (body.length > MAX_DESCRIPTION) throw new Error(`PR description of ${body.length} characters exceeds Azure DevOps' ${MAX_DESCRIPTION}`);
      const res = await fetchJson(url, { headers, method: 'PATCH', body: JSON.stringify({ description: body }) });
      guard(res, url, true);
    },

    maxBodyLength: MAX_DESCRIPTION,
  };
}

/** Azure DevOps rejects a PR description longer than this. */
const MAX_DESCRIPTION = 4000;
