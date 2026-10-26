import { useEffect, useMemo, useState } from 'react';
import type { ReviewBrief, ReviewGroup, Stage, TaskDetailView } from '../types.js';
import { api } from '../api.js';
import { parseUnifiedDiff, type ParsedDiff } from '../diff.js';
import { defaultDecisions, selectedIssues, type ReviewDecisions } from '../composeReviewFeedback.js';
import { GROUP_LABEL, HEADLINE_TITLE, reviewSentence, shortNames } from '../reviewText.js';
import { ReviewCriteria } from './ReviewCriteria.js';
import { ReviewIssueCard } from './ReviewIssueCard.js';
import { ReviewEvidence } from './ReviewEvidence.js';
import { ReviewSendBack } from './ReviewSendBack.js';
import { ReviewApprove } from './ReviewApprove.js';
import { ConsensusDiscussion } from './ConsensusDiscussion.js';
import { I } from '../icons.js';

interface Props {
  task: TaskDetailView;
  /** Approve routes to delivering (an implementation code task on a git-host branch). */
  willDeliver: boolean;
  /** Resolves when approved; rejects with the server's message (shown in the approve dialog). */
  onApprove: (reason?: string) => Promise<unknown>;
  onRequestChanges: (body: string) => Promise<unknown>;
  /** Switch the drawer to its Changes tab. */
  onOpenChanges: () => void;
}

const GROUPS: ReviewGroup[] = ['must', 'call', 'should', 'fyi'];
const GROUP_SUB: Record<ReviewGroup, string> = {
  must: 'The reviewers agree these block approval.',
  call: 'The reviewers don\'t agree on these, so you decide.',
  should: 'Worth fixing, not blocking.',
  fyi: 'Worth knowing, not blocking.',
};

type Filter = { kind: 'group'; group: ReviewGroup } | { kind: 'criterion'; id: string } | null;
type Overlay = { kind: 'evidence'; issueId: string } | { kind: 'sendback' } | { kind: 'approve' } | null;

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'unknown');

/** Which revision is under review, and whether it is still what is there (AF-148). Core refuses a
 *  stale implementation approval; the panel says so up front instead of failing on click. */
function revisionLines(task: TaskDetailView): { line: string | null; stale: string | null; unknown: string | null; review: string | null } {
  const sub = task.submission ?? null;
  if (!sub) return { line: null, stale: null, unknown: null, review: null };
  const seen = sub.lastObservation;
  const binding = task.aiReview?.binding;
  return {
    line: sub.headSha ? `Submission #${sub.id} · commit ${short(sub.headSha)}` : `Submission #${sub.id}`,
    stale: sub.stage === 'implementation' && sub.freshness === 'stale'
      ? `The branch moved to ${short(seen?.headSha)} after this submission. Approval is blocked until the new revision is submitted and reviewed — request changes.`
      : sub.freshness === 'stale' ? 'The deliverable was edited after this submission.' : null,
    unknown: sub.stage === 'implementation' && sub.freshness === 'unknown'
      ? `Revision freshness unknown: ${seen?.error ?? 'no commit was recorded at submit'}. Approving records that.`
      : null,
    review: binding === 'stale' || binding === 'superseded' ? 'This AI review is for an older revision.'
      : binding === 'unverified' ? 'This AI review cannot be matched to the submitted commit: none was recorded at submit.'
      : binding === 'legacy' ? 'This AI review names no revision (recorded before revisions were tracked).' : null,
  };
}

function approveLabel(stage: Stage, willDeliver: boolean): string {
  if (stage !== 'implementation') return 'Approve → implementation';
  return willDeliver ? 'Approve → deliver' : 'Approve';
}

/** A review's identity: a new review (or a newer result) resets the human's decisions — also one
 *  that reuses the same issue ids, so a decision never carries over to a different finding. */
const signatureOf = (brief: ReviewBrief | null) =>
  brief ? JSON.stringify([brief.headline, brief.headSha, brief.issues.map((i) => [i.id, i.group, i.title, i.source, i.problem])]) : 'none';

/**
 * The human review gate for a code task (docs/spec/2026-10-21-review-decision-panel-design.md §6):
 * a verdict card, the criteria next to the worker's claims, each distinct issue with a decision, and
 * the dialogs that send the decided issues back or approve over them with a reason.
 */
