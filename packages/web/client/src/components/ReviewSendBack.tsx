import { useState } from 'react';
import type { ReviewBrief } from '../types.js';
import { composeReviewFeedback, selectedIssues, type ReviewDecisions } from '../composeReviewFeedback.js';
import { locationOf } from '../reviewText.js';
import { ReviewDialog } from './ReviewDialog.js';

interface Props {
  brief: ReviewBrief | null;
  decisions: ReviewDecisions;
  onSend: (body: string) => Promise<unknown>;
  onClose: () => void;
}

/** "Request changes": exactly what the agent will get, what is left out and why, and a note (spec §6.7). */
export function ReviewSendBack({ brief, decisions, onSend, onClose }: Props) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const selected = selectedIssues(brief, decisions);
  const notSent = (brief?.issues ?? []).filter((i) => decisions[i.id] === undefined || decisions[i.id] === 'dismiss');
  const n = selected.length;
  const disabled = sending || (n === 0 && note.trim() === '');
  // the one body both the preview and the send use, so what the human reads is what the agent gets
  const body = composeReviewFeedback(brief, decisions, note);

  const send = () => {
    setSending(true);
    setError(null);
    onSend(body)
      .then(onClose)
      .catch((e: Error) => { setError(e.message); setSending(false); });
  };

  return (
    <ReviewDialog
      variant="center"
      title="Send back to the agent"
      subtitle={brief ? 'The agent gets exactly this list, each item with the reviewers\' problem, location and fix. Nothing else from the review reaches it.' : 'The agent gets your note.'}
      onClose={onClose}
      footer={<>
        <span className="af-rv-muted grow">The task goes back to Queued with this feedback.</span>
        <button type="button" className="af-mini" onClick={onClose}>Cancel</button>
        <button type="button" className="af-btn-primary" disabled={disabled} onClick={send}>
          {n === 0 ? 'Send note' : `Send back ${n} ${n === 1 ? 'issue' : 'issues'}`}
        </button>
      </>}
    >
      {(['must', 'should'] as const).map((as) => {
        const items = selected.filter((s) => s.as === as);
        if (items.length === 0) return null;
        return (
          <div key={as} className="af-rv-sbgroup">
            <span className={'af-rv-sbtitle ' + as}>{`${as === 'must' ? 'Must fix' : 'Should fix'} · ${items.length}`}</span>
            <ol>
              {items.map(({ issue }) => (
                <li key={issue.id}>
                  <span className="mono id">{issue.id}</span>
                  <div>
                    <span className="ti">{issue.title}</span>
                    <span className="mono meta">{[...(issue.criteria ?? []), locationOf(issue)].filter(Boolean).join(' · ')}</span>
                    {issue.fix && <span className="fix"><strong>Fix:</strong> {issue.fix}</span>}
                  </div>
                </li>
              ))}
            </ol>
          </div>
        );
      })}
      {notSent.length > 0 && (
        <div className="af-rv-notsent">
          <strong>Not sent</strong>
          {notSent.map((i) => <span key={i.id}>{`${i.id} ${i.title} · ${decisions[i.id] === 'dismiss' ? 'dismissed' : 'not decided'}`}</span>)}
        </div>
      )}
      <label className="af-rv-field">
        <span>Your note to the agent <span className="af-rv-muted">(optional)</span></span>
        <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything else the agent should know?" />
      </label>
      {body && (
        <details className="af-rv-exact">
          <summary>Show the exact message</summary>
          <pre>{body}</pre>
        </details>
      )}
      {error && <p className="af-rv-error" role="alert">{error}</p>}
    </ReviewDialog>
  );
}
