import { useEffect, useRef, useState } from 'react';
import type { Workspace } from '../types.js';
import { wsColor } from '../wsColor.js';
import { I } from '../icons.js';

interface Props {
  workspaces: Workspace[];
  value: string; // workspace slug or 'all'
  counts: Record<string, number>; // per slug + 'all'
  onChange: (value: string) => void;
  onNewWorkspace: () => void;
}

export function WorkspaceSwitcher({ workspaces, value, counts, onChange, onNewWorkspace }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const cur = value === 'all' ? null : workspaces.find((w) => w.name === value);

  return (
    <div className="af-ws" ref={ref}>
      <button className="af-ws-btn" aria-label="Workspace filter" onClick={() => setOpen((o) => !o)}>
        <span className="af-ws-dot" style={{ background: cur ? wsColor(workspaces, cur.name) : 'var(--ink-3)' }}></span>
        <span className="af-ws-name">{cur ? cur.name : 'All workspaces'}</span>
        {cur && <span className="af-ws-repo">{cur.repoPath}</span>}
        {I.chev({ width: 14, height: 14, style: { color: 'var(--ink-3)' } })}
      </button>
      {open && (
        <div className="af-ws-menu" role="menu">
          <button
            className={'af-ws-opt' + (value === 'all' ? ' on' : '')}
            onClick={() => { onChange('all'); setOpen(false); }}
          >
            <span className="af-ws-dot" style={{ background: 'var(--ink-3)' }}></span>
            <span className="col"><span className="nm">All workspaces</span><span className="rp">every repo</span></span>
            <span className="cnt">{counts['all'] ?? 0}</span>
          </button>
          {workspaces.map((w) => (
            <button
              key={w.id}
              className={'af-ws-opt' + (value === w.name ? ' on' : '')}
              onClick={() => { onChange(w.name); setOpen(false); }}
            >
              <span className="af-ws-dot" style={{ background: wsColor(workspaces, w.name) }}></span>
              <span className="col"><span className="nm">{w.name}</span><span className="rp">{w.repoPath}</span></span>
              <span className="cnt">{counts[w.name] ?? 0}</span>
            </button>
          ))}
          <button className="af-ws-opt af-ws-new" onClick={() => { setOpen(false); onNewWorkspace(); }}>
            {I.plus({ width: 13, height: 13 })} New workspace…
          </button>
        </div>
      )}
    </div>
  );
}
