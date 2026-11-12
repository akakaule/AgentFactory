import { useState } from 'react';
import { api } from '../api.js';
import type { BlockSummary } from '../types.js';

const OTHER = '__other';

/**
 * Answer a blocked task. With an agent `decision/v1` question the options render as radios (the
 * recommended one preselected) plus "Something else"; without one it is a free-text answer. The
 * answer becomes binding feedback for the next session and the task goes back to the queue.
 */
export function AnswerForm({ taskKey, block, onDone }: { taskKey: string; block: BlockSummary | null | undefined; onDone: () => void }) {
  const decision = block?.decision ?? null;
  const [pick, setPick] = useState<string>(decision ? (decision.recommended ?? decision.options[0]!.id) : OTHER);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const other = pick === OTHER;
  const canSend = !busy && (!other || text.trim().length > 0);

  const send = async () => {
    setBusy(true); setError(null);
    try {
      await api.answerBlock(taskKey, { ...(other ? {} : { optionId: pick }), ...(text.trim() ? { answer: text.trim() } : {}) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="af-ny-answer">
      {decision && (
        <fieldset className="af-ny-options">
          <legend className="af-ny-sr">Choose an answer</legend>
          {decision.options.map((o) => (
            <label key={o.id} className={'af-ny-option' + (pick === o.id ? ' on' : '')}>
              <input type="radio" name={`answer-${taskKey}`} checked={pick === o.id} onChange={() => setPick(o.id)} />
              <span>
                <span className="af-ny-option-label">{o.label}{decision.recommended === o.id && <span className="af-ny-rec">Agent recommends</span>}</span>
                {o.detail && <span className="af-ny-option-detail">{o.detail}</span>}
              </span>
            </label>
          ))}
          <label className={'af-ny-option' + (other ? ' on' : '')}>
            <input type="radio" name={`answer-${taskKey}`} checked={other} onChange={() => setPick(OTHER)} />
            <span><span className="af-ny-option-label">Something else</span><span className="af-ny-option-detail">Write your own answer.</span></span>
          </label>
        </fieldset>
      )}
      <textarea
        className="af-ny-text"
        aria-label={other ? 'Your answer' : 'Add a note to your answer (optional)'}
        placeholder={other ? 'Your answer — the next session treats it as binding' : 'Add a note (optional)'}
        value={text}
        rows={2}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <div role="alert" className="af-ny-error">{error}</div>}
      <div className="af-ny-actions">
        <button className="af-btn-primary" disabled={!canSend} onClick={() => void send()}>Answer and put back in queue</button>
      </div>
    </div>
  );
}
