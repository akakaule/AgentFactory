import { useEffect, useState } from 'react';
import type { FailureSummary, Activity, FailureTriageSummary } from '../types.js';
import { failureLabel } from './FailureChip.js';
import { FailureTriagePanel } from './FailureTriagePanel.js';
import { api } from '../api.js';
import { shortTime } from '../time.js';
import { I } from '../icons.js';

/** Fallback when there is no triage summary (done/archived tasks): the latest recent failure note. */
function latestFailureBody(activity: Activity[]): string | null {
  for (let i = activity.length - 1; i >= 0; i--) {
    const a = activity[i]!;
    if (a.type === 'comment' && a.body.startsWith('failure/v1')) return a.body;
  }
  return null;
}

/**
 * Drawer banner for a task's current supervisor failure: the reason, one-line detail, attempt
 * count / skip-list state, the advisory likely-cause label (failure triage), and a one-click
 * expander that reveals the captured log. With triage the log is read by exact activity id — the
 * note the label was based on — so it still works once the note has scrolled out of recent activity.
 */
export function FailureBanner({ taskKey, failure, activity, triage = null, onRestart, onChanged }: {
  taskKey: string; failure: FailureSummary; activity: Activity[]; triage?: FailureTriageSummary | null;
  onRestart?: () => void; onChanged?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [fetched, setFetched] = useState<{ id: number; body: string } | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const logSourceId = triage ? (triage.evidenceActivityId ?? triage.sourceActivityId) : null;
  const fallbackLog = triage ? null : latestFailureBody(activity);

  useEffect(() => {
    if (!open || logSourceId === null || fetched?.id === logSourceId) return;
    let alive = true;
    setLogError(null);
    api.getFailureTriageSource(taskKey, logSourceId)
      .then((a) => { if (alive) setFetched({ id: logSourceId, body: a.body }); })
      .catch((e: Error) => { if (alive) setLogError(e.message); });
    return () => { alive = false; };
  }, [open, logSourceId, taskKey, fetched?.id]);

  const log = logSourceId !== null ? (fetched?.id === logSourceId ? fetched.body : null) : fallbackLog;
  const hasLog = logSourceId !== null || fallbackLog !== null;
  const attempts = failure.attempt !== null && failure.maxAttempts !== null ? `attempt ${failure.attempt}/${failure.maxAttempts}` : null;
  return (
    <div className={'af-failbanner' + (failure.skipListed ? ' stuck' : '')}>
      <div className="af-failbanner-head">
        {I.info({})}
        <strong>{failureLabel(failure)}</strong>
        {failure.skipListed && <span className="af-fail-stuck">skip-listed · needs you</span>}
        <span className="af-failbanner-meta">
          {failure.source && <>{failure.source} · </>}{attempts && <>{attempts} · </>}{shortTime(failure.at)}
        </span>
      </div>
      {failure.detail && <div className="af-failbanner-detail">{failure.detail}</div>}
      {triage && <FailureTriagePanel taskKey={taskKey} triage={triage} failure={failure} onChanged={onChanged} />}
      {failure.skipListed && onRestart && (
        <button
          className="af-mini go af-fail-restart"
          onClick={onRestart}
          title={`Reset the attempt budget and retry — the ${failure.source === 'reviewer' ? 'reviewer' : 'dispatcher'} starts a fresh session. No supervisor restart needed.`}
        >
          Restart task
        </button>
      )}
      {hasLog && (
        <>
          <button className="af-fail-toggle" onClick={() => setOpen((v) => !v)}>
            {I.chev({})} {open ? 'Hide log' : 'Show source log'}
          </button>
          {open && (logError
            ? <div className="af-triage-error" role="alert">{logError}</div>
            : <pre className="af-fail-log">{log ?? 'Loading…'}</pre>)}
        </>
      )}
    </div>
  );
}
