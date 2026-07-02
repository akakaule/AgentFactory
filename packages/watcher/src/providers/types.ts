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
