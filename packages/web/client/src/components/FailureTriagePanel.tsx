import { useId, useState } from 'react';
import type { FailureSummary, FailureTriageCategory, FailureTriageHistoryPage, FailureTriageSummary } from '../types.js';
import { api } from '../api.js';
import { timeAgo } from '../time.js';
import { FAILURE_TRIAGE_OPTIONS, failureTriageLabel } from '../failureTriageMeta.js';

interface CorrectionForm { sourceActivityId: number; shownCategory: FailureTriageCategory; category: FailureTriageCategory; note: string; }

function attribution(triage: FailureTriageSummary): string {
  const h = triage.human;
  if (h) return `${h.action === 'confirm' ? 'Human confirmed' : 'Human corrected'}${h.actorName ? ` · ${h.actorName}` : ''}`;
  if (triage.evidenceActivityId === null) return 'no usable log';
  return triage.rules.ruleId ? `rule ${triage.rules.ruleId}` : 'no rule matched';
}

/**
 * Advisory likely-cause label inside the failure banner (docs/spec/2026-09-25-failure-triage-design.md
 * §9). Fixed text only — the label, the local line that matched, and the fixed next-check suggestion.
 * Confirm/correct binds the exact failure event the form was opened for, so a newer failure arriving
 * mid-edit is never labeled by it.
 */
export function FailureTriagePanel({ taskKey, triage, failure, onChanged }: {
  taskKey: string; triage: FailureTriageSummary; failure: FailureSummary; onChanged?: (() => void) | undefined;
}) {
  const ids = useId();
  const [form, setForm] = useState<CorrectionForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<FailureTriageHistoryPage | null>(null);

  const borrowed = triage.evidenceActivityId !== null && triage.evidenceActivityId !== triage.sourceActivityId;
  const rulesDiffer = triage.human !== null && triage.rules.category !== triage.category;

  function send(input: { sourceActivityId: number; shownCategory: FailureTriageCategory; action: 'confirm' | 'correct'; category?: FailureTriageCategory; note?: string }) {
    setSaving(true);
    setError(null);
    void api.recordFailureTriageFeedback(taskKey, input)
      .then(() => { setForm(null); setHistory(null); onChanged?.(); })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSaving(false));
  }

  function loadHistory(beforeId?: number) {
    void api.getFailureTriageHistory(taskKey, beforeId)
      .then((page) => setHistory((prev) => (beforeId && prev ? { items: [...prev.items, ...page.items], nextBeforeId: page.nextBeforeId } : page)))
      .catch((e: Error) => setError(e.message));
  }

  return (
    <div className={'af-triage' + (triage.category === 'unknown' ? ' unclear' : '')} aria-label="Failure triage">
      <div className="af-triage-row">
        <span className="k">Likely cause</span>
        <strong>{triage.label}</strong>
        <span className="af-triage-by">{attribution(triage)}</span>
      </div>
      {rulesDiffer && (
        <div className="af-triage-row muted"><span className="k">Rules said</span><span className="v">{failureTriageLabel(triage.rules.category)}</span></div>
      )}
      {triage.rules.matchedLine && triage.rules.category !== 'unknown' && (
        <div className="af-triage-row"><span className="k">Matched</span><code className="af-triage-match">{triage.rules.matchedLine}</code></div>
      )}
      <div className="af-triage-row"><span className="k">Next check</span><span className="v">{triage.suggestion}</span></div>
      {borrowed && (
        <div className="af-triage-note">
          {failure.attempt !== null ? `Based on attempt ${failure.attempt}'s log` : "Based on the previous failure note's log"}
        </div>
      )}

      {form ? (
        <form className="af-triage-form" onSubmit={(e) => { e.preventDefault(); send({ sourceActivityId: form.sourceActivityId, shownCategory: form.shownCategory, action: 'correct', category: form.category, ...(form.note.trim() ? { note: form.note.trim() } : {}) }); }}>
          {form.sourceActivityId !== triage.sourceActivityId && (
            <div className="af-triage-note">A newer failure arrived — this correction applies to the earlier one.</div>
          )}
          <label htmlFor={`${ids}-cat`}>Category</label>
          <select id={`${ids}-cat`} autoFocus value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value as FailureTriageCategory })}>
            {FAILURE_TRIAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <label htmlFor={`${ids}-note`}>Optional note</label>
          <textarea id={`${ids}-note`} rows={2} maxLength={500} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="What was the actual cause? (optional)" />
          <div className="af-triage-actions">
            <button type="button" className="af-intake-link" onClick={() => { setForm(null); setError(null); }}>Cancel</button>
            <button type="submit" className="af-mini go" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </form>
      ) : (
        <div className="af-triage-actions">
          {triage.classifier === 'rules' && (
            <button className="af-intake-link" disabled={saving} onClick={() => send({ sourceActivityId: triage.sourceActivityId, shownCategory: triage.category, action: 'confirm' })}>
              {saving ? 'Saving…' : 'Confirm'}
            </button>
          )}
          <button className="af-intake-link" onClick={() => setForm({ sourceActivityId: triage.sourceActivityId, shownCategory: triage.category, category: triage.category, note: '' })}>
            {triage.human ? 'Change category' : 'Correct category'}
          </button>
          <button className="af-intake-link" onClick={() => (history ? setHistory(null) : loadHistory())}>
            {history ? 'Hide triage history' : 'Show triage history'}
          </button>
        </div>
      )}
      {error && <div className="af-triage-error" role="alert">{error}</div>}

      {history && (
        <ul className="af-triage-history">
          {history.items.map((item) => (
            <li key={item.sourceActivityId}>
              {timeAgo(item.at)} · {item.reason} · rules: {failureTriageLabel(item.rules.category)}
              {item.feedback.map((f) => (
                <span key={f.activityId} className="af-triage-feedback">
                  {' '}· {f.action === 'confirm' ? 'confirmed' : 'corrected to'} {failureTriageLabel(f.category)}{f.actorName ? ` by ${f.actorName}` : ''}{f.note ? ` — ${f.note}` : ''}
                </span>
              ))}
            </li>
          ))}
          {history.items.length === 0 && <li>No failure events.</li>}
          {history.nextBeforeId !== null && (
            <li><button className="af-intake-link" onClick={() => loadHistory(history.nextBeforeId!)}>Load older</button></li>
          )}
        </ul>
      )}
    </div>
  );
}
