import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { parseUnifiedDiff, type ParsedDiff } from '../diff.js';
import { DiffModal } from './DiffModal.js';
import { DiffView } from './DiffView.js';

interface Props {
  taskKey: string;
  branchLabel: string;
  updatedAt: string; // refetch key: SSE bumps it exactly when this task changes
  /** Expanded detail's Changes tab: render the diff in place instead of behind the modal. */
  inline?: boolean;
  /** Expanded detail's Overview: "View diff" switches to the Changes tab instead of opening the modal. */
  onViewDiff?: () => void;
  /** The current submission's recorded revision (AF-148): lets the view reproduce the submitted snapshot. */
  submitted?: { id: number; headSha: string | null } | null;
}

interface Loaded { branch: string; baseRef: string; parsed: ParsedDiff; commits: number; headSha: string | null; }

export function Changes({ taskKey, branchLabel, updatedAt, inline = false, onViewDiff, submitted = null }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [atSubmission, setAtSubmission] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setError(null);
    (atSubmission ? api.getDiff(taskKey, 'submission') : api.getDiff(taskKey))
      .then((d) => { if (alive) setLoaded({ branch: d.branch, baseRef: d.baseRef, parsed: parseUnifiedDiff(d.diff), commits: d.commits, headSha: d.headSha ?? null }); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [taskKey, branchLabel, updatedAt, atSubmission]);

  // the live branch head differs from what was submitted ⇒ offer the reviewed snapshot
  const moved = !atSubmission && submitted?.headSha != null && loaded?.headSha != null && loaded.headSha !== submitted.headSha;

  return (
    <>
      {!inline && <div className="af-sl">Changes</div>}
      {moved && (
        <div className="af-changes-row">
          <span className="af-diffstat">{`The branch moved since submission #${submitted!.id}.`}</span>
          <button className="af-mini" onClick={() => setAtSubmission(true)}>Show submitted revision</button>
        </div>
      )}
      {atSubmission && submitted && (
        <div className="af-changes-row">
          <span className="af-diffstat">{`Submission #${submitted.id} · commit ${submitted.headSha?.slice(0, 7) ?? 'unknown'}`}</span>
          <button className="af-mini" onClick={() => setAtSubmission(false)}>Show current branch</button>
        </div>
      )}
      {error && <div className="af-changes-err">{error}</div>}
      {!loaded && !error && <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>}
      {loaded && loaded.parsed.files.length === 0 && (
        <div className="af-diffstat">No changes vs {loaded.baseRef}</div>
      )}
      {loaded && loaded.parsed.files.length > 0 && (
        <div className="af-changes-row">
          <span className="af-diffstat">
            <span>{loaded.parsed.files.length} file{loaded.parsed.files.length === 1 ? '' : 's'}</span>
            <span className="a">+{loaded.parsed.adds}</span>
            <span className="d">−{loaded.parsed.dels}</span>
            <span>· {loaded.commits} commit{loaded.commits === 1 ? '' : 's'}</span>
          </span>
          {inline
            ? <span className="af-diffstat">{loaded.branch} vs {loaded.baseRef}</span>
            : <button className="af-mini" onClick={onViewDiff ?? (() => setOpen(true))}>View diff</button>}
        </div>
      )}
      {inline && loaded && loaded.parsed.files.length > 0 && <DiffView parsed={loaded.parsed} />}
      {open && loaded && (
        <DiffModal branch={loaded.branch} baseRef={loaded.baseRef} parsed={loaded.parsed} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
