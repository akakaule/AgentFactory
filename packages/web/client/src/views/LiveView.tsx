import { useEffect, useState } from 'react';
import { useLiveAgents } from '../useLiveAgents.js';
import { SupervisorStrip } from '../components/SupervisorStrip.js';
import { api } from '../api.js';
import { STAGE_LABELS, STAGE_COLORS } from '../status.js';
import { timeAgo } from '../time.js';
import { elapsed, fmtTokens, ALIVE_MS } from '../liveFormat.js';
import { I } from '../icons.js';

/** Fleet overview of every currently-running agent. Polls /api/agents; ticks elapsed each second.
 *  Each row can leave the agent a steering note (delivered to the next claimant) or reassign the
 *  task — release the claim back to the queue so a fresh agent picks it up (useful when stalled). */
export function LiveView({ onOpen }: { onOpen: (key: string) => void }) {
  const agents = useLiveAgents();
  const [now, setNow] = useState(() => Date.now());
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [confirmReassign, setConfirmReassign] = useState<string | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Reassign abandons the current worker, so it's two-click armed to avoid killing a healthy run.
  const reassign = (key: string) => {
    if (confirmReassign !== key) { setConfirmReassign(key); return; }
    setConfirmReassign(null);
    api.setStatus(key, 'queued').catch(() => {});
  };
  const sendNote = (key: string) => {
    const body = noteText.trim();
    if (!body) return;
    api.addComment(key, body).catch(() => {});
    setNoteFor(null);
    setNoteText('');
  };

  return (
    <div className="af-live">
      <SupervisorStrip />
      {agents.length === 0 ? (
        <div className="af-live-empty">
          <div className="ico">{I.bot({})}</div>
          <h2>No agents running</h2>
          <p>Queue a task and start the dispatcher — running agents show up here live, with their current step.</p>
        </div>
      ) : (
      <div className="af-live-inner">
        {agents.map((a) => {
          const alive = now - new Date(a.heartbeatAt).getTime() < ALIVE_MS;
          return (
            <div key={a.key} className="af-live-row">
              <button className="af-live-open" onClick={() => onOpen(a.key)}>
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
              <div className="af-live-actions">
                <button
                  className="af-mini"
                  onClick={() => { setNoteFor(noteFor === a.key ? null : a.key); setNoteText(''); }}
                  title="Leave a steering note — delivered to the next agent that claims this task."
                >
                  Note
                </button>
                <button
                  className={'af-mini' + (confirmReassign === a.key ? ' armed' : '')}
                  onClick={() => reassign(a.key)}
                  title="Release the claim back to the queue so a fresh agent picks it up. History is preserved."
                >
                  {confirmReassign === a.key ? 'Confirm reassign?' : 'Reassign'}
                </button>
              </div>
              {noteFor === a.key && (
                <div className="af-live-note">
                  <textarea
                    value={noteText}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Note for the next agent to claim this task…"
                    rows={2}
                    autoFocus
                  />
                  <div className="af-live-note-actions">
                    <button className="af-mini" onClick={() => setNoteFor(null)}>Cancel</button>
                    <button className="af-mini go" onClick={() => sendNote(a.key)} disabled={!noteText.trim()}>Send note</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
}
