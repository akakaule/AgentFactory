import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskText } from '../../client/src/components/TaskText.js';

describe('TaskText', () => {
  it('shows the plain text at once, then the formatted Markdown when its chunk has loaded', async () => {
    const { container } = render(<TaskText className="af-d-body" text={'## Problem\n\nbody'} />);
    expect(container.querySelector('.af-d-body')?.textContent).toContain('## Problem'); // fallback, same class
    expect(await screen.findByRole('heading', { name: 'Problem' }, { timeout: 5000 })).toBeInTheDocument();
    expect(container.querySelector('.af-d-body.af-md')).not.toBeNull();
  });
});
