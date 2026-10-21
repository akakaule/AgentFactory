import { useState } from 'react';
import type { ReviewBrief } from '../types.js';
import { criterionLabel } from '../reviewText.js';
import { ReviewDialog } from './ReviewDialog.js';

interface Props {
  brief: ReviewBrief;
  /** "Approve anyway → deliver" / "→ implementation" — what approving does at this stage. */
  confirmLabel: string;
  onApprove: (reason: string) => Promise<unknown>;
  onClose: () => void;
}

/** Approving over must-fix issues or open decisions: which criteria stay unmet, what is still open,
 *  and the human's reason — core refuses the approve without one (spec §6.8). */
export function ReviewApprove({ brief, confirmLabel, onApprove, onClose }: Props) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const notMet = brief.criteria.filter((r) => r.status === 'not_met');
  const { must, call, should, fyi } = brief.counts;
  const open = [must ? `${must} must fix` : null, call ? `${call} your call` : null, should ? `${should} should fix` : null, fyi ? `${fyi} FYI` : null].filter(Boolean).join(' · ');

  const approve = () => {
    setBusy(true);
    setError(null);
    onApprove(reason.trim())
      .then(onClose)
      .catch((e: Error) => { setError(e.message); setBusy(false); });
  };

  return (
    <ReviewDialog
      variant="center"
      title="Approve with open issues?"
      subtitle="This overrides the AI review. The override and your reason go on the task's activity log."
      onClose={onClose}
      footer={<>
        <button type="button" className="af-mini" onClick={onClose}>Back to review</button>
        <button type="button" className="af-rv-override" disabled={busy || reason.trim() === ''} onClick={approve}>{confirmLabel}</button>
      </>}
    >
      {notMet.length > 0 && <p className="af-rv-unmet">{`Criteria not met: ${notMet.map(criterionLabel).join(', ')}`}</p>}
      {open && <p>{`Still open: ${open}`}</p>}
      <label className="af-rv-field">
        <span>Why is it OK to ship this? <span className="af-rv-muted">(required)</span></span>
        <textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="For example: AC6 moves to a follow-up task." />
      </label>
      {error && <p className="af-rv-error" role="alert">{error}</p>}
    </ReviewDialog>
  );
}
