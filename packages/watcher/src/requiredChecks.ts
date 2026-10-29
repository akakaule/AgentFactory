import type { CiMode, DeliveryChecksState, DeliveryFailingCheck } from '@agentfactory/core';
import type { DeliveryCheckResult, ObservedCheck } from './providers/types.js';

export type RequiredCheckState = 'passed' | 'pending' | 'failed' | 'missing';
export interface RequiredChecksVerdict {
  checks: Record<string, RequiredCheckState>;
  verdict: 'failed' | 'waiting' | 'passed';
}

const RANK: Record<ObservedCheck['state'], number> = { passing: 0, pending: 1, failing: 2 };
const AS_REQUIRED: Record<ObservedCheck['state'], RequiredCheckState> = { passing: 'passed', pending: 'pending', failing: 'failed' };

/**
 * Judge a delivery on its required checks alone (workspace ciMode 'required'). A name the host
 * reported more than once counts by its worst report; a name it never reported is missing.
 * Any failed ⇒ 'failed'; else any pending or missing ⇒ 'waiting'; else 'passed'.
 */
export function evaluateRequiredChecks(required: readonly string[], observed: ReadonlyArray<Pick<ObservedCheck, 'name' | 'state'>>): RequiredChecksVerdict {
  const worst = new Map<string, ObservedCheck['state']>();
  for (const o of observed) {
    const prev = worst.get(o.name);
    if (prev === undefined || RANK[o.state] > RANK[prev]) worst.set(o.name, o.state);
  }
  const checks: Record<string, RequiredCheckState> = {};
  for (const name of required) {
    const state = worst.get(name);
    checks[name] = state === undefined ? 'missing' : AS_REQUIRED[state];
  }
  const states = Object.values(checks);
  const verdict = states.includes('failed') ? 'failed'
    : states.includes('pending') || states.includes('missing') ? 'waiting'
    : 'passed';
  return { checks, verdict };
}

export interface JudgedChecks {
  checks: { state: DeliveryChecksState; failing: DeliveryFailingCheck[] };
  /** The non-legacy mode the checks were judged under, recorded with the observation. */
  ciMode?: 'required' | 'none';
}

/**
 * Apply the workspace's ciMode to one provider poll. 'legacy' (or unset) keeps the provider's
 * any-red-check verdict. 'none' ignores CI: the checks read 'none' and never bounce. 'required'
 * lets only `requiredChecks` decide: a failed one fails (listed), a pending or missing one waits
 * (pending, the missing ones listed with `missing`), otherwise passing. Post-merge (merge-commit)
 * evidence is judged by name too, except that a required check the merge commit never reports does
 * not wait: it can't hold a done task pending forever, and the publication window keeps watching
 * for one that publishes late.
 */
export function judgeChecks(ciMode: CiMode | null, requiredChecks: readonly string[] | null, result: DeliveryCheckResult): JudgedChecks {
  if (ciMode === 'none') {
    return result.pr ? { checks: { state: 'none', failing: [] }, ciMode: 'none' } : { checks: result.checks };
  }
  if (ciMode !== 'required' || !result.pr || !result.observed) return { checks: result.checks };
  const postMerge = result.checksTarget === 'merge_commit';
  const { checks: all, verdict: raw } = evaluateRequiredChecks(requiredChecks ?? [], result.observed);
  const checks = postMerge ? Object.fromEntries(Object.entries(all).filter(([, s]) => s !== 'missing')) : all;
  const verdict = postMerge && raw === 'waiting' && !Object.values(checks).includes('pending') ? 'passed' : raw;
  if (postMerge && verdict === 'passed' && Object.keys(checks).length === 0) {
    return { checks: { state: 'none', failing: [] }, ciMode: 'required' };
  }
  if (verdict === 'failed') {
    const urls = new Map(result.observed.filter((o) => o.state === 'failing').map((o) => [o.name, o.url]));
    const failing = Object.entries(checks).filter(([, s]) => s === 'failed').map(([name]) => ({ name, url: urls.get(name) ?? null }));
    return { checks: { state: 'failing', failing }, ciMode: 'required' };
  }
  if (verdict === 'waiting') {
    const failing = Object.entries(checks).filter(([, s]) => s === 'missing').map(([name]) => ({ name, url: null, missing: true }));
    return { checks: { state: 'pending', failing }, ciMode: 'required' };
  }
  return { checks: { state: 'passing', failing: [] }, ciMode: 'required' };
}
