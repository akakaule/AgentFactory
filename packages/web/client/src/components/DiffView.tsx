import { useState } from 'react';
import type { DiffFile, DiffLine, DiffLineType, ParsedDiff } from '../diff.js';
import type { DiffCommentStore } from '../diffComments.js';
import { I } from '../icons.js';

/** Files rendering more lines than this start collapsed. */
export const COLLAPSE_THRESHOLD = 300;

const BADGE: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };
const LINE_CLASS: Record<DiffLineType, string> = { context: 'ctx', add: 'add', del: 'del', meta: 'meta' };

/** Inline editor for a single line's draft note. */
function LineComment({ initial, onSave, onRemove, onCancel }: {
  initial: string;
  onSave: (text: string) => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  return (
    <div className="af-diff-cbox">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Leave a note for the agent…"
        rows={2}
      />
      <div className="row">
        <button className="af-mini go" disabled={text.trim() === ''} onClick={() => onSave(text)}>Comment</button>
        {initial !== '' && <button className="af-mini danger" onClick={onRemove}>Remove</button>}
        <button className="af-mini" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

/**
 * One diff line. With a comment store it becomes clickable (lines that carry a new-line number)
 * to attach a draft note; without one — or for deletion/meta lines — it renders read-only, byte
 * for byte as before.
 */
function DiffLineRow({ line, file, store, editing, onEdit }: {
  line: DiffLine;
  file: string;
  store?: DiffCommentStore | undefined;
  editing: boolean;
  onEdit: (line: number | null) => void;
}) {
  const cls = 'af-diff-line ' + LINE_CLASS[line.type];
  const lineNo = line.newNo;
  if (!store || lineNo === null) {
    return (
      <div className={cls}>
        <span className="ln">{line.oldNo ?? ''}</span>
        <span className="ln">{line.newNo ?? ''}</span>
        <span className="code">{line.text}</span>
      </div>
    );
  }

  const draft = store.comments.find((c) => c.file === file && c.line === lineNo);
  return (
    <>
      <div
        className={cls + ' commentable' + (draft ? ' has-comment' : '')}
        role="button"
        tabIndex={0}
        aria-label={`Comment on ${file} line ${lineNo}`}
        onClick={() => onEdit(lineNo)}
      >
        <span className="ln">{line.oldNo ?? ''}</span>
        <span className="ln">{lineNo}</span>
        <span className="code">{line.text}</span>
        {draft && !editing && <span className="cmark" aria-hidden="true">{I.comment({})}</span>}
      </div>
      {draft && !editing && (
        <div className="af-diff-comment">
          <span className="txt">{draft.text}</span>
          <button className="af-mini" onClick={() => onEdit(lineNo)}>Edit</button>
          <button className="af-mini danger" onClick={() => store.remove(file, lineNo)}>Remove</button>
        </div>
      )}
      {editing && (
        <LineComment
          initial={draft?.text ?? ''}
          onSave={(t) => { store.upsert(file, lineNo, t); onEdit(null); }}
          onRemove={() => { store.remove(file, lineNo); onEdit(null); }}
          onCancel={() => onEdit(null)}
        />
      )}
    </>
  );
}

function FileSection({ file, store }: { file: DiffFile; store?: DiffCommentStore | undefined }) {
  const lineCount = file.hunks.reduce((n, h) => n + h.lines.length, 0);
  const [open, setOpen] = useState(lineCount <= COLLAPSE_THRESHOLD);
  const [editingLine, setEditingLine] = useState<number | null>(null);
  const path = file.status === 'renamed' ? `${file.oldPath} → ${file.newPath}` : (file.newPath || file.oldPath);
  const anchorFile = file.newPath || file.oldPath;
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
            <DiffLineRow
              key={li}
              line={line}
              file={anchorFile}
              store={store}
              editing={editingLine === line.newNo}
              onEdit={setEditingLine}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

export function DiffView({ parsed, commentStore }: { parsed: ParsedDiff; commentStore?: DiffCommentStore | undefined }) {
  return (
    <div className="af-diff">
      <div className="af-diffstat">
        <span>{parsed.files.length} file{parsed.files.length === 1 ? '' : 's'} changed</span>
        <span className="a">+{parsed.adds}</span>
        <span className="d">−{parsed.dels}</span>
      </div>
      {parsed.files.map((file, i) => <FileSection key={i} file={file} store={commentStore} />)}
    </div>
  );
}
