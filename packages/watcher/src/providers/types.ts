import type { RemoteRef, DeliveryChecksState, DeliveryChecksTarget, DeliveryFailingCheck } from '@agentfactory/core';

/** What one provider poll observed about a task's PR. */
export interface PrObservation {
  id: string;
  url: string;
  state: 'open' | 'merged' | 'closed'; // closed = closed/abandoned WITHOUT merging
  headSha: string | null;
  mergeCommitSha: string | null;
  mergeConflict?: { detail: string | null };
  /** The PR description as the host returned it ('' when empty); absent when the response did not
   *  carry one, so the watcher leaves the board-managed section alone. */
  body?: string;
}

export interface DeliveryCheckResult {
  /** null = no PR found for the branch (recorded as pr_state 'not_found'; the watcher keeps waiting). */
  pr: PrObservation | null;
  checks: { state: DeliveryChecksState; failing: DeliveryFailingCheck[] };
  /** The commit the checks describe; only 'merge_commit' is post-merge evidence. Absent = head. */
  checksTarget?: DeliveryChecksTarget;
}

export interface DeliveryProviderApi {
  key: 'github' | 'azdo';
  /**
   * Observe the PR (by `prUrl` when the finish protocol recorded one, else by head branch)
   * and its checks. `postMergeChecks` switches a merged PR's check target from the PR head
   * to the merge commit. Throws ProviderHttpError on HTTP failure — the watcher backs off.
   */
  check(remote: RemoteRef, branch: string, prUrl: string | null, opts: { postMergeChecks: boolean }): Promise<DeliveryCheckResult>;
  /**
   * Best-effort: pull concise error excerpts for a failing verdict — the build-log issues (ADO
   * timeline) or check-run output (GitHub) behind the red checks — so the requeue note hands the
   * fixing worker the actual errors, not just check names. Called by the watcher ONLY when
   * checks.state === 'failing', with the just-observed `result` (so it can reuse the PR head sha /
   * failing-check URLs). A throw or empty array degrades the bounce to names-only.
   */
  describeFailures?(remote: RemoteRef, result: DeliveryCheckResult, opts: { postMergeChecks: boolean }): Promise<string[]>;
  /**
   * Open a PR from `branch` into the repository's default branch (looked up on the host). Called
   * by the watcher only for a delivering task with no PR of its own. Returns null when the host
   * reports that an open PR for the branch already exists — the next check's search finds it.
   * Throws ProviderHttpError for anything else (auth/scope, validation), and the watcher backs off.
   */
  openPullRequest(remote: RemoteRef, req: OpenPullRequest): Promise<PrObservation | null>;
  /**
   * Replace the description of the PR `prId` (the observation's id) verbatim. Called by the watcher
   * only when the board-managed section changed, with a body of at most `maxBodyLength`
   * characters. Throws ProviderHttpError on HTTP failure.
   */
  updatePullRequestBody(remote: RemoteRef, prId: string, body: string): Promise<void>;
  /**
   * Merge the open PR `prId`, but only while its head is still `headSha` (the approved commit).
   * Resolves `{ merged: false, reason }` when the host refuses the merge (branch protection, not
   * mergeable, head moved) — the watcher keeps waiting. Throws ProviderHttpError for auth, rate
   * limits and anything else. Optional: only GitHub merges; Azure DevOps leaves it to a human.
   */
  mergePullRequest?(remote: RemoteRef, prId: string, req: { headSha: string; method: MergeMethod }): Promise<MergeOutcome>;
  /** The longest PR description the host accepts. */
  readonly maxBodyLength: number;
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';
export type MergeOutcome = { merged: true } | { merged: false; reason: string };

export interface OpenPullRequest {
  branch: string;
  title: string;
  body: string;
}

/**
 * Cap + dedupe + truncate error excerpts before they go into a requeue note — bounds the comment
 * size regardless of how noisy a build log is. Shared by both providers.
 */
const MAX_EXCERPTS = 15;
const MAX_EXCERPT_LEN = 600;
export function capExcerpts(lines: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of lines) {
    const msg = raw.trim();
    if (!msg) continue;
    const clipped = msg.length > MAX_EXCERPT_LEN ? `${msg.slice(0, MAX_EXCERPT_LEN)}…` : msg;
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= MAX_EXCERPTS) break;
  }
  return out;
}

/** An HTTP-level provider failure; `pauseUntilMs` set ⇒ a rate limit the whole watcher should respect. */
export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly pauseUntilMs: number | null = null,
  ) {
    super(message);
    this.name = 'ProviderHttpError';
  }
}
