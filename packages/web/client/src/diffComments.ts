import { useCallback, useState } from 'react';

/** A draft review note anchored to a diff line. Client-only — never persisted on its own. */
export interface DiffComment {
  file: string; // post-change path the agent can act on (newPath || oldPath)
  line: number; // displayed line number (newNo ?? oldNo)
  text: string;
}

/** Draft store handed down to the diff viewer; `comments` is also read by ReviewActions. */
export interface DiffCommentStore {
  comments: DiffComment[];
  upsert: (file: string, line: number, text: string) => void;
  remove: (file: string, line: number) => void;
  clear: () => void;
}

/**
 * Fold drafts + the free-text feedback into one body the agent receives verbatim on its next
 * claim. Each non-empty draft becomes `file:line - "text"` (insertion order), prepended to the
 * trimmed free text. No drafts → the free text unchanged; nothing at all → empty string.
 */
export function serializeFeedback(comments: DiffComment[], freeText: string): string {
  const lines = comments
    .map((c) => ({ ...c, text: c.text.trim() }))
    .filter((c) => c.text !== '')
    .map((c) => `${c.file}:${c.line} - "${c.text}"`);
  const trimmed = freeText.trim();
  const parts: string[] = [];
  if (lines.length > 0) parts.push(lines.join('\n'));
  if (trimmed !== '') parts.push(trimmed);
  return parts.join('\n');
}

/** Holds line-anchored draft comments in component state for the lifetime of a task panel. */
export function useDiffComments(): DiffCommentStore {
  const [comments, setComments] = useState<DiffComment[]>([]);

  const upsert = useCallback((file: string, line: number, text: string) => {
    const trimmed = text.trim();
    setComments((prev) => {
      const idx = prev.findIndex((c) => c.file === file && c.line === line);
      if (trimmed === '') return idx === -1 ? prev : prev.filter((_, i) => i !== idx);
      if (idx === -1) return [...prev, { file, line, text: trimmed }];
      const next = prev.slice();
      next[idx] = { file, line, text: trimmed };
      return next;
    });
  }, []);

  const remove = useCallback((file: string, line: number) => {
    setComments((prev) => prev.filter((c) => !(c.file === file && c.line === line)));
  }, []);

  const clear = useCallback(() => setComments([]), []);

  return { comments, upsert, remove, clear };
}
