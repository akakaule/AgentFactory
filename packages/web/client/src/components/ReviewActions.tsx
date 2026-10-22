import { useEffect, useState } from 'react';
import type { AiReviewSummary } from '../types.js';
import { composePrReview } from '../composePrReview.js';
import { CopyButton } from './CopyButton.js';
import { I } from '../icons.js';
import { ConsensusDiscussion } from './ConsensusDiscussion.js';

interface Props {
  /** "Mark reviewed" captures the edited review body (so it can be posted to the PR) and closes the task. */
  onMarkReviewed: (review: string) => void;
  aiReview?: AiReviewSummary | undefined; // latest AI-review verdict; pre-fills the review body + drives the break-glass
}

/**
 * The review actions of a pr-review task (reviewing a teammate's PR; done = review given). Code
 * tasks use the ReviewPanel instead. There is no send-back: the real request-changes lives on the PR.
 */
export function ReviewActions({ onMarkReviewed, aiReview }: Props) {
  // The findings list shows only high-priority findings; the review body below starts from them.
  const items = (aiReview?.items ?? []).filter((f) => f.severity === 'error');
  const reviewer = aiReview?.reviewer ?? null;
  const reviewPresent = items.length > 0;
  // Break-glass only over a CURRENT review with open findings; pending/clean mark reviewed in one click.
  const hasOpenFindings = aiReview?.verdict === 'findings' || aiReview?.verdict === 'disputed';
  const disputes = aiReview?.consensus?.candidates.filter(c => c.outcome === 'disputed').length ?? 0;
  const openCount = (aiReview?.findings ?? 0) + disputes;

  const [note, setNote] = useState('');
  const [armed, setArmed] = useState(false);

  // A fresh review round re-fills the editable review body with the findings as markdown, so the
  // textarea shows exactly what gets copied onto the PR (WYSIWYG) and the human can edit it first.
  const sig = JSON.stringify([items, aiReview?.verdict, aiReview?.consensus]);
  useEffect(() => {
    setArmed(false);
    setNote(composePrReview(items, ''));
  }, [sig]);

  const handleMarkReviewed = () => {
    if (hasOpenFindings && !armed) { setArmed(true); return; }
    onMarkReviewed(note);
  };

  return (
    <div className="af-d-tags" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      {reviewPresent && (
        <div className="af-airev-list">
          <div className="hd">
            {I.bot({})} AI review · {items.length} high-priority finding{items.length === 1 ? '' : 's'}{reviewer ? ` · ${reviewer}` : ''}
          </div>
          {items.map((f, i) => (
            <div key={i} className="it">
              <span className="bd">
                <span className="ti">
                  {f.severity && <span className={'sev ' + f.severity} title={f.severity}></span>}
                  <span className="tx">{f.title}</span>
                  {f.file && <span className="loc">{f.file}{f.line != null ? `:${f.line}` : ''}</span>}
                </span>
                {f.detail && <span className="dt">{f.detail}</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {aiReview?.consensus && <ConsensusDiscussion consensus={aiReview.consensus} />}

      {hasOpenFindings && (
        <div className="af-airev-warn">
          {I.bot({})}
          <span>
            Latest AI review has <strong>{aiReview!.findings} open finding{aiReview!.findings === 1 ? '' : 's'}</strong>.
            {disputes > 0 && <> <strong>{disputes} unresolved dispute{disputes === 1 ? '' : 's'}</strong>.</>}
            {' '}Marking it reviewed is recorded as an override.
          </span>
        </div>
      )}

      {/* The textarea is the actual review body — pre-filled from the findings, editable, and what
          "Copy review for the PR" copies verbatim. "Mark reviewed" below independently closes. */}
      <div className="af-cbox" style={{ marginTop: 0 }}>
        <div className="af-compose-hint">
          {reviewPresent
            ? 'Pre-filled from the AI review — edit it, then copy and paste it onto the PR.'
            : 'Write your review, then copy and paste it onto the PR.'}
        </div>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Your review — paste this onto the PR…"
          rows={Math.min(14, Math.max(4, note.split('\n').length + 1))}
        />
        <div className="row">
          <CopyButton body={note.trim() ? note : ''} label="Copy review for the PR" />
        </div>
      </div>

      <div style={{ display: 'flex', gap: '8px' }}>
        <button className={'af-btn-primary' + (armed ? ' armed' : '')} style={{ height: 30 }} onClick={handleMarkReviewed}>
          {I.check({ width: 14, height: 14 })}{armed ? `Mark reviewed anyway (${openCount})` : 'Mark reviewed'}
        </button>
      </div>
    </div>
  );
}
