import { useEffect } from 'react';
import type { ParsedDiff } from '../diff.js';
import type { DiffCommentStore } from '../diffComments.js';
import { DiffView } from './DiffView.js';
import { I } from '../icons.js';

interface Props {
  branch: string;
  baseRef: string;
  parsed: ParsedDiff;
  onClose: () => void;
  commentStore?: DiffCommentStore | undefined;
}

export function DiffModal({ branch, baseRef, parsed, onClose, commentStore }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="af-overlay" onClick={onClose}>
      <div
        className="af-modal af-diffmodal"
        role="dialog"
        aria-modal="true"
        aria-label={`Changes on ${branch}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="af-diffmodal-head">
          {I.branch({})}
          <span className="ref">{branch}</span>
          <span className="vs">vs {baseRef}</span>
          <button className="af-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="af-diffmodal-body">
          <DiffView parsed={parsed} commentStore={commentStore} />
        </div>
      </div>
    </div>
  );
}
