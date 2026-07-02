import type { RemoteRef, DeliveryChecksState, DeliveryFailingCheck } from '@agentfactory/core';
import type { FetchJson, FetchResponse } from '../types.js';
import { ProviderHttpError, type DeliveryCheckResult, type DeliveryProviderApi, type PrObservation } from './types.js';

/**
 * GitHub via REST with a token — deliberately not the `gh` CLI: a long-lived poller wants the
 * rate-limit headers (principled global pauses), no process spawn per task per poll, and no
 * dependency on `gh auth` state on whatever host runs the watcher. ~3 calls per task per poll
 * against a 5,000/h authed budget.
 */

interface GitHubPr {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged?: boolean;               // present on GET /pulls/{n}, absent on the list endpoint
  merged_at: string | null;       // list endpoint's merge signal
  head: { sha: string };
  merge_commit_sha: string | null;
}
interface CheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | string;
  conclusion: string | null; // success | failure | neutral | cancelled | timed_out | action_required | skipped | stale
  html_url: string | null;
  details_url: string | null;
}
interface CommitStatus { state: string; context: string; target_url: string | null; }

const FAILING_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);
const FAILING_STATUS_STATES = new Set(['failure', 'error']);

function toPr(pr: GitHubPr): PrObservation {
  const merged = pr.merged === true || pr.merged_at !== null;
  return {
    id: `#${pr.number}`,
    url: pr.html_url,
    state: merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
    headSha: pr.head.sha,
    mergeCommitSha: pr.merge_commit_sha,
  };
}

/** Fold check-runs + legacy commit statuses into one verdict (red beats pending beats green). */
export function combineChecks(runs: CheckRun[], statuses: CommitStatus[]): { state: DeliveryChecksState; failing: DeliveryFailingCheck[] } {
  const failing: DeliveryFailingCheck[] = [];
  let pending = false;
  for (const r of runs) {
    if (r.status !== 'completed') pending = true;
    else if (r.conclusion !== null && FAILING_CONCLUSIONS.has(r.conclusion)) failing.push({ name: r.name, url: r.html_url ?? r.details_url ?? null });
  }
  for (const s of statuses) {
    if (s.state === 'pending') pending = true;
    else if (FAILING_STATUS_STATES.has(s.state)) failing.push({ name: s.context, url: s.target_url ?? null });
  }
  if (failing.length > 0) return { state: 'failing', failing };
  if (pending) return { state: 'pending', failing: [] };
  if (runs.length === 0 && statuses.length === 0) return { state: 'none', failing: [] };
  return { state: 'passing', failing: [] };
}

export function makeGitHubProvider(opts: { fetchJson: FetchJson; token: string | null; apiBase: string; now: () => number }): DeliveryProviderApi {
  const { fetchJson, token, apiBase, now } = opts;

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'agentfactory-watcher',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };

  const guard = (res: FetchResponse, url: string): FetchResponse => {
    if (res.status === 200) return res;
    // Primary rate limit: remaining 0 + a reset epoch. Secondary/abuse: 429 or retry-after.
    const remaining = Number(res.headers['x-ratelimit-remaining'] ?? NaN);
    const reset = Number(res.headers['x-ratelimit-reset'] ?? NaN);
    const retryAfter = Number(res.headers['retry-after'] ?? NaN);
    let pause: number | null = null;
    if (res.status === 429 || ((res.status === 403 || res.status === 401) && remaining === 0)) {
      pause = Number.isFinite(retryAfter) ? now() + retryAfter * 1000 : Number.isFinite(reset) ? reset * 1000 : now() + 60_000;
    }
    throw new ProviderHttpError(`github ${res.status} for ${url}`, res.status, pause);
  };

  const get = async (url: string): Promise<unknown> => guard(await fetchJson(url, { headers }), url).body;

  return {
    key: 'github',
    async check(remote, branch, prUrl, { postMergeChecks }): Promise<DeliveryCheckResult> {
      if (remote.provider !== 'github') throw new Error('github provider got a non-github remote');
      const repo = `${apiBase}/repos/${encodeURIComponent(remote.owner)}/${encodeURIComponent(remote.repo)}`;

      // The finish protocol's pr link is authoritative when present; head-branch search is the
      // fallback (pre-protocol tasks, manually opened PRs). state=all → a merged/closed PR is
      // still found after its branch is deleted.
      let pr: GitHubPr | null = null;
      const num = prUrl ? /\/pull\/(\d+)(?:$|[/?#])/.exec(prUrl)?.[1] : undefined;
      if (num) {
        pr = (await get(`${repo}/pulls/${num}`)) as GitHubPr;
      } else {
        const list = (await get(
          `${repo}/pulls?head=${encodeURIComponent(`${remote.owner}:${branch}`)}&state=all&sort=updated&direction=desc&per_page=10`,
        )) as GitHubPr[];
        // a merged PR wins over a closed retry; otherwise the most recently updated
        pr = list.find((p) => p.merged_at !== null) ?? list[0] ?? null;
      }
      if (!pr) return { pr: null, checks: { state: 'unknown', failing: [] } };

      const obs = toPr(pr);
      // Pre-merge semantics check the PR head; postMergeChecks moves a merged PR's target to
      // the merge commit (falling back to the head when the API returns no merge sha).
      const sha = obs.state === 'merged' && postMergeChecks ? (obs.mergeCommitSha ?? obs.headSha) : obs.headSha;
      if (!sha) return { pr: obs, checks: { state: 'unknown', failing: [] } };

      const runsBody = (await get(`${repo}/commits/${sha}/check-runs?per_page=100`)) as { check_runs?: CheckRun[] };
      const statusBody = (await get(`${repo}/commits/${sha}/status`)) as { statuses?: CommitStatus[] };
      return { pr: obs, checks: combineChecks(runsBody.check_runs ?? [], statusBody.statuses ?? []) };
    },
  };
}
