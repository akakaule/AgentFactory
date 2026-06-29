import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { shortTime } from '../time.js';

interface Props {
  taskKey: string;
  generatedAt: string | null;
  onClose: () => void;
}

/** The attached change-visualization in a modal — opened on demand from the drawer. Fetches the
 *  stored self-contained HTML and renders it in an isolated iframe: `sandbox="allow-scripts"` with
 *  NO `allow-same-origin` makes the frame an opaque origin, so Mermaid's CDN script runs but the
 *  page can't reach the parent DOM or same-origin cookies. Clones TranscriptModal/DiffModal's
 *  overlay + Escape + close mechanics. */
export function VisualizationModal({ taskKey, generatedAt, onClose }: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api.getVisualizationHtml(taskKey)
      .then((h) => { if (alive) setHtml(h); })
      .catch((e: Error) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [taskKey]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="af-overlay" onClick={onClose}>
      <div
        className="af-modal af-vizmodal"
        role="dialog"
        aria-modal="true"
        aria-label="Change visualization"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="af-vizmodal-head">
          <span className="ico" aria-hidden="true">📊</span>
          <span className="ref">Change visualization</span>
          {generatedAt && <span className="af-viz-when">generated {shortTime(generatedAt)}</span>}
          <button className="af-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="af-vizmodal-body">
          {error && <div className="af-viz-msg">Couldn't load visualization: {error}</div>}
          {!error && html == null && <div className="af-viz-msg">Loading…</div>}
          {html != null && (
            <iframe
              className="af-viz-frame"
              sandbox="allow-scripts"
              srcDoc={html}
              title="Change visualization"
            />
          )}
        </div>
      </div>
    </div>
  );
}
