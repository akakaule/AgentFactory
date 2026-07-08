import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskCard } from '../../client/src/components/TaskCard.js';
import type { Task } from '../../client/src/types.js';

const task: Task = {
  id: 1,
  key: 'AF-22',
  title: 'Needs human eyes',
  spec: 'Spec',
  acceptanceCriteria: 'AC',
  status: 'in_review',
  stage: 'implementation',
  kind: 'code',
  resultSummary: 'Done',
  seq: 1,
  workspace: 'default',
  claimedBy: null,
  claimedAt: null,
  archivedAt: null,
  aiReview: { verdict: 'clean', findings: 0, reviewer: 'codex', items: [] },
  reviewGate: { autoIterate: false, autoRounds: 0, autoLimit: 5, humanReviewed: false, aiOnly: true },
  failure: null,
  delivery: null,
  createdAt: '2026-07-08T00:00:00Z',
  updatedAt: '2026-07-08T00:00:00Z',
};

describe('TaskCard', () => {
  it('shows when the current result has only been reviewed by AI', () => {
    render(<TaskCard task={task} onOpen={vi.fn()} />);

    expect(screen.getByText('AI-only review')).toBeInTheDocument();
  });
});