export function ReviewPanel({ task, willDeliver, onApprove, onRequestChanges, onOpenChanges }: Props) {
  const brief = task.reviewBrief ?? null;
  const signature = signatureOf(brief);
  const [decisions, setDecisions] = useState<ReviewDecisions>(() => defaultDecisions(brief));
  const [filter, setFilter] = useState<Filter>(null);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [diff, setDiff] = useState<{ key: string; parsed: ParsedDiff | null; error: string | null } | null>(null);
  const [approveError, setApproveError] = useState<string | null>(null);

  useEffect(() => { setDecisions(defaultDecisions(brief)); setFilter(null); }, [signature]);

  // The evidence panel reads the task's existing diff — fetched on first use, again when the task changes.
  const branchLink = task.links.some((l) => l.kind === 'branch');
  const evidenceOpen = overlay?.kind === 'evidence';
  useEffect(() => {
    if (!evidenceOpen || diff?.key === task.updatedAt) return;
    if (!branchLink) { setDiff({ key: task.updatedAt, parsed: null, error: 'No branch to show the code from.' }); return; }
    let alive = true;
    api.getDiff(task.key)
      .then((d) => { if (alive) setDiff({ key: task.updatedAt, parsed: parseUnifiedDiff(d.diff), error: null }); })
      .catch((e: Error) => { if (alive) setDiff({ key: task.updatedAt, parsed: null, error: e.message }); });
    return () => { alive = false; };
  }, [evidenceOpen, task.key, task.updatedAt, branchLink, diff?.key]);

  const names = useMemo(() => shortNames(brief?.reviewers ?? []), [brief?.reviewers]);
  const readOnly = brief?.headline === 'pending';
  const sendCount = selectedIssues(brief, decisions).length;
  const undecidedCalls = (brief?.issues ?? []).filter((i) => i.group === 'call' && decisions[i.id] === undefined).length;
  const blocking = brief?.headline === 'changes_needed' || brief?.headline === 'your_call';
  const label = approveLabel(task.stage, willDeliver);
  const revision = revisionLines(task);
  const approveBlocked = task.stage === 'implementation' && task.submission?.freshness === 'stale';

  const approveNow = () => {
    setApproveError(null);
    onApprove(undefined).catch((e: Error) => setApproveError(e.message));
  };
  const visible = (brief?.issues ?? []).filter((i) =>
    filter === null ? true : filter.kind === 'group' ? i.group === filter.group : i.criteria?.includes(filter.id) ?? false);
  const evidenceIssue = overlay?.kind === 'evidence' ? brief?.issues.find((i) => i.id === overlay.issueId) ?? null : null;

  const requestButton = (
    <button type="button" className={blocking ? 'af-btn-primary' : 'af-mini'} onClick={() => setOverlay({ kind: 'sendback' })}>
      {brief ? `Request changes (${sendCount})` : 'Request changes'}
    </button>
  );
  const approveButton = blocking
    ? <button type="button" className="af-mini" disabled={approveBlocked} onClick={() => setOverlay({ kind: 'approve' })}>Approve anyway…</button>
    : <button type="button" className="af-btn-primary" disabled={approveBlocked} onClick={approveNow}>{I.check({ width: 14, height: 14 })}{label}</button>;

  return (
    <div className="af-rv">
      <section className={'af-rv-verdict ' + (brief?.headline ?? 'none')} aria-labelledby="af-rv-verdict-title">
        <div className="top">
          <span className="ic" aria-hidden="true">{I.bot({})}</span>
          <div className="tx">
            <span className="eyebrow">AI review</span>
            <h3 id="af-rv-verdict-title">{brief ? HEADLINE_TITLE[brief.headline] : 'No AI review yet'}</h3>
          </div>
        </div>
        {brief && <p className="sentence">{reviewSentence(brief)}</p>}
        {brief && brief.issues.length > 0 && (
          <div className="pills" role="group" aria-label="Filter issues by group">
            {GROUPS.filter((g) => brief.counts[g] > 0).map((g) => {
              const on = filter?.kind === 'group' && filter.group === g;
              return (
                <button key={g} type="button" className={'af-rv-pill ' + g} aria-pressed={on} aria-label={`${GROUP_LABEL[g]} · ${brief.counts[g]}`}
                  onClick={() => setFilter(on ? null : { kind: 'group', group: g })}>
                  <span className="n">{brief.counts[g]}</span><span>{GROUP_LABEL[g]}</span>
                </button>
              );
            })}
          </div>
        )}
        {brief && (
          <div className="meta" title={brief.reviewers.join(' + ')}>
            {[
              brief.counts.merged ? `${brief.counts.merged} duplicate${brief.counts.merged === 1 ? '' : 's'} merged` : null,
              brief.counts.rejected === 0 && brief.reviewers.length > 1 ? '0 rejected' : null,
              brief.headSha ? `commit ${brief.headSha.slice(0, 7)}` : null,
              brief.reviewers.length ? [...names.values()].join(' + ') : null,
            ].filter(Boolean).join(' · ')}
            {brief.counts.rejected > 0 && (
              <details className="af-rv-rejected">
                <summary>{`${brief.counts.rejected} rejected`}</summary>
                <ul>{brief.rejected.map((r) => <li key={r.id}>{`${r.id} ${r.title} · raised by ${names.get(r.source) ?? r.source}`}</li>)}</ul>
              </details>
            )}
          </div>
        )}
        {revision.line && (
          <p className="af-rv-revision">
            {revision.line}
            {revision.review && <span className="af-rv-muted">{` · ${revision.review}`}</span>}
          </p>
        )}
        {revision.unknown && <p className="af-rv-revision unknown">{revision.unknown}</p>}
        {revision.stale && <p className="af-rv-error" role="alert">{revision.stale}</p>}
        <div className="actions">
          {blocking ? <>{requestButton}{approveButton}</> : <>{approveButton}{requestButton}</>}
          {!readOnly && undecidedCalls > 0 && <span className="hint">{`${undecidedCalls} ${undecidedCalls === 1 ? 'issue needs' : 'issues need'} your decision`}</span>}
        </div>
        {approveError && <p className="af-rv-error" role="alert">{approveError}</p>}
      </section>

      {brief && brief.criteria.length > 0 && (
        <ReviewCriteria brief={brief} claims={task.criteriaClaims ?? null}
          selected={filter?.kind === 'criterion' ? filter.id : null}
          onSelect={(id) => setFilter(id ? { kind: 'criterion', id } : null)} />
      )}

      {brief && brief.issues.length > 0 && (
        <section className="af-rv-issues" aria-label="Issues">
          {filter && (
            <div className="af-rv-filter">
              <span>{filter.kind === 'group' ? `Showing ${GROUP_LABEL[filter.group]} only` : `Showing the issues linked to ${filter.id}`}</span>
              <button type="button" className="af-mini" onClick={() => setFilter(null)}>{`Show all ${brief.issues.length}`}</button>
            </div>
          )}
          {GROUPS.map((g) => {
            const items = visible.filter((i) => i.group === g);
            if (items.length === 0) return null;
            return (
              <div key={g} className="af-rv-group">
                <div className="ghd">
                  <h4 className={g}>{`${GROUP_LABEL[g]} · ${items.length}`}</h4>
                  <span className="sub">{GROUP_SUB[g]}</span>
                </div>
                {items.map((issue) => (
                  <ReviewIssueCard key={issue.id} issue={issue} criteria={brief.criteria} names={names}
                    decision={decisions[issue.id]} readOnly={readOnly}
                    onDecide={(d) => setDecisions((prev) => ({ ...prev, [issue.id]: d }))}
                    onEvidence={() => setOverlay({ kind: 'evidence', issueId: issue.id })}
                    onCriterion={(id) => setFilter({ kind: 'criterion', id })} />
                ))}
              </div>
            );
          })}
        </section>
      )}

      {task.aiReview?.consensus && <ConsensusDiscussion consensus={task.aiReview.consensus} />}

      {evidenceIssue && brief && (
        <ReviewEvidence issue={evidenceIssue} brief={brief} claims={task.criteriaClaims ?? null} names={names}
          diff={diff?.key === task.updatedAt ? diff.parsed : undefined} diffError={diff?.error ?? null}
          onClose={() => setOverlay(null)} onOpenChanges={() => { setOverlay(null); onOpenChanges(); }} />
      )}
      {overlay?.kind === 'sendback' && (
        <ReviewSendBack brief={brief} decisions={readOnly ? {} : decisions} onSend={onRequestChanges} onClose={() => setOverlay(null)} />
      )}
      {overlay?.kind === 'approve' && brief && (
        <ReviewApprove brief={brief} confirmLabel={label.replace('Approve', 'Approve anyway')} onApprove={(reason) => onApprove(reason)} onClose={() => setOverlay(null)} />
      )}
    </div>
  );
}
