import { useEffect, useState } from 'react';
import { useLiveAgents } from '../useLiveAgents.js';
import { timeAgo } from '../time.js';
import { elapsed, fmtTokens, ALIVE_MS } from '../liveFormat.js';

/** Per-task live panel in the drawer — current step, elapsed, last-seen, mini milestone feed. */
export function LiveSection({ taskKey }: { taskKey: string }) {
  const agents = useLiveAgents();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const a = agents.find((x) => x.key === taskKey);
  if (!a) return null; // no live session yet (or the agent just finished)
  const alive = now - new Date(a.heartbeatAt).getTime() < ALIVE_MS;

  return (
    <>
      <div className="af-sl">Live</div>
      <div className="af-livebox">
        <div className="af-livebox-head">
          <span className={'af-live-dot' + (alive ? ' alive' : '')}></span>
          <span className="ph">{a.phase ?? 'working…'}</span>
          <span className="el">{elapsed(a.startedAt, now)}</span>
        </div>
        {a.recent.length > 0 && (
          <ul className="af-livefeed">
            {a.recent.slice().reverse().map((m, i) => (
              <li key={i}><span className="t">{timeAgo(m.at)}</span> {m.msg}</li>
            ))}
          </ul>
        )}
        <div className="af-livebox-meta">
          {alive ? 'live' : `last seen ${timeAgo(a.heartbeatAt)}`}
          {(a.tokensIn != null || a.tokensOut != null) && <> · {fmtTokens(a.tokensIn)}↓ {fmtTokens(a.tokensOut)}↑ tokens</>}
        </div>
      </div>
    </>
  );
}
