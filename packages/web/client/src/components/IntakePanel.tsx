import { useState } from 'react';
import type { TaskDetail, Activity } from '../types.js';
import { api } from '../api.js';
import { timeAgo } from '../time.js';

function pct(value: number): string { return `${Math.round(value * 100)}%`; }

export function IntakePanel({ task, onChanged }: { task: TaskDetail; onChanged?: () => void }) {
  const [history, setHistory] = useState<Activity[] | null>(null);
  const intake = task.intake;
  if (!intake) return null;
  const a = intake.assessment;
  return (
    <section className={'af-intake-panel' + (intake.policy?.eligibility === 'attention_required' ? ' attention' : '')}>
      <div className="af-intake-head"><strong>Task Intelligence</strong><span>{a.provider.name} · {timeAgo(a.assessedAt)}</span></div>
      {intake.state === 'stale' && <div className="af-intake-muted">Task changed since assessment — reassessing…</div>}
      {a.status === 'unavailable' ? <div className="af-intake-muted">Assessment unavailable</div> : (
        <>
          <div className="af-intake-summary">Ready {pct(a.decisions.readiness.probability)} · {a.decisions.complexity.value} ({pct(a.decisions.complexity.probabilities[a.decisions.complexity.value])}) · {a.decisions.risk.value} risk ({pct(a.decisions.risk.probabilities[a.decisions.risk.value])})</div>
          <details>
            <summary>Readiness parts</summary>
            <div className="af-intake-parts">{Object.entries(a.decisions.readiness.parts).map(([key, value]) => <span key={key}>{key}: {pct(value)}</span>)}</div>
            {intake.policy?.reasons.map((r) => <div key={r.code} className="af-intake-reason">{r.message}</div>)}
          </details>
        </>
      )}
      {intake.policy?.eligibility === 'attention_required' && intake.state === 'current' && !intake.overridden && (
        <button className="af-btn-primary" onClick={() => {
          const reason = window.prompt('Optional acknowledgment reason:') ?? undefined;
          void api.overrideIntake(task.key, a.sourceRevision, reason).then(() => onChanged?.());
        }}>Acknowledge and continue</button>
      )}
      <button className="af-mini" onClick={() => { if (history === null) void api.getIntakeHistory(task.key).then(setHistory); else setHistory(null); }}>
        {history === null ? 'Show assessment history' : 'Hide assessment history'}
      </button>
      {history && <div className="af-intake-history">{history.map((entry) => <div key={entry.id}>{timeAgo(entry.createdAt)} · {entry.body.split('\n')[0]}</div>)}</div>}
    </section>
  );
}
