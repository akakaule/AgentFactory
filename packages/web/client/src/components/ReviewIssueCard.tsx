import type { ReviewCriterionRow, ReviewIssue } from '../types.js';
import type { ReviewDecision } from '../composeReviewFeedback.js';
import { GROUP_LABEL, clip, criterionLabel, joinNames, locationOf, opinionVerdict } from '../reviewText.js';
import { I } from '../icons.js';

interface Props {
  issue: ReviewIssue;
  /** The brief's criteria rows, to name the criteria the issue cites (empty at doc stages). */
  criteria: ReviewCriterionRow[];
  /** Full reviewer name → its display name. */
  names: Map<string, string>;
  decision: ReviewDecision | undefined;
  /** Read-only (a pending review): the decision control is disabled. */
  readOnly: boolean;
  onDecide: (d: ReviewDecision) => void;
  onEvidence: () => void;
  onCriterion: (id: string) => void;
}

const DECISIONS: Array<[ReviewDecision, string]> = [['must', 'Must fix'], ['should', 'Should fix'], ['dismiss', 'Dismiss']];

/** How the reviewers stand on the issue (spec §6.5 "Agreement"). */
function Agreement({ issue, names, onEvidence }: Pick<Props, 'issue' | 'names' | 'onEvidence'>) {
  const name = (r: string | null) => (r ? names.get(r) ?? r : 'the reviewer');
  if (issue.opinions.length === 0) return <div className="af-rv-agree">{`Reported by ${issue.source ?? 'the reviewer'}`}</div>;
  if (issue.dispute === 'unverified')
    return <div className="af-rv-agree">{`Raised late by ${name(issue.source)}; no reviewer has verified it yet.`}</div>;
  if (issue.dispute === null)
    return <div className="af-rv-agree">{I.check({})}{`${joinNames(issue.opinions.map((o) => name(o.reviewer)))} agree: ${GROUP_LABEL[issue.group].toLowerCase()}`}</div>;
  return (
    <div className="af-rv-sides">
      {issue.opinions.map((o) => (
        <div key={o.reviewer} className={'af-rv-side ' + o.decision}>
          <span className="who">{opinionVerdict(o, name(o.reviewer))}</span>
          {o.reason
            ? <p>{o.reason}</p>
            : <p>{clip(o.evidence, 240)} <button type="button" className="af-rv-link" onClick={onEvidence}>Evidence</button></p>}
        </div>
      ))}
    </div>
  );
}

/** One distinct issue: what is wrong, how to fix it, where the reviewers stand, and the human's decision. */
export function ReviewIssueCard({ issue, criteria, names, decision, readOnly, onDecide, onEvidence, onCriterion }: Props) {
  const loc = locationOf(issue);
  const rowOf = new Map(criteria.map((r) => [r.id, r]));
  const titleId = `af-rv-issue-${issue.id}`;
  return (
    <article className={'af-rv-issue ' + issue.group} data-issue={issue.id} aria-labelledby={titleId}>
      <div className="hd">
        <span className={'af-rv-badge ' + issue.group}>{GROUP_LABEL[issue.group]}</span>
        <h5 id={titleId}><span className="id">{issue.id}</span> {issue.title}</h5>
      </div>
      <div className="chips">
        {issue.criteria?.length === 0 && <span className="af-rv-chiplet outside">Outside the criteria</span>}
        {issue.criteria?.map((id) => (
          <button key={id} type="button" className="af-rv-chiplet" onClick={() => onCriterion(id)} disabled={!rowOf.has(id)}>
            {rowOf.get(id)?.name ? `${id} · ${rowOf.get(id)!.name}` : id}
          </button>
        ))}
        {loc && <button type="button" className="af-rv-chiplet loc" onClick={onEvidence}>{I.folder({ 'aria-hidden': true })}{loc}</button>}
        {issue.merged.length > 0 && (
          <span className="merged">{`Also raised as ${issue.merged.map((m) => `${m.id} (${names.get(m.source) ?? m.source})`).join(', ')}`}</span>
        )}
      </div>
      {(issue.problem || issue.fix) && (
        <dl className="pf">
          {issue.problem && <><dt>Problem</dt><dd>{issue.problem}</dd></>}
          {issue.fix && <><dt>Fix</dt><dd className="fix">{issue.fix}</dd></>}
        </dl>
      )}
      <Agreement issue={issue} names={names} onEvidence={onEvidence} />
      <div className="decide">
        <span className={'lbl' + (decision === undefined && !readOnly ? ' open' : '')}>{readOnly ? 'Read only: a newer result awaits review' : decision === undefined ? 'Your decision' : 'Send back as'}</span>
        <div role="radiogroup" aria-label={`Decision for ${issue.id}`} className="af-rv-seg">
          {DECISIONS.map(([value, label]) => (
            <label key={value} className={decision === value ? 'on ' + value : value}>
              <input type="radio" name={`af-rv-decision-${issue.id}`} value={value} checked={decision === value} disabled={readOnly} onChange={() => onDecide(value)} />
              {label}
            </label>
          ))}
        </div>
        <button type="button" className="af-rv-link more" onClick={onEvidence}>Evidence and code ›</button>
      </div>
    </article>
  );
}

/** The criterion chips' labels for an issue, for the evidence panel and dialogs. */
export function issueCriteriaLabel(issue: ReviewIssue, criteria: ReviewCriterionRow[]): string | null {
  if (!issue.criteria) return null;
  if (issue.criteria.length === 0) return 'Outside the criteria';
  const rows = new Map(criteria.map((r) => [r.id, r]));
  return issue.criteria.map((id) => (rows.has(id) ? criterionLabel(rows.get(id)!) : id)).join(', ');
}
