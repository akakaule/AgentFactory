import { lazy, Suspense } from 'react';

// The Markdown parser is the largest dependency in the client, and only the task drawer needs it,
// so it loads as its own chunk. Until it arrives the text shows as plain text, as it always did.
const Markdown = lazy(() => import('./Markdown.js').then((m) => ({ default: m.Markdown })));

/** Task text (spec, acceptance criteria, plan) rendered as Markdown. */
export function TaskText({ text, className }: { text: string; className?: string }) {
  return (
    <Suspense fallback={<div className={className}>{text}</div>}>
      <Markdown text={text} {...(className ? { className } : {})} />
    </Suspense>
  );
}
