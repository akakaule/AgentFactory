import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffView, COLLAPSE_THRESHOLD } from '../../client/src/components/DiffView.js';
import { parseUnifiedDiff, type ParsedDiff } from '../../client/src/diff.js';
import { MULTI_FILE, BINARY_FILE, PURE_RENAME, MODIFY_MULTI_HUNK } from './fixtures/diffs.js';

describe('DiffView', () => {
  it('renders the total stat line', () => {
    render(<DiffView parsed={parseUnifiedDiff(MULTI_FILE)} />);
    expect(screen.getByText('3 files changed')).toBeInTheDocument();
    expect(screen.getByText('+5')).toBeInTheDocument();
    expect(screen.getByText('−4')).toBeInTheDocument();
  });

  it('renders a header per file with status badge and counts', () => {
    render(<DiffView parsed={parseUnifiedDiff(MULTI_FILE)} />);
    expect(screen.getByText('docs/new.md')).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText('old.txt')).toBeInTheDocument();
    expect(screen.getByText('A')).toBeInTheDocument();
    expect(screen.getByText('M')).toBeInTheDocument();
    expect(screen.getByText('D')).toBeInTheDocument();
  });

  it('shows line content with numbers, and collapses on header click', async () => {
    const user = userEvent.setup();
    render(<DiffView parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);

    expect(screen.getByText("import { b, bb } from './b.js';")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /src\/app\.ts/ }));
    expect(screen.queryByText("import { b, bb } from './b.js';")).not.toBeInTheDocument();
  });

  it(`starts collapsed when a file exceeds ${COLLAPSE_THRESHOLD} rendered lines`, async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: COLLAPSE_THRESHOLD + 1 }, (_, i) => ({
      type: 'add' as const, text: `generated line ${i}`, oldNo: null, newNo: i + 1,
    }));
    const parsed: ParsedDiff = {
      files: [{
        oldPath: 'big.txt', newPath: 'big.txt', status: 'added', binary: false,
        adds: lines.length, dels: 0,
        hunks: [{ header: '', oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }],
      }],
      adds: lines.length, dels: 0,
    };
    render(<DiffView parsed={parsed} />);

    expect(screen.queryByText('generated line 0')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /big\.txt/ }));
    expect(screen.getByText('generated line 0')).toBeInTheDocument();
  });

  it('shows a notice instead of lines for binary files', () => {
    render(<DiffView parsed={parseUnifiedDiff(BINARY_FILE)} />);
    expect(screen.getByText('Binary file not shown')).toBeInTheDocument();
  });

  it('shows old → new for renames', () => {
    render(<DiffView parsed={parseUnifiedDiff(PURE_RENAME)} />);
    expect(screen.getByText('README.md → RENAMED.md')).toBeInTheDocument();
  });

  it('switches to side-by-side split rows (old | new columns) when toggled', async () => {
    const user = userEvent.setup();
    const { container } = render(<DiffView parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);
    expect(container.querySelector('.af-diff-srow')).toBeNull(); // unified by default

    await user.click(screen.getByRole('button', { name: 'Side-by-side' }));
    const rows = container.querySelectorAll('.af-diff-srow:not(.hunkhead)');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.children.length).toBe(4); // oldNo | old code | newNo | new code
  });
});
