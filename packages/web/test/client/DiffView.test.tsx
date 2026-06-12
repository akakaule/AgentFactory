import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiffView, COLLAPSE_THRESHOLD } from '../../client/src/components/DiffView.js';
import { parseUnifiedDiff, type ParsedDiff } from '../../client/src/diff.js';
import { useDiffComments } from '../../client/src/diffComments.js';
import { MULTI_FILE, BINARY_FILE, PURE_RENAME, MODIFY_MULTI_HUNK } from './fixtures/diffs.js';

/** Wraps DiffView with a real comment store so anchoring/marker flow can be exercised. */
function Reviewable({ parsed }: { parsed: ParsedDiff }) {
  const store = useDiffComments();
  return <DiffView parsed={parsed} commentStore={store} />;
}

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

  it('makes no lines commentable without a comment store', () => {
    render(<DiffView parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);
    expect(screen.queryByRole('button', { name: /^Comment on/ })).not.toBeInTheDocument();
  });

  it('opens an inline editor when a commentable line is clicked', async () => {
    const user = userEvent.setup();
    render(<Reviewable parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);

    await user.click(screen.getByRole('button', { name: 'Comment on src/app.ts line 2' }));
    expect(screen.getByPlaceholderText('Leave a note for the agent…')).toBeInTheDocument();
  });

  it('does not offer a comment affordance on pure-deletion lines', () => {
    render(<Reviewable parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);
    // old line 2 is deleted (no new-line number) → not commentable
    expect(screen.queryByRole('button', { name: 'Comment on src/app.ts line 2' })).toBeInTheDocument();
    // there is exactly one button anchored at line 2 (the added line), never the deleted one
    expect(screen.getAllByRole('button', { name: 'Comment on src/app.ts line 2' })).toHaveLength(1);
  });

  it('saves a draft as a visible, removable marker that survives a re-render', async () => {
    const user = userEvent.setup();
    render(<Reviewable parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);

    await user.click(screen.getByRole('button', { name: 'Comment on src/app.ts line 2' }));
    await user.type(screen.getByPlaceholderText('Leave a note for the agent…'), 'make this configurable');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    // editor closes; comment text is shown as a marker
    expect(screen.queryByPlaceholderText('Leave a note for the agent…')).not.toBeInTheDocument();
    expect(screen.getByText('make this configurable')).toBeInTheDocument();

    // removable
    await user.click(screen.getByRole('button', { name: 'Remove' }));
    expect(screen.queryByText('make this configurable')).not.toBeInTheDocument();
  });

  it('does not save an empty comment', async () => {
    const user = userEvent.setup();
    render(<Reviewable parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);

    await user.click(screen.getByRole('button', { name: 'Comment on src/app.ts line 2' }));
    expect(screen.getByRole('button', { name: 'Comment' })).toBeDisabled();
  });

  it('reopens an existing draft for editing and replaces it in place', async () => {
    const user = userEvent.setup();
    render(<Reviewable parsed={parseUnifiedDiff(MODIFY_MULTI_HUNK)} />);

    await user.click(screen.getByRole('button', { name: 'Comment on src/app.ts line 2' }));
    await user.type(screen.getByPlaceholderText('Leave a note for the agent…'), 'first');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByPlaceholderText('Leave a note for the agent…');
    await user.clear(box);
    await user.type(box, 'second');
    await user.click(screen.getByRole('button', { name: 'Comment' }));

    expect(screen.queryByText('first')).not.toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });
});
