import type { Activity, DeliveryCheck, DeliverySummary, EvidenceItem, EvidenceState, Verification } from './types.js';

/** The `verify:` attestation submitResult appends when a worker reports its verify outcome. */
const REPORTED_PREFIX = 'verify: ';

/** What the evidence list is derived from — all already on (or read next to) a task detail. */
export interface EvidenceSource {
  /** The current stage's latest submission; the identity runner and provider evidence must name. */
  submission: { id: number; headSha: string | null } | null;
  verifications: Verification[];
  activity: ReadonlyArray<Pick<Activity, 'type' | 'actor' | 'body' | 'createdAt'>>;
  delivery: DeliverySummary | null;
}

const CHECK_STATE: Record<DeliveryCheck['state'], EvidenceState> = { passing: 'passed', failing: 'failed', pending: 'unverified' };

/**
 * One list of everything that claims the task's work was verified, labelled by where it came from:
 * the runner's captured verify-command runs, the worker's own `verify:` reports (never proof), and
 * the git host's checks on the delivery. A run counts for its status only when it is bound to the
 * current submission and proves that revision; a failure bound to the current submission stays a
 * failure. Provider checks read stale once the delivery is for another submission or the PR head
 * moved off the approved one. Pure: no clocks, no ordering beyond submission identity.
 */
export function verificationEvidence(task: EvidenceSource): EvidenceItem[] {
  const current = task.submission;
  const runner = task.verifications.map((v): EvidenceItem => {
    const bound = current !== null && v.submissionId === current.id;
    const state: EvidenceState = bound && (v.validForRevision === true || v.status !== 'passed') ? v.status : 'stale';
    return {
      source: 'runner', state,
      headSha: v.headAfter ?? v.headBefore ?? (bound ? current.headSha : null),
      at: v.finishedAt, label: v.command,
    };
  });
  const reported = task.activity
    .filter((a) => a.type === 'comment' && a.actor === 'agent' && a.body.startsWith(REPORTED_PREFIX))
    .map((a): EvidenceItem => ({ source: 'reported', state: 'unverified', headSha: null, at: a.createdAt, label: a.body.slice(REPORTED_PREFIX.length).trim() }));
  return [...runner, ...reported, ...providerEvidence(task.delivery, current)];
}

function providerEvidence(d: DeliverySummary | null, current: EvidenceSource['submission']): EvidenceItem[] {
  if (!d) return [];
  const headSha = d.headSha ?? d.approvedHeadSha ?? null;
  const stale = (typeof d.submissionId === 'number' && current !== null && d.submissionId !== current.id)
    || (!!d.headSha && !!d.approvedHeadSha && d.headSha !== d.approvedHeadSha);
  const at = d.checkedAt ?? d.stateChangedAt;
  const item = (label: string, state: EvidenceState): EvidenceItem =>
    ({ source: 'provider', state: stale ? 'stale' : state, headSha, at, label });
  if (d.checks) return d.checks.map((c) => item(c.name, CHECK_STATE[c.state]));
  // a delivery recorded before per-check detail: its failing list, else the aggregate verdict
  if (d.checksState === 'failing') return d.failing.map((f) => item(f.name, 'failed'));
  if (d.checksState === 'passing') return [item('checks', 'passed')];
  return [];
}
