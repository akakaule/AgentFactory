import { useState } from 'react';

interface Props {
  onApprove: () => void;
  onRequestChanges: (feedback: string) => void;
}

export function ReviewActions({ onApprove, onRequestChanges }: Props) {
  const [feedback, setFeedback] = useState('');
  const [showFeedback, setShowFeedback] = useState(false);

  const handleRequestChanges = () => {
    const trimmed = feedback.trim();
    if (!trimmed) return;
    onRequestChanges(trimmed);
    setFeedback('');
    setShowFeedback(false);
  };

  return (
    <div style={{ marginTop: '16px', borderTop: '1px solid #e0e0e0', paddingTop: '12px' }}>
      <div style={{ display: 'flex', gap: '8px', marginBottom: showFeedback ? '8px' : '0' }}>
        <button
          onClick={onApprove}
          style={{ backgroundColor: '#46c878', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: '4px', cursor: 'pointer' }}
        >
          Approve
        </button>
        {!showFeedback && (
          <button
            onClick={() => setShowFeedback(true)}
            style={{ backgroundColor: '#e5534b', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: '4px', cursor: 'pointer' }}
          >
            Request changes
          </button>
        )}
      </div>
      {showFeedback && (
        <div>
          <textarea
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            placeholder="Describe what needs to change…"
            rows={3}
            style={{ width: '100%', boxSizing: 'border-box', padding: '8px', resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button
              onClick={handleRequestChanges}
              style={{ backgroundColor: '#e5534b', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: '4px', cursor: 'pointer' }}
            >
              Submit feedback
            </button>
            <button onClick={() => { setShowFeedback(false); setFeedback(''); }}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
