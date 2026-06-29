import { useState } from 'react';
import { VisualizationModal } from './VisualizationModal.js';

/** Drawer entry for the attached change visualization — a compact button that opens the modal,
 *  mirroring TranscriptSection. Renders only when the task has one (TaskDetail.hasVisualization),
 *  so tasks without a visualization show nothing. */
export function VisualizationSection({ taskKey, present, generatedAt }: { taskKey: string; present: boolean; generatedAt: string | null }) {
  const [open, setOpen] = useState(false);
  if (!present) return null;
  return (
    <>
      <div className="af-sl">Change visualization</div>
      <div className="af-tx-row">
        <button className="af-mini" onClick={() => setOpen(true)}>View visualization</button>
      </div>
      {open && <VisualizationModal taskKey={taskKey} generatedAt={generatedAt} onClose={() => setOpen(false)} />}
    </>
  );
}
