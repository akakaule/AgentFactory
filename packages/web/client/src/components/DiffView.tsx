import { useState } from 'react';
import type { DiffFile, DiffLineType, ParsedDiff } from '../diff.js';
import { I } from '../icons.js';

/** Files rendering more lines than this start collapsed. */
export const COLLAPSE_THRESHOLD = 300;

const BADGE: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const LINE_CLASS: Record<DiffLineType, string> = { context: 'ctx', add: 'add', del: 'del', meta: 'meta' };

function FileSection({ file }: { file: DiffFile }) {
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
          <div className="af-diff-line hunkhead">
            <span className="ln"></span>
            <span className="ln"></span>
            <span className="code">
              @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@{hunk.header && ` ${hunk.header}`}
            </span>
          </div>
          {hunk.lines.map((line, li) => (
            <div key={li} className={'af-diff-line ' + LINE_CLASS[line.type]}>
              <span className="ln">{line.oldNo ?? ''}</span>
              <span className="ln">{line.newNo ?? ''}</span>
              <span className="code">{line.text}</span>
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}

export function DiffView({ parsed }: { parsed: ParsedDiff }) {
  return (
    <div className="af-diff">
      <div className="af-diffstat">
        <span>{parsed.files.length} file{parsed.files.length === 1 ? '' : 's'} changed</span>
        <span className="a">+{parsed.adds}</span>
        <span className="d">−{parsed.dels}</span>
      </div>
      {parsed.files.map((file, i) => <FileSection key={i} file={file} />)}
    </div>
  );
}
