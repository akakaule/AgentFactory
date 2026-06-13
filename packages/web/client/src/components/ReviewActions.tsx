import { useEffect, useState } from 'react';
import type { AiReviewSummary, Stage } from '../types.js';
import { composeFeedback } from '../composeFeedback.js';
import { I } from '../icons.js';

interface Props {
  onApprove: () => void;
  onRequestChanges: (feedback: string) => void;
  aiReview?: AiReviewSummary | undefined; // latest AI-review verdict; drives the checklist + break-glass
  stage?: Stage | undefined; // approving a doc stage advances + re-queues — the label says so
}

// what the approve click actually does, per stage — doc stages advance, impl closes
const APPROVE_LABELS: Record<Stage, string> = {
  description: 'Approve → plan stage',
  plan: 'Approve → implementation',
  implementation: 'Approve',
};

export function ReviewActions({ onApprove, onRequestChanges, aiReview, stage }: Props) {
  const items = aiReview?.items ?? [];
  const reviewer = aiReview?.reviewer ?? null;
  const reviewPresent = items.length > 0;
  // Break-glass only over a CURRENT review with open findings; pending/clean approve in one click.
  const hasOpenFindings = aiReview?.verdict === 'findings';

  const [note, setNote] = useState('');
  const [composing, setComposing] = useState(false);
  const [armed, setArmed] = useState(false);
  const [unchecked, setUnchecked] = useState<Set<number>>(new Set());

  // Reset the selection (default: every finding checked) whenever the review's findings
  // change — a fresh review round replaces the checklist.
  const sig = items.map((f) => f.title).join('|');
  useEffect(() => { setUnchecked(new Set()); }, [sig]);

  const toggle = (i: number) => setUnchecked((prev) => {
    const next = new Set(prev);
    if (next.has(i)) next.delete(i); else next.add(i);
    return next;
  });

  const handleApprove = () => {
    if (hasOpenFindings && !armed) { setArmed(true); return; }
    onApprove();
  };

  // Compose ONE attributed body from the checked findings + the human's note, and post it
  // through the existing request-changes endpoint. Unchecked findings never ride along.
  const handleSend = () => {
    const selected = items.filter((_, i) => !unchecked.has(i));
    const body = composeFeedback(selected, reviewer, note, reviewPresent);
    if (!body.trim()) return;
    onRequestChanges(body);
    setNote('');
    setComposing(false);
  };

  const selectedCount = items.length - unchecked.size;

  return (
    <div className="af-d-tags" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      {reviewPresent && (
        <div className="af-airev-list">
          <div className="hd">
            {I.bot({})} AI review · {items.length} finding{items.length === 1 ? '' : 's'}{reviewer ? ` · ${reviewer}` : ''}
          </div>
          {items.map((f, i) => (
            <label key={i} className="it">
              <input type="checkbox" checked={!unchecked.has(i)} onChange={() => toggle(i)} />
              <span className="bd">
                <span className="ti">
                  {f.severity && <span className={'sev ' + f.severity} title={f.severity}></span>}
                  <span className="tx">{f.title}</span>
                  {f.file && <span className="loc">{f.file}{f.line != null ? `:${f.line}` : ''}</span>}
                </span>
                {f.detail && <span className="dt">{f.detail}</span>}
              </span>
            </label>
          ))}
        </div>
      )}

      {hasOpenFindings && (
        <div className="af-airev-warn">
          {I.bot({})}
          <span>
            Latest AI review has <strong>{aiReview!.findings} open finding{aiReview!.findings === 1 ? '' : 's'}</strong>.
            Approving is recorded as an override.
          </span>
        </div>
      )}

      <div style={{ display: 'flex', gap: '8px' }}>
        <button
          className={'af-btn-primary' + (armed ? ' armed' : '')}
          style={{ height: 30 }}
          onClick={handleApprove}
        >
          {I.check({ width: 14, height: 14 })}{armed ? `Override — approve anyway (${aiReview!.findings})` : APPROVE_LABELS[stage ?? 'implementation']}
        </button>
        {!composing && (
          <button className="af-mini" onClick={() => setComposing(true)}>
            Request changes
          </button>
        )}
      </div>

      {composing && (
        <div className="af-cbox" style={{ marginTop: 0 }}>
          {reviewPresent && (
            <div className="af-compose-hint">
              {selectedCount} of {items.length} finding{items.length === 1 ? '' : 's'} selected · add your own notes below
            </div>
          )}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={reviewPresent ? 'Add your own feedback (optional)…' : 'Describe what needs to change…'}
            rows={3}
          />
          <div className="row">
            <button className="af-mini danger" onClick={handleSend}>Send back</button>
            <button className="af-mini" onClick={() => { setComposing(false); setNote(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
