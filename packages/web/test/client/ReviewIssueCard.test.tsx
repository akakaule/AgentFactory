import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReviewIssueCard } from '../../client/src/components/ReviewIssueCard.js';
import type { ReviewIssue, ReviewOpinion } from '../../client/src/types.js';

const A = 'claude/a';
const B = 'codex/b';
const names = new Map([[A, 'Claude'], [B, 'Codex']]);
const confirm = (reviewer: string, severity: ReviewOpinion['severity']): ReviewOpinion =>
  ({ reviewer, decision: 'confirm', severity, reason: null, evidence: `${reviewer} evidence` });

function card(issue: Partial<ReviewIssue>) {
  const base: ReviewIssue = {
    id: 'F1', group: 'must', dispute: null, title: 'Root', problem: null, fix: null, file: null, line: null,
    criteria: null, source: A, opinions: [confirm(A, 'warning'), confirm(B, 'warning')], merged: [],
  };
  render(<ReviewIssueCard issue={{ ...base, ...issue }} criteria={[]} names={names} decision={undefined} readOnly={false}
    onDecide={vi.fn()} onEvidence={vi.fn()} onCriterion={vi.fn()} />);
}

describe('ReviewIssueCard — where the reviewers stand', () => {
  it('a group raised by a merged duplicate says so instead of claiming the reviewers agree on it', () => {
    card({ merged: [{ id: 'F3', title: 'Dup', source: B, opinions: [confirm(A, 'error'), confirm(B, 'error')] }] });
    expect(screen.getByText('Claude and Codex agree: should fix')).toBeInTheDocument();
    expect(screen.getByText('F3, a merged duplicate, is confirmed as must fix')).toBeInTheDocument();
    expect(screen.queryByText(/agree: must fix/)).toBeNull();
  });

  it('a split root raised to must fix shows both sides, not an agreement', () => {
    card({
      opinions: [confirm(A, 'warning'), confirm(B, 'error')],
      merged: [{ id: 'F3', title: 'Dup', source: B, opinions: [confirm(A, 'error'), confirm(B, 'error')] }],
    });
    expect(screen.queryByText(/agree/)).toBeNull();
    expect(screen.getByText('Claude rates it Should fix')).toBeInTheDocument();
    expect(screen.getByText('Codex rates it Must fix')).toBeInTheDocument();
    expect(screen.getByText('F3, a merged duplicate, is confirmed as must fix')).toBeInTheDocument();
  });

  it('an issue whose own votes agree reads as before', () => {
    card({ opinions: [confirm(A, 'error'), confirm(B, 'error')] });
    expect(screen.getByText('Claude and Codex agree: must fix')).toBeInTheDocument();
    expect(screen.queryByText(/merged duplicate/)).toBeNull();
  });
});
