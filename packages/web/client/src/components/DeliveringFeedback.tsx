import { useState } from 'react';
import type { TaskDetail } from '../types.js';
import { api } from '../api.js';
import { latestFeedbackEval, feedbackEvalPending } from '../feedbackEval.js';

/** On a delivering task: forward a reviewer's PR comment for a CRITICAL evaluation, show the verdict,
 *  and (when warranted) one-click apply the fix — pulling the task back for a worker to implement. */
export function DeliveringFeedback({ task, onMutated }: { task: TaskDetail; onMutated: () => void }) {
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const verdict = latestFeedbackEval(task.activity);
  const pending = feedbackEvalPending(task.activity);

  const run = (fn: () => Promise<unknown>, clear = false) => {
    setBusy(true);
    setErr(null);
    fn().then(() => { if (clear) setFeedback(''); onMutated(); }).catch((e: Error) => setErr(e.message)).finally(() => setBusy(false));
  };

  return (
    <div style={{ marginTop: '10px', borderTop: '1px solid var(--line-soft)', paddingTop: '10px' }}>
      <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--ink-2)', marginBottom: '6px' }}>PR review feedback</div>
      <textarea
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        placeholder="Paste a reviewer's PR comment — an agent critically evaluates whether it warrants a fix…"
        rows={3}
        style={{ width: '100%', padding: '6px 10px', resize: 'vertical', fontFamily: 'inherit' }}
      />
      <div style={{ marginTop: '6px' }}>
        <button className="af-mini" disabled={busy || !feedback.trim()} onClick={() => run(() => api.addPrFeedback(task.key, { feedback: feedback.trim() }), true)}>
          Evaluate feedback
        </button>
      </div>

      {pending && !verdict && (
        <div style={{ fontSize: '12px', color: 'var(--ink-3)', marginTop: '6px' }}>
          Evaluating… the delivering evaluator will post a verdict shortly.
        </div>
      )}

      {verdict && (
        <div className="af-airev-list" style={{ marginTop: '8px' }}>
          <div className="hd">Evaluation: <strong style={{ marginLeft: '4px' }}>{verdict.disposition.replace('_', ' ')}</strong>{pending && <span style={{ marginLeft: '6px', color: 'var(--ink-3)' }}>· re-evaluating…</span>}</div>
          <div className="dt" style={{ padding: '4px' }}>{verdict.reasoning}</div>
          {verdict.suggestedChange && <div className="dt" style={{ padding: '4px' }}><strong>Suggested change:</strong> {verdict.suggestedChange}</div>}
          {(verdict.disposition === 'warranted' || verdict.disposition === 'partial') && (
            <div style={{ marginTop: '6px' }}>
              <button
                className="af-mini go"
                disabled={busy}
                onClick={() => run(() => api.applyFeedback(task.key))}
                title="Pull the task back so a worker fixes it on the same branch (updating the PR)."
              >
                Apply fix
              </button>
            </div>
          )}
        </div>
      )}

      {err && <div className="af-err" style={{ marginTop: '6px' }}>{err}</div>}
    </div>
  );
}
