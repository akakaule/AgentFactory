import { useState } from 'react';
import type { DiffFile, DiffLineType, ParsedDiff } from '../diff.js';
import { toSplitRows } from '../diff.js';
import { I } from '../icons.js';

/** Files rendering more lines than this start collapsed. */
export const COLLAPSE_THRESHOLD = 300;

export type DiffMode = 'unified' | 'split';

const BADGE: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const LINE_CLASS: Record<DiffLineType, string> = { context: 'ctx', add: 'add', del: 'del', meta: 'meta' };

function HunkHeader({ hunk }: { hunk: DiffFile['hunks'][number] }) {
  return (
    <>@@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header && ` ${hunk.header}`}</>
  );
}

function FileSection({ file, mode }: { file: DiffFile; mode: DiffMode }) {
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= COLLAPSE_THRESHOLD);
  const path = file.status === 'renamed' ? `${file.oldPath} → ${file.newPath}` : (file.newPath || file.oldPath);
  return (
    <section className="af-diff-file">
      <button className="af-diff-filehead" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={'af-diff-badge ' + file.status}>{BADGE[file.status]}</span>
        <span className="path">{path}</span>
        {(file.adds > 0 || file.dels > 0) && (
          <span className="counts"><span className="a">+{file.adds}</span><span className="d">−{file.dels}</span></span>
        )}
        <span className={'chev' + (open ? ' open' : '')}>{I.chev({})}</span>
      </button>
      {open && file.binary && <div className="af-diff-note">Binary file not shown</div>}
      {open && !file.binary && file.hunks.map((hunk, hi) => (
        <div key={hi} className="af-diff-hunk">
          {mode === 'split' ? (
            <>
              <div className="af-diff-srow hunkhead"><span className="code" style={{ gridColumn: '1 / -1' }}><HunkHeader hunk={hunk} /></span></div>
              {toSplitRows(hunk.lines).map((row, ri) => (
                <div key={ri} className="af-diff-srow">
                  <span className="ln">{row.left?.oldNo ?? ''}</span>
                  <span className={'code ' + (row.left ? (row.left.type === 'del' ? 'del' : 'ctx') : 'blank')}>{row.left ? row.left.text : ''}</span>
                  <span className="ln">{row.right?.newNo ?? ''}</span>
                  <span className={'code ' + (row.right ? (row.right.type === 'add' ? 'add' : 'ctx') : 'blank')}>{row.right ? row.right.text : ''}</span>
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="af-diff-line hunkhead">
                <span className="ln"></span>
                <span className="ln"></span>
                <span className="code"><HunkHeader hunk={hunk} /></span>
              </div>
              {hunk.lines.map((line, li) => (
                <div key={li} className={'af-diff-line ' + LINE_CLASS[line.type]}>
                  <span className="ln">{line.oldNo ?? ''}</span>
                  <span className="ln">{line.newNo ?? ''}</span>
                  <span className="code">{line.text}</span>
                </div>
              ))}
            </>
          )}
        </div>
      ))}
    </section>
  );
}

const MODE_KEY = 'af_diff_mode';
function initialMode(): DiffMode {
  try { return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'unified'; } catch { return 'unified'; }
}

export function DiffView({ parsed }: { parsed: ParsedDiff }) {
  const [mode, setMode] = useState<DiffMode>(initialMode);
  const pick = (m: DiffMode) => { setMode(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* jsdom / private mode */ } };
  return (
    <div className="af-diff">
      <div className="af-diffstat">
        <span>{parsed.files.length} file{parsed.files.length === 1 ? '' : 's'} changed</span>
        <span className="a">+{parsed.adds}</span>
        <span className="d">−{parsed.dels}</span>
        <div className="af-diff-modetoggle">
          <button className={mode === 'unified' ? 'on' : ''} onClick={() => pick('unified')}>Unified</button>
          <button className={mode === 'split' ? 'on' : ''} onClick={() => pick('split')}>Side-by-side</button>
        </div>
      </div>
      {parsed.files.map((file, i) => <FileSection key={i} file={file} mode={mode} />)}
    </div>
  );
}
