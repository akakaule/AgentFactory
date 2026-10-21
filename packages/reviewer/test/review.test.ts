import { describe, it, expect } from 'vitest';
import type { TaskDetail } from '@agentfactory/core';
import { buildReviewPrompt, truncateDiff, ensureMarker, buildFeedbackEvalPrompt, ensureFeedbackEvalMarker } from '../src/review.js';

/** A minimal TaskDetail for prompt-builder tests. */
function detail(over: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: 1,
    key: 'AF-1',
    title: 'The title',
    spec: 'the spec',
    acceptanceCriteria: 'the acceptance criteria',
    status: 'in_review',
    stage: 'implementation',
    resultSummary: 'did it',
    seq: 1,
    workspace: 'ws',
    claimedBy: null,
    claimedAt: null,
    archivedAt: null,
    aiReview: null,
    createdAt: 't',
    updatedAt: 't',
    activity: [
      {
        id: 1, taskId: 1, type: 'result', actor: 'agent', fromStatus: null, toStatus: null,
        body: 'the implementer summary', createdAt: 't', actorUserId: null, actorName: null,
      },
    ],
    links: [],
    attachments: [],
    repoPath: '/repo',
    branch: 'feature/x',
    plan: null,
    metrics: {
      queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0, rounds: 0, reopened: false,
      claimCount: 0, doneAt: null, model: null, tokensIn: null, tokensOut: null, costUsd: null,
    },
    ...over,
  };
}

describe('buildReviewPrompt', () => {
  it('description: compares the rewrite with the saved original request and criteria', () => {
    const p = buildReviewPrompt({ task: detail({ stage: 'description',
      originalSpec: 'Preserve offline access', originalAcceptanceCriteria: 'Works without a network',
    }), engine: 'codex' });
    expect(p).toContain('=== ORIGINAL REQUEST');
    expect(p).toContain('Preserve offline access');
    expect(p).toContain('Works without a network');
    expect(p).toContain('the spec');
    expect(p).toContain('the acceptance criteria');
  });

  it('description: explicitly marks missing originals instead of substituting the rewrite', () => {
    const p = buildReviewPrompt({ task: detail({ stage: 'description',
      originalSpec: null, originalAcceptanceCriteria: null,
    }), engine: 'codex' });
    expect(p).toContain('(original request not recorded)');
    expect(p).toContain('(original acceptance criteria not recorded)');
  });

  it('description: preserves an intentionally empty original without treating it as missing', () => {
    const p = buildReviewPrompt({ task: detail({ stage: 'description',
      originalSpec: '', originalAcceptanceCriteria: '',
    }), engine: 'codex' });
    expect(p).toContain('=== ORIGINAL REQUEST');
    expect(p).not.toContain('(original request not recorded)');
    expect(p).not.toContain('(original acceptance criteria not recorded)');
  });

  it('implementation: supplies the approved plan for checking material deviations', () => {
    const p = buildReviewPrompt({ task: detail({ plan: 'Migrate existing records before adding the constraint' }),
      engine: 'codex', branch: 'feature/x', diff: { baseRef: 'main', diff: 'D', commits: 1 } });
    expect(p).toContain('=== APPROVED IMPLEMENTATION PLAN ===');
    expect(p).toContain('Migrate existing records before adding the constraint');
    expect(p).toContain('justified improvements');
  });

  it('implementation: permits direct implementation tasks with no approved plan', () => {
    const p = buildReviewPrompt({ task: detail({ plan: null }), engine: 'codex',
      branch: 'feature/x', diff: { baseRef: 'main', diff: 'D', commits: 1 } });
    expect(p).toContain('(no approved plan recorded; review against the spec and acceptance criteria)');
  });

  it('plan: identifies the repository and requires read-only inspection', () => {
    const p = buildReviewPrompt({ task: detail({ stage: 'plan', repoPath: '/target/repository' }), engine: 'claude' });
    expect(p).toContain('/target/repository');
    expect(p).toContain('Inspect the relevant files read-only');
  });

  it('implementation: includes the diff, branch line, result summary, and the contract', () => {
    const p = buildReviewPrompt({
      task: detail(),
      engine: 'codex',
      branch: 'feature/x',
      diff: { baseRef: 'main', diff: 'THE-DIFF-BODY', commits: 3 },
    });
    expect(p).toContain('=== DIFF ===');
    expect(p).toContain('THE-DIFF-BODY');
    expect(p).toContain('feature/x (3 commit(s) vs main)');
    expect(p).toContain('the implementer summary');
    expect(p).toContain('ai-review/v1 - <N> findings (codex)');
  });

  it('implementation: throws without a branch + diff', () => {
    expect(() => buildReviewPrompt({ task: detail(), engine: 'codex' })).toThrow();
  });

  it('description: reviews spec + AC as the deliverable, no diff, mentions auto-advance', () => {
    const p = buildReviewPrompt({ task: detail({ stage: 'description' }), engine: 'codex' });
    expect(p).toContain('FEATURE DESCRIPTION');
    expect(p).toContain('=== SPEC (the deliverable under review) ===');
    expect(p).not.toContain('=== DIFF ===');
    expect(p).toContain('advances the task to its next stage automatically');
  });

  it('plan: reviews the plan body, interpolates the engine into the contract', () => {
    const p = buildReviewPrompt({ task: detail({ stage: 'plan', plan: 'PLAN-BODY' }), engine: 'claude' });
    expect(p).toContain('IMPLEMENTATION PLAN');
    expect(p).toContain('PLAN-BODY');
    expect(p).toContain('"reviewer": "claude"');
  });

  it('includes the workspace policy when set, on both implementation and doc reviews', () => {
    const impl = buildReviewPrompt({
      task: detail({ policy: 'No new dependencies without a note.' }),
      engine: 'codex', branch: 'feature/x', diff: { baseRef: 'main', diff: 'D', commits: 1 },
    });
    expect(impl).toContain('=== WORKSPACE POLICY');
    expect(impl).toContain('No new dependencies without a note.');

    const doc = buildReviewPrompt({ task: detail({ stage: 'plan', plan: 'P', policy: 'House rule X' }), engine: 'codex' });
    expect(doc).toContain('House rule X');
  });

  it('omits the policy section when no policy is set', () => {
    const p = buildReviewPrompt({
      task: detail(), engine: 'codex', branch: 'feature/x', diff: { baseRef: 'main', diff: 'D', commits: 1 },
    });
    expect(p).not.toContain('WORKSPACE POLICY');
  });
});

