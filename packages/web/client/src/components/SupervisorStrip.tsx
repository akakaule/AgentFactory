import { useSupervisors } from '../useSupervisors.js';
import { timeAgo } from '../time.js';
import { I } from '../icons.js';

/**
 * Health strip for the headless supervisors (dispatcher/reviewer). Answers "is the loop alive?"
 * at a glance: a green/red dot per supervisor with its in-flight/capacity and last-seen. A
 * supervisor that stops beating flips red on its own (derived server-side). Renders a hint when
 * none have ever reported — the common "you forgot to start the dispatcher" case.
 */
export function SupervisorStrip() {
  const supervisors = useSupervisors();
  if (supervisors.length === 0) {
    return (
      <div className="af-sup-strip empty">
        {I.info({})}
        <span>No supervisor has reported. Start the dispatcher (and reviewer) to run the loop.</span>
      </div>
    );
  }
  return (
    <div className="af-sup-strip">
      {supervisors.map((s) => (
        <div key={s.name} className={'af-sup' + (s.healthy ? '' : ' down')} title={
          `${s.name} (${s.kind}) — ${s.healthy ? 'healthy' : 'not seen in ' + s.staleSeconds + 's'}` +
          `\nworkspaces: ${s.workspaces.join(', ') || '—'}\npolls: ${s.polls}`
        }>
          <span className="af-sup-dot"></span>
          <span className="af-sup-name">{s.name}</span>
          <span className="af-sup-meta">
            {s.inFlight}/{s.capacity} busy
            {' · '}
            {s.healthy ? `seen ${timeAgo(s.lastSeenAt)}` : <span className="down">down · {s.staleSeconds}s</span>}
          </span>
        </div>
      ))}
    </div>
  );
}
