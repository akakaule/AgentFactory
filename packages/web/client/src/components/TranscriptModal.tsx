import { useEffect, useState, type ReactNode } from 'react';
import type { TranscriptBlock, TranscriptEngine } from '../types.js';
import { I } from '../icons.js';

/** Initial render cap — only the last N blocks render until expanded (transcripts run to thousands). */
const WINDOW = 200;

type BashBlock = Extract<TranscriptBlock, { kind: 'bash' }>;
type ToolBlock = Extract<TranscriptBlock, { kind: 'tool' }>;
type TxState = 'live' | 'final';

export function fmtBytes(n: number | null): string {
  if (n == null) return '–';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The compact `engine · N blocks · size · state` line — shared by the drawer summary and the modal head. */
export function TranscriptMeta({ engine, count, bytes, state }: { engine: TranscriptEngine | null; count: number; bytes: number | null; state: TxState }) {
  return (
    <div className="af-tx-meta">
      {engine && <span className="eng">{engine}</span>}
      <span>{count} block{count === 1 ? '' : 's'}</span>
      <span>· {fmtBytes(bytes)}</span>
      <span className={'st ' + state}>· {state}</span>
    </div>
  );
}

/** Collapsible pre region used by bash output and tool input/result. */
function Fold({ label, truncated, children }: { label: string; truncated: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="af-tx-fold" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={'chev' + (open ? ' open' : '')}>{I.chev({})}</span>
        {open ? `Hide ${label}` : label}
        {truncated && <span className="af-tx-trunc">truncated</span>}
      </button>
      {open && children}
    </>
  );
}

function BashView({ block }: { block: BashBlock }) {
  const out = [block.stdout, block.stderr].filter((s): s is string => !!s).join('\n');
  const bad = block.isError || (block.exitCode != null && block.exitCode !== 0);
  return (
    <>
      <div className="af-tx-cmd">
        <span className="p">$</span>
        <span className="c">{block.command}</span>
        {block.exitCode != null && <span className={'af-tx-exit' + (bad ? ' bad' : '')}>exit {block.exitCode}</span>}
      </div>
      {block.description && <div className="af-tx-desc">{block.description}</div>}
      {out && (
        <Fold label="output" truncated={block.truncated}>
          <pre className="af-tx-out">{out}</pre>
        </Fold>
      )}
    </>
  );
}

function ToolView({ block }: { block: ToolBlock }) {
  return (
    <>
      <div className="af-tx-tool">
        <span className="n">🔧 {block.name}</span>
        {block.isError && <span className="af-tx-exit bad">error</span>}
      </div>
      <Fold label="detail" truncated={block.truncated}>
        <pre className="af-tx-out">{block.input}</pre>
        {block.result != null && <pre className="af-tx-out res">{block.result}</pre>}
      </Fold>
    </>
  );
}

function BlockView({ block }: { block: TranscriptBlock }) {
  const err = (block.kind === 'bash' && (block.isError || (block.exitCode != null && block.exitCode !== 0)))
    || (block.kind === 'tool' && block.isError);
  const cls = 'af-tx-block ' + block.kind + (block.sidechain ? ' sub' : '') + (err ? ' err' : '');
  return (
    <div className={cls}>
      {block.kind === 'text' && (<>
        <span className="af-tx-role">{block.role}</span>
        <div className="af-tx-text">{block.text}</div>
      </>)}
      {block.kind === 'thinking' && <div className="af-tx-think">{block.text}</div>}
      {block.kind === 'bash' && <BashView block={block} />}
      {block.kind === 'tool' && <ToolView block={block} />}
      {block.kind === 'image' && <div className="af-tx-img">🖼 {block.note}</div>}
    </div>
  );
}

interface Props {
  blocks: TranscriptBlock[];
  bytes: number | null;
  engine: TranscriptEngine | null;
  state: TxState;
  onClose: () => void;
}

/** The full agent transcript in a modal — opened on demand from the drawer's compact summary.
 *  Clones DiffModal's overlay/escape/close mechanics; `blocks` is passed live so it keeps
 *  updating while an in_progress task streams. */
export function TranscriptModal({ blocks, bytes, engine, state, onClose }: Props) {
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const shown = showAll ? blocks : blocks.slice(-WINDOW);
  const hidden = blocks.length - shown.length;

  return (
    <div className="af-overlay" onClick={onClose}>
      <div
        className="af-modal af-txmodal"
        role="dialog"
        aria-modal="true"
        aria-label="Agent transcript"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="af-txmodal-head">
          {I.bot({})}
          <span className="ref">Transcript</span>
          <TranscriptMeta engine={engine} count={blocks.length} bytes={bytes} state={state} />
          <button className="af-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="af-txmodal-body">
          {hidden > 0 && (
            <button className="af-mini" onClick={() => setShowAll(true)}>Show all {blocks.length} blocks</button>
          )}
          <div className="af-tx-blocks">
            {shown.map((b) => <BlockView key={b.id} block={b} />)}
          </div>
        </div>
      </div>
    </div>
  );
}
