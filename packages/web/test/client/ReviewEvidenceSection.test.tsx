import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { ReviewEvidenceSection } from '../../client/src/components/ReviewEvidenceSection.js';
import { remainingConcerns } from '../../client/src/reviewConcerns.js';
import type { EvidenceItem, TaskDetailView } from '../../client/src/types.js';

const item = (over: Partial<EvidenceItem> & Pick<EvidenceItem, 'source' | 'state'>): EvidenceItem =>
  ({ headSha: null, at: 't', label: '', ...over });

function task(over: Partial<TaskDetailView> = {}): TaskDetailView {
  return {
    id: 172, key: 'AF-172', title: 't', spec: 's', acceptanceCriteria: '1. A — a',
    status: 'in_review', stage: 'implementation', kind: 'code', resultSummary: 'done', seq: 1, workspace: 'agentfactory',
    unmetDependencyCount: 0, claimedBy: null, claimedAt: null, archivedAt: null,
    aiReview: null, reviewBrief: null, failure: null, delivery: null,
    createdAt: 't', updatedAt: 'u', activity: [], links: [], attachments: [], dependencies: [], dependents: [],
    repoPath: '.', branch: null, plan: null, originalSpec: null, originalAcceptanceCriteria: null, policy: null,
    verifyCommand: null, hasVisualization: false, visualizationGeneratedAt: null,
    metrics: { queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0, deliveringMin: 0, rounds: 0, reopened: false, claimCount: 0, doneAt: null, model: null, tokensIn: null, tokensOut: null, costUsd: null },
    criteriaClaims: null, evidence: [],
    ...over,
  } as TaskDetailView;
}

const rows = () => within(screen.getByLabelText('Evidence')).getAllByRole('listitem').map((li) => li.textContent);

describe('ReviewEvidenceSection', () => {
  it('lists each item as source · state · sha or check name, runner first', () => {
    render(<ReviewEvidenceSection evidence={[
      item({ source: 'provider', state: 'passed', label: 'build' }),
      item({ source: 'reported', state: 'unverified', label: 'all green' }),
      item({ source: 'runner', state: 'passed', headSha: 'abc1234def5678', label: 'npm test' }),
    ]} />);
    expect(rows()).toEqual(['Runner · passed · abc1234', 'Reported · unverified', 'Provider · passed · build']);
  });

  it('never shows a worker report as a pass', () => {
    render(<ReviewEvidenceSection evidence={[item({ source: 'reported', state: 'unverified', label: 'passed: all tests passed' })]} />);
    expect(screen.getByLabelText('Evidence').textContent).not.toContain('passed');
  });

  it('shows a stale runner item as stale', () => {
    render(<ReviewEvidenceSection evidence={[item({ source: 'runner', state: 'stale', label: 'npm test' })]} />);
    expect(rows()).toEqual(['Runner · stale']);
  });

  it('says so when there is no evidence', () => {
    render(<ReviewEvidenceSection evidence={[]} />);
    expect(screen.getByLabelText('Evidence').textContent).toContain('No verification evidence');
  });
});

describe('remainingConcerns · verification evidence', () => {
  it('flags a stale runner item', () => {
    const t = task({ verifyCommand: 'npm test', evidence: [item({ source: 'runner', state: 'stale', headSha: 'abc1234' })] });
    expect(remainingConcerns(t)).toContain('Verification is for an older commit');
    expect(remainingConcerns(t)).not.toContain('No runner verification');
  });

  it('flags a missing runner item only when the workspace has a verify command', () => {
    expect(remainingConcerns(task({ verifyCommand: 'npm test', evidence: [] }))).toContain('No runner verification');
    expect(remainingConcerns(task({ verifyCommand: 'npm test', evidence: [item({ source: 'reported', state: 'unverified' })] })))
      .toContain('No runner verification');
    expect(remainingConcerns(task({ verifyCommand: null, evidence: [] }))).not.toContain('No runner verification');
  });

  it('does not flag a missing runner item outside the implementation stage', () => {
    expect(remainingConcerns(task({ stage: 'description', verifyCommand: 'npm test', evidence: [] }))).not.toContain('No runner verification');
  });

  it('a current passing runner item raises nothing', () => {
    expect(remainingConcerns(task({ verifyCommand: 'npm test', evidence: [item({ source: 'runner', state: 'passed', headSha: 'abc1234' })] }))).toEqual([]);
  });
});
