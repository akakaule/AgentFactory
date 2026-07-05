import type { RemoteRef, DeliveryChecksState, DeliveryFailingCheck } from '@agentfactory/core';

/** What one provider poll observed about a task's PR. */
export interface PrObservation {
  id: string;
  url: string;
  state: 'open' | 'merged' | 'closed'; // closed = closed/abandoned WITHOUT merging
  headSha: string | null;
  mergeCommitSha: string | null;
}

export interface DeliveryCheckResult {
  /** null = no PR found for the branch (recorded as pr_state 'not_found'; the watcher keeps waiting). */
  pr: PrObservation | null;
  checks: { state: DeliveryChecksState; failing: DeliveryFailingCheck[] };
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
