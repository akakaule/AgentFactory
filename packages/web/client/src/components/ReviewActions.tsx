import { useState } from 'react';
import { I } from '../icons.js';

interface Props {
  onApprove: () => void;
  onRequestChanges: (feedback: string) => void;
  aiFindings?: number | undefined; // open findings in the latest AI review (drives break-glass)
}

export function ReviewActions({ onApprove, onRequestChanges, aiFindings }: Props) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);
  const [armed, setArmed] = useState(false);

  // Break-glass: a clean or absent AI review keeps Approve a single click. With open
  // findings, the first click arms a confirm and the approval is recorded as an override.
  const hasFindings = (aiFindings ?? 0) > 0;
  const handleApprove = () => {
    if (hasFindings && !armed) { setArmed(true); return; }
    onApprove();
  };

  const handleRequestChanges = () => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    onRequestChanges(trimmed);
    setFeedback('');
    setShowFeedback(false);
  };

  return (
    <div className="af-d-tags" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      {hasFindings && (
        <div className="af-airev-warn">
          {I.bot({})}
          <span>
            Latest AI review has <strong>{aiFindings} open finding{aiFindings === 1 ? '' : 's'}</strong>.
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
          {I.check({ width: 14, height: 14 })}{armed ? `Override — approve anyway (${aiFindings})` : 'Approve'}
        </button>
        {!showFeedback && (
          <button className="af-mini" onClick={() => setShowFeedback(true)}>
            Request changes
          </button>
        )}
      </div>
      {showFeedback && (
        <div className="af-cbox" style={{ marginTop: 0 }}>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe what needs to change…"
            rows={3}
          />
          <div className="row">
            <button className="af-mini danger" onClick={handleRequestChanges}>Submit feedback</button>
            <button className="af-mini" onClick={() => { setShowFeedback(false); setFeedback(''); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
