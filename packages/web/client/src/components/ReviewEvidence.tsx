import type { CriterionClaim, ReviewBrief, ReviewIssue, ReviewOpinion } from '../types.js';
import type { DiffFile, DiffHunk, ParsedDiff } from '../diff.js';
import { GROUP_LABEL, criterionLabel, opinionVerdict } from '../reviewText.js';
import { ReviewDialog } from './ReviewDialog.js';

interface Props {
  issue: ReviewIssue;
  brief: ReviewBrief;
  claims: CriterionClaim[] | null;
  names: Map<string, string>;
  /** The task's diff: undefined while loading, null when there is no branch or it failed. */
  diff: ParsedDiff | null | undefined;
  diffError: string | null;
  onClose: () => void;
  onOpenChanges: () => void;
}

/** The changed file a finding points at: an exact path, else the one file whose path ends with it. */
export function findDiffFile(diff: ParsedDiff, path: string): DiffFile | null {
  const norm = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  const exact = diff.files.find((f) => f.newPath === norm || f.oldPath === norm);
  if (exact) return exact;
  const suffix = diff.files.filter((f) => f.newPath.endsWith(`/${norm}`) || norm.endsWith(`/${f.newPath}`));
  return suffix.length === 1 ? suffix[0]! : null;
}

/** Hunks whose new-side range contains the line. */
export function hunksAt(file: DiffFile, line: number): DiffHunk[] {
  return file.hunks.filter((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLines, 1));
}

function Opinion({ opinion, name }: { opinion: ReviewOpinion; name: string }) {
  return (
    <div className="af-rv-opinion">
      <div className="who">{opinionVerdict(opinion, name)}</div>
      {opinion.reason && <p className="reason">{opinion.reason}</p>}
      <p className="evidence">{opinion.evidence}</p>
    </div>
  );
}

function Code({ issue, diff, diffError, onOpenChanges }: Pick<Props, 'issue' | 'diff' | 'diffError' | 'onOpenChanges'>) {
  if (!issue.file) return <p className="af-rv-muted">The reviewers didn't point at a file.</p>;
  if (diff === undefined) return <p className="af-rv-muted">Loading the diff…</p>;
  if (diff === null) return <p className="af-rv-muted">{diffError ?? 'No branch to show the code from.'}</p>;
  const file = findDiffFile(diff, issue.file);
  if (!file) return <p className="af-rv-muted">This file isn't changed on the branch.</p>;
  const hunks = issue.line !== null ? hunksAt(file, issue.line) : file.hunks.slice(0, 1);
  if (hunks.length === 0) {
    return (
      <p className="af-rv-muted">
        {`Line ${issue.line} isn't among the changed lines.`}{' '}
        <button type="button" className="af-rv-link" onClick={onOpenChanges}>Open the Changes tab</button>
      </p>
    );
  }
  return (
    <div className="af-rv-code">
      <div className="path">{file.newPath || file.oldPath}</div>
      {hunks.map((h, i) => (
        <div key={i} className="hunk">
          {h.lines.filter((l) => l.type !== 'meta').map((l, j) => (
            <div key={j} className={'af-rv-codeline ' + l.type + (issue.line !== null && l.newNo === issue.line ? ' hit' : '')}>
              <span className="ln">{l.newNo ?? ''}</span>
              <span className="code">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** Everything behind one issue (spec §6.6): the criteria it cites, the worker's claim for them,
 *  the code at the cited line, each reviewer's opinion in full, and the merged duplicates. */
export function ReviewEvidence({ issue, brief, claims, names, diff, diffError, onClose, onOpenChanges }: Props) {
  const rows = brief.criteria.filter((r) => issue.criteria?.includes(r.id));
  const name = (r: string) => names.get(r) ?? r;
  return (
    <ReviewDialog
      variant="side"
      title={issue.title}
      eyebrow={<><span className="mono">{issue.id}</span> · Evidence</>}
      subtitle={<span className={'af-rv-badge ' + issue.group}>{GROUP_LABEL[issue.group]}</span>}
      onClose={onClose}
      footer={<button type="button" className="af-mini" onClick={onOpenChanges}>Open in Changes</button>}
    >
      {rows.length > 0 && (
        <section aria-label="The criterion" className="af-rv-evsec">
          <h3>{rows.length === 1 ? 'The criterion' : 'The criteria'}</h3>
          {rows.map((r) => <p key={r.id} className="af-rv-crit"><strong>{criterionLabel(r)}</strong><br />{r.text}</p>)}
        </section>
      )}
      {rows.length > 0 && (
        <section aria-label="What the worker claimed" className="af-rv-evsec">
          <h3>What the worker claimed</h3>
          {rows.map((r) => {
            const claim = claims?.find((c) => c.id === r.id)?.claim;
            return <p key={r.id} className={claim ? '' : 'af-rv-muted'}>{claim ?? 'No claim recorded'}</p>;
          })}
        </section>
      )}
      <section aria-label="The code" className="af-rv-evsec">
        <h3>The code</h3>
        <Code issue={issue} diff={diff} diffError={diffError} onOpenChanges={onOpenChanges} />
        {brief.headSha && <span className="af-rv-muted">{`reviewed at ${brief.headSha.slice(0, 7)}`}</span>}
      </section>
      <section aria-label="What each reviewer found" className="af-rv-evsec">
        <h3>What each reviewer found</h3>
        {issue.opinions.length === 0
          ? <p>{issue.problem ?? issue.title}</p>
          : issue.opinions.map((o) => <Opinion key={o.reviewer} opinion={o} name={name(o.reviewer)} />)}
      </section>
      {issue.merged.length > 0 && (
        <section aria-label="Merged duplicates" className="af-rv-evsec">
          <h3>Merged duplicates</h3>
          {issue.merged.map((m) => (
            <details key={m.id} className="af-rv-merged">
              <summary><span className="mono">{m.id}</span> {`${m.title} · ${name(m.source)}`}</summary>
              {m.opinions.map((o) => <Opinion key={o.reviewer} opinion={o} name={name(o.reviewer)} />)}
            </details>
          ))}
        </section>
      )}
    </ReviewDialog>
  );
}
