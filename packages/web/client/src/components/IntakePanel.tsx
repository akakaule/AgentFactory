import { useState } from 'react';
import type { TaskDetail, Activity } from '../types.js';
import { api } from '../api.js';
import { timeAgo } from '../time.js';

function pct(value: number): string { return `${Math.round(value * 100)}%`; }

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'warn' | undefined }) {
  return (
    <div className={'af-intake-stat' + (tone ? ' ' + tone : '')}>
      <span className="k">{label}</span>
      <span className="v">{value}</span>
      {sub && <span className="s">{sub}</span>}
    </div>
  );
}

export function IntakePanel({ task, onChanged }: { task: TaskDetail; onChanged?: () => void }) {
  const [history, setHistory] = useState<Activity[] | null>(null);
  const [ackReason, setAckReason] = useState('');
  const [reasonOpen, setReasonOpen] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);
  const intake = task.intake;
  if (!intake) return null;
  const a = intake.assessment;
  const attention = intake.policy?.eligibility === 'attention_required';
  const reasons = intake.policy?.reasons ?? [];
  return (
    <section className={'af-intake-panel' + (attention ? ' attention' : '')}>
      <div className="af-intake-head"><strong>Task Intelligence</strong><span>{a.provider.name} · {timeAgo(a.assessedAt)}</span></div>
      {intake.state === 'stale' && <div className="af-intake-muted">Task changed since assessment — reassessing…</div>}
      {a.status === 'unavailable' ? <div className="af-intake-muted">Assessment unavailable</div> : (
        <>
          <div className="af-intake-stats">
            <Stat label="Readiness" value={pct(a.decisions.readiness.probability)} tone={attention ? 'warn' : undefined} />
            <Stat label="Complexity" value={a.decisions.complexity.value} sub={pct(a.decisions.complexity.probabilities[a.decisions.complexity.value])} />
            <Stat label="Risk" value={a.decisions.risk.value} sub={pct(a.decisions.risk.probabilities[a.decisions.risk.value])} />
          </div>
          {reasons.length > 0 && (
            <ul className="af-intake-reasons">{reasons.map((r) => <li key={r.code}>{r.message}</li>)}</ul>
          )}
          <details className="af-intake-details">
            <summary>Readiness parts</summary>
            <div className="af-intake-parts">
              {Object.entries(a.decisions.readiness.parts).map(([key, value]) => (
                <div key={key} className="af-intake-part">
                  <span className="k">{key}</span>
                  <span className="bar"><i style={{ width: pct(value) }} /></span>
                  <span className="v">{pct(value)}</span>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
      <div className="af-intake-actions">
        <button className="af-intake-link" onClick={() => { if (history === null) void api.getIntakeHistory(task.key).then(setHistory); else setHistory(null); }}>
          {history === null ? 'Show assessment history' : 'Hide assessment history'}
        </button>
        {attention && intake.state === 'current' && !intake.overridden && (
          <div className="af-intake-ack">
            {reasonOpen && (
              <div className="af-intake-note">
                <label htmlFor="af-intake-note">Optional acknowledgment note</label>
                <textarea id="af-intake-note" rows={2} value={ackReason} onChange={(event) => setAckReason(event.target.value)} placeholder="Add context for this decision (optional)" />
              </div>
            )}
            <div className="af-intake-ack-actions">
              {reasonOpen ? (
                <button className="af-intake-link" onClick={() => { setAckReason(''); setReasonOpen(false); }}>Cancel note</button>
              ) : (
                <button className="af-intake-link" onClick={() => setReasonOpen(true)}>Add optional note</button>
              )}
              <button className="af-mini go" disabled={acknowledging} onClick={() => {
                setAcknowledging(true);
                void api.overrideIntake(task.key, a.sourceRevision, ackReason.trim() || undefined)
                  .then(() => onChanged?.())
                  .finally(() => setAcknowledging(false));
              }}>{acknowledging ? 'Acknowledging…' : 'Acknowledge and continue'}</button>
            </div>
          </div>
        )}
      </div>
      {history && <div className="af-intake-history">{history.map((entry) => <div key={entry.id}>{timeAgo(entry.createdAt)} · {entry.body.split('\n')[0]}</div>)}</div>}
    </section>
  );
}
