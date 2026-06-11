import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { parseUnifiedDiff, type ParsedDiff } from '../diff.js';
import { DiffModal } from './DiffModal.js';

interface Props {
  taskKey: string;
  branchLabel: string;
  updatedAt: string; // refetch key: SSE bumps it exactly when this task changes
}

interface Loaded { branch: string; baseRef: string; parsed: ParsedDiff; }

export function Changes({ taskKey, branchLabel, updatedAt }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoaded(null);
    setError(null);
    api.getDiff(taskKey)
      .then((d) => { if (alive) setLoaded({ branch: d.branch, baseRef: d.baseRef, parsed: parseUnifiedDiff(d.diff) }); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [taskKey, branchLabel, updatedAt]);

  return (
    <>
      <div className="af-sl">Changes</div>
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
          </span>
          <button className="af-mini" onClick={() => setOpen(true)}>View diff</button>
        </div>
      )}
      {open && loaded && (
        <DiffModal branch={loaded.branch} baseRef={loaded.baseRef} parsed={loaded.parsed} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
