import { useState } from 'react';
import type { Status } from '../types.js';
import { useTranscript } from '../useTranscript.js';
import { TranscriptModal, TranscriptMeta, TranscriptBlocks } from './TranscriptModal.js';

/** Per-task agent transcript — a compact, de-emphasized summary in the drawer (engine · N blocks ·
 *  size · live/final); the full block list opens in a modal on demand (mirrors Changes → DiffModal).
 *  Self-hides on state 'none' so legacy / doc-stage tasks (no capture) show nothing. The summary
 *  count stays live via useTranscript's poll while the task is in_progress. */
export function TranscriptSection({ taskKey, status, inline = false }: { taskKey: string; status: Status; inline?: boolean }) {
  const { state, blocks, bytes, engine } = useTranscript(taskKey, status);
  const [open, setOpen] = useState(false);

  // Expanded detail's Logs tab: the block list in place, with an explicit empty state
  if (inline) {
    if (state === 'none') return <div className="af-dt-empty">No transcript captured for this task.</div>;
    return (
      <>
        <div className="af-tx-row"><TranscriptMeta engine={engine} count={blocks.length} bytes={bytes} state={state} /></div>
        <TranscriptBlocks blocks={blocks} />
      </>
    );
  }

  if (state === 'none') return null;

  return (
    <>
      <div className="af-sl">Transcript</div>
      <div className="af-tx-row">
        <TranscriptMeta engine={engine} count={blocks.length} bytes={bytes} state={state} />
        {blocks.length > 0 && (
          <button className="af-mini" onClick={() => setOpen(true)}>View transcript</button>
        )}
      </div>
      {open && (
        <TranscriptModal blocks={blocks} bytes={bytes} engine={engine} state={state} onClose={() => setOpen(false)} />
      )}
    </>
  );
}
