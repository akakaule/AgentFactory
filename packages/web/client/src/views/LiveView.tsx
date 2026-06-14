import { useEffect, useState } from 'react';
import { useLiveAgents } from '../useLiveAgents.js';
import { STAGE_LABELS, STAGE_COLORS } from '../status.js';
import { timeAgo } from '../time.js';
import { elapsed, fmtTokens, ALIVE_MS } from '../liveFormat.js';
import { I } from '../icons.js';

/** Fleet overview of every currently-running agent. Polls /api/agents; ticks elapsed each second. */
export function LiveView({ onOpen }: { onOpen: (key: string) => void }) {
  const agents = useLiveAgents();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (agents.length === 0) {
    return (
      <div className="af-live-empty">
        <div className="ico">{I.bot({})}</div>
        <h2>No agents running</h2>
        <p>Queue a task and start the dispatcher — running agents show up here live, with their current step.</p>
      </div>
    );
  }

  return (
    <div className="af-live">
      <div className="af-live-inner">
        {agents.map((a) => {
          const alive = now - new Date(a.heartbeatAt).getTime() < ALIVE_MS;
          return (
            <button key={a.key} className="af-live-row" onClick={() => onOpen(a.key)}>
              <span className={'af-live-dot' + (alive ? ' alive' : '')} title={alive ? 'alive' : 'quiet'}></span>
              <div className="af-live-main">
                <div className="af-live-top">
                  <span className="af-key">{a.key}</span>
                  <span className="af-wsbadge">{a.workspace}</span>
                  <span
                    className="af-pill"
                    style={{ color: STAGE_COLORS[a.stage], background: `color-mix(in srgb, ${STAGE_COLORS[a.stage]} 16%, transparent)` }}
                  >
                    <span className="d" style={{ background: STAGE_COLORS[a.stage] }}></span>{STAGE_LABELS[a.stage]}
                  </span>
                </div>
                <div className="af-live-title">{a.title}</div>
                <div className="af-live-phase">
                  {a.phase ? a.phase : 'working…'}
                  {a.phase && a.phaseAt && <span className="ago"> · {timeAgo(a.phaseAt)}</span>}
                </div>
              </div>
              <div className="af-live-meta">
                <span className="el">{elapsed(a.startedAt, now)}</span>
                <span className="seen">{alive ? 'live' : `seen ${timeAgo(a.heartbeatAt)}`}</span>
                {(a.tokensIn != null || a.tokensOut != null) && (
                  <span className="tok">{fmtTokens(a.tokensIn)}↓ {fmtTokens(a.tokensOut)}↑</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
