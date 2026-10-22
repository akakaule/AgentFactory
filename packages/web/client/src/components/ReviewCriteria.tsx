import type { CriterionClaim, ReviewBrief, ReviewCriterionRow } from '../types.js';
import { ROW_STATUS_LABEL, clip } from '../reviewText.js';

/** One cell per criterion, coloured by status — on the board card and atop the criteria table.
 *  Status is never colour alone: the aria-label lists every criterion's status. */
export function CriteriaStrip({ rows }: { rows: ReviewCriterionRow[] }) {
  return (
    <span className="af-rv-strip" role="img" aria-label={`Criteria: ${rows.map((r) => `${r.id} ${ROW_STATUS_LABEL[r.status].toLowerCase()}`).join(', ')}`}>
      {rows.map((r) => <span key={r.id} className={'cell ' + r.status} />)}
    </span>
  );
}

/** "2 of 8 criteria not met", or null when every criterion is met. */
export function notMetCaption(rows: ReviewCriterionRow[]): string | null {
  const n = rows.filter((r) => r.status === 'not_met').length;
  return n > 0 ? `${n} of ${rows.length} criteria not met` : null;
}

interface Props {
  brief: ReviewBrief;
  claims: CriterionClaim[] | null;
  /** The expanded row, which also filters the issue list to it. */
  selected: string | null;
  onSelect: (id: string | null) => void;
}

/** The acceptance criteria next to the worker's claim and what the reviewers found (spec §6.4). */
export function ReviewCriteria({ brief, claims, selected, onSelect }: Props) {
  const claimOf = (id: string) => claims?.find((c) => c.id === id)?.claim ?? null;
  const titleOf = new Map(brief.issues.map((i) => [i.id, i.title]));
  const none = brief.unlinked > 0 ? 'No linked issues' : 'Nothing flagged';
  return (
    <section className="af-rv-criteria" aria-labelledby="af-rv-criteria-title">
      <div className="af-rv-sechead">
        <div>
          <h3 id="af-rv-criteria-title">Acceptance criteria</h3>
          <span className="sub">What the worker claims, next to what the reviewers found. Select a row to see its issues.</span>
        </div>
        <CriteriaStrip rows={brief.criteria} />
      </div>
      <div className="af-rv-rows">
        <div className="af-rv-row head" aria-hidden="true"><span>Status</span><span>Criterion</span><span>Worker says</span><span>Reviewers found</span></div>
        {brief.criteria.map((row) => {
          const open = selected === row.id;
          const claim = claimOf(row.id);
          return (
            <div key={row.id} className={'af-rv-rowwrap' + (open ? ' open' : '')}>
              <button
                type="button"
                className={'af-rv-row ' + row.status}
                aria-expanded={open}
                aria-label={`${row.name ? `${row.id} ${row.name}` : row.id}: ${ROW_STATUS_LABEL[row.status]}`}
                onClick={() => onSelect(open ? null : row.id)}
              >
                <span className="st"><span className="dot" />{ROW_STATUS_LABEL[row.status]}</span>
                <span className="cr"><span className="id">{row.id}</span><span className="nm">{row.name ?? clip(row.text, 80)}</span></span>
                <span className={'claim' + (claim ? '' : ' none')}>{claim ?? 'No claim'}</span>
                <span className="found">
                  {row.issueIds.length === 0
                    ? <span className="none">{none}</span>
                    : row.issueIds.map((id) => <span key={id} className="ref"><span className="id">{id}</span> {titleOf.get(id)}</span>)}
                </span>
              </button>
              {open && (
                <div className="af-rv-rowmore">
                  <p>{row.text}</p>
                  {claim && <p className="claim"><strong>Worker says:</strong> {claim}</p>}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {brief.generalCriteria && <p className="af-rv-general">{`Also required: ${brief.generalCriteria}`}</p>}
      {brief.unlinked > 0 && (
        <p className="af-rv-unlinked">{`${brief.unlinked} ${brief.unlinked === 1 ? 'issue isn\'t' : 'issues aren\'t'} linked to a criterion (this review predates criterion links)`}</p>
      )}
    </section>
  );
}
