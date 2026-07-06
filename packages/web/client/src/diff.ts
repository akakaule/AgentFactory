export type DiffLineType = 'context' | 'add' | 'del' | 'meta'; // meta = "\ No newline at end of file"
export interface DiffLine { type: DiffLineType; text: string; oldNo: number | null; newNo: number | null; }
export interface DiffHunk {
  header: string; oldStart: number; oldLines: number; newStart: number; newLines: number; lines: DiffLine[];
}
export type FileStatus = 'modified' | 'added' | 'deleted' | 'renamed';
export interface DiffFile {
  oldPath: string; newPath: string; status: FileStatus; binary: boolean; hunks: DiffHunk[]; adds: number; dels: number;
}
export interface ParsedDiff { files: DiffFile[]; adds: number; dels: number; }

/** One row of a side-by-side view: the old-side line (left) and the new-side line (right). Either
 *  may be null (a pure add has no left; a pure del has no right). */
export interface SplitRow { left: DiffLine | null; right: DiffLine | null; }

/**
 * Pair a hunk's lines into side-by-side rows (the GitHub/ADO layout): a context line flushes any
 * pending del/add run and shows on both sides; a run of dels then adds pairs row-by-row up to the
 * longer run (leftover dels are left-only, leftover adds right-only); meta lines are dropped.
 */
export function toSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = (): void => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i] ?? null, right: adds[i] ?? null });
    dels = [];
    adds = [];
  };
  for (const line of lines) {
    if (line.type === 'del') dels.push(line);
    else if (line.type === 'add') adds.push(line);
    else if (line.type === 'meta') continue; // "\ No newline at end of file" — annotation, drop it
    else { flush(); rows.push({ left: line, right: line }); } // context: identical on both sides
  }
  flush();
  return rows;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const GIT_LINE_RE = /^"?a\/(.*?)"? "?b\/(.*?)"?$/;

/** `--- a/path` / `+++ b/path` payload → path, or null when /dev/null (keep the other side). */
function parsePathLine(raw: string): string | null {
  const unquoted = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  if (unquoted === '/dev/null') return null;
  return unquoted.slice(2); // strip a/ or b/
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  for (const section of text.split(/^diff --git /m).slice(1)) {
    const lines = section.split('\n');
    const file: DiffFile = { oldPath: '', newPath: '', status: 'modified', binary: false, hunks: [], adds: 0, dels: 0 };
    const git = GIT_LINE_RE.exec(lines[0] ?? '');
    if (git) { file.oldPath = git[1]!; file.newPath = git[2]!; }

    let i = 1;
    for (; i < lines.length && !HUNK_RE.test(lines[i]!); i++) {
      const line = lines[i]!;
      if (line.startsWith('new file mode')) file.status = 'added';
      else if (line.startsWith('deleted file mode')) file.status = 'deleted';
      else if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); }
      else if (line.startsWith('rename to ')) { file.status = 'renamed'; file.newPath = line.slice(10); }
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) file.binary = true;
      else if (line.startsWith('--- ')) file.oldPath = parsePathLine(line.slice(4)) ?? file.oldPath;
      else if (line.startsWith('+++ ')) file.newPath = parsePathLine(line.slice(4)) ?? file.newPath;
    }

    let hunk: DiffHunk | null = null;
    let oldNo = 0;
    let newNo = 0;
    for (; i < lines.length; i++) {
      const line = lines[i]!;
      if (line === '' && i === lines.length - 1) break; // trailing-newline split artifact
      const m = HUNK_RE.exec(line);
      if (m) {
        hunk = {
          header: m[5]!, oldStart: +m[1]!, oldLines: m[2] ? +m[2] : 1,
          newStart: +m[3]!, newLines: m[4] ? +m[4] : 1, lines: [],
        };
        oldNo = hunk.oldStart;
        newNo = hunk.newStart;
        file.hunks.push(hunk);
      } else if (hunk) {
        if (line[0] === '+') { hunk.lines.push({ type: 'add', text: line.slice(1), oldNo: null, newNo: newNo++ }); file.adds++; }
        else if (line[0] === '-') { hunk.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++, newNo: null }); file.dels++; }
        else if (line[0] === '\\') hunk.lines.push({ type: 'meta', text: line, oldNo: null, newNo: null });
        else hunk.lines.push({ type: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ });
      }
    }
    files.push(file);
  }
  return {
    files,
    adds: files.reduce((n, f) => n + f.adds, 0),
    dels: files.reduce((n, f) => n + f.dels, 0),
  };
}
