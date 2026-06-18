import { useState } from 'react';
import type { FailureSummary, Activity } from '../types.js';
import { failureLabel } from './FailureChip.js';
import { shortTime } from '../time.js';
import { I } from '../icons.js';

/** The body of the latest `failure/v1` activity comment — it carries the captured log tail. */
function latestFailureBody(activity: Activity[]): string | null {
  for (let i = activity.length - 1; i >= 0; i--) {
    const a = activity[i]!;
    if (a.type === 'comment' && a.body.startsWith('failure/v1')) return a.body;
  }
  return null;
}

/**
 * Drawer banner for a task's current supervisor failure: the reason, one-line detail, attempt
 * count / skip-list state, and a one-click expander that reveals the captured log tail (read
 * from the latest failure/v1 comment) — so triage doesn't mean scrolling the activity log.
 */
export function FailureBanner({ failure, activity }: { failure: FailureSummary; activity: Activity[] }) {
  const [open, setOpen] = useState(false);
  const log = latestFailureBody(activity);
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
      {log && (
        <>
          <button className="af-fail-toggle" onClick={() => setOpen((v) => !v)}>
            {I.chev({})} {open ? 'Hide log' : 'Show log'}
          </button>
          {open && <pre className="af-fail-log">{log}</pre>}
        </>
      )}
    </div>
  );
}
