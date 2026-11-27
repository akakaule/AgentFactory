import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';

// Links leave the board: a new tab, and no referrer carrying the board's URL to another site.
const components: Components = {
  a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
};

/**
 * Task text (spec, acceptance criteria, plan) rendered as Markdown. Humans and agents both write
 * it, so it is untrusted: react-markdown builds React elements (never innerHTML), skips raw HTML,
 * and drops unsafe link protocols such as `javascript:`. GFM adds tables and task lists;
 * remark-breaks keeps single line breaks, so plain-text specs read exactly as they did before.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={'af-md' + (className ? ` ${className}` : '')}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={components}>{text}</ReactMarkdown>
    </div>
  );
}