describe('truncateDiff', () => {
  it('truncates past the limit and flags the cut', () => {
    const out = truncateDiff('x'.repeat(100), 10);
    expect(out.startsWith('xxxxxxxxxx')).toBe(true);
    expect(out).toContain('diff truncated at 10 chars');
  });

  it('leaves a short diff, and a 0 limit, untouched', () => {
    expect(truncateDiff('short', 10)).toBe('short');
    expect(truncateDiff('anything', 0)).toBe('anything');
  });
});

describe('ensureMarker', () => {
  it('leaves a properly-marked body unchanged (trimmed)', () => {
    const body = 'ai-review/v1 - clean (codex)\nsummary\n```json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n```';
    expect(ensureMarker(`  ${body}  `, 'codex')).toBe(body);
  });

  it('prepends a marker with the right count when the engine omits it', () => {
    const raw = 'I reviewed it.\n```json\n{"reviewer":"codex","verdict":"findings","findings":[{"title":"bug"}]}\n```';
    const out = ensureMarker(raw, 'codex');
    expect(out.startsWith('ai-review/v1 - 1 findings (codex)')).toBe(true);
    expect(out).toContain('I reviewed it.');
  });
});

describe('buildFeedbackEvalPrompt', () => {
  const diff = { branch: 'feature/x', baseRef: 'origin/main', diff: 'diff --git a b\n+risky code', commits: 1 };
  it('includes the PR comment, the diff, configured evaluator instructions, and the feedback-eval contract', () => {
    const p = buildFeedbackEvalPrompt({
      task: detail(), engine: 'codex', feedback: 'this null check is missing', branch: 'feature/x', diff,
      systemPrompt: 'weigh test coverage heavily',
    });
    expect(p).toContain('this null check is missing');
    expect(p).toContain('risky code');
    expect(p).toContain('EVALUATOR INSTRUCTIONS');
    expect(p).toContain('weigh test coverage heavily');
    expect(p).toContain('feedback-eval/v1 - <disposition>');
  });
});

describe('ensureFeedbackEvalMarker', () => {
  it('leaves a marked body; prepends the marker when absent', () => {
    expect(ensureFeedbackEvalMarker('  feedback-eval/v1 - warranted\nok  ')).toBe('feedback-eval/v1 - warranted\nok');
    expect(ensureFeedbackEvalMarker('```json\n{"disposition":"partial"}\n```').startsWith('feedback-eval/v1\n')).toBe(true);
  });
});
