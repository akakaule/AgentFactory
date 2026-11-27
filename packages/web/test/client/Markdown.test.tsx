import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Markdown } from '../../client/src/components/Markdown.js';

describe('Markdown', () => {
  it('renders headings, lists, inline code and emphasis', () => {
    const { container } = render(<Markdown text={'## Problem\n\nThe `Mapper` stores **raw** input.\n\n- keep `Comment`\n- stamp the auditor'} />);
    expect(screen.getByRole('heading', { level: 2, name: 'Problem' })).toBeInTheDocument();
    expect(container.querySelector('code')?.textContent).toBe('Mapper');
    expect(container.querySelector('strong')?.textContent).toBe('raw');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });

  it('keeps single line breaks, so a plain-text spec reads as it always did', () => {
    const { container } = render(<Markdown text={'first line\nsecond line'} />);
    expect(container.querySelectorAll('br')).toHaveLength(1);
  });

  it('renders GFM tables and fenced code blocks', () => {
    const { container } = render(<Markdown text={'| a | b |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```'} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(container.querySelector('pre code')?.textContent).toContain('const x = 1;');
  });

  it('opens links in a new tab without a referrer', () => {
    render(<Markdown text={'See [the plan](https://github.com/x/y/blob/master/docs/plan.md).'} />);
    const link = screen.getByRole('link', { name: 'the plan' });
    expect(link).toHaveAttribute('href', 'https://github.com/x/y/blob/master/docs/plan.md');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noreferrer');
  });

  it('never renders raw HTML or script links from agent-written text', () => {
    const { container } = render(<Markdown text={'<img src=x onerror="alert(1)"> <script>alert(2)</script>\n\n[click](javascript:alert(3))'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(screen.getByText('click').closest('a')?.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
  });
});
