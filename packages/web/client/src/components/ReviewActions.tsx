import { useState } from 'react';
import { serializeFeedback, type DiffComment } from '../diffComments.js';
import { I } from '../icons.js';

interface Props {
  onApprove: () => void;
  onRequestChanges: (feedback: string) => void;
  comments?: DiffComment[];
}

export function ReviewActions({ onApprove, onRequestChanges, comments = [] }: Props) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const handleRequestChanges = () => {
    const body = serializeFeedback(comments, feedback);
    if (!body) return; // nothing to send: no drafts and no free text
    onRequestChanges(body);
    setFeedback('');
    setShowFeedback(false);
  };

  return (
    <div className="af-d-tags" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="af-btn-primary" style={{ height: 30 }} onClick={onApprove}>
          {I.check({ width: 14, height: 14 })}Approve
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
