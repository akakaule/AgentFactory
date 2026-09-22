import { describe, expect, it } from 'vitest';
import { parseAiReviewComment, summarizeAiReview, isAiReviewMarker } from '../src/aiReview.js';
import { openCore, reviewSubmissionFingerprint } from '../src/index.js';

const finding = { title: 'Stale worker overwrites a claim', severity: 'error', file: 'a.ts', line: 2, detail: 'The old identity is accepted.' };
export function consensusBody(decisions: string[] = ['confirm', 'reject']) {
  const participants = ['claude/fable', 'codex/astra'];
  const outcome = decisions.every(d => d === 'confirm') ? 'confirmed' : decisions.every(d => d === 'reject') ? 'rejected' : 'disputed';
  return 'ai-review/v2\n```json\n' + JSON.stringify({
    reviewer: participants.join(' + '), verdict: outcome === 'disputed' ? 'disputed' : outcome === 'confirmed' ? 'findings' : 'clean',
    findings: outcome === 'confirmed' ? [finding] : [],
    consensus: { participants, status: outcome === 'disputed' ? 'disputed' : 'agreed', history: [], candidates: [{
      id: 'F1', source: participants[0], finding, outcome,
      votes: participants.map((reviewer, i) => ({ reviewer, decision: decisions[i], severity: 'error', evidence: 'Verified branch a.ts:2', duplicateOf: null })),
    }] },
  }) + '\n```';
}

describe('consensus review safety', () => {
  it('rejects an old consensus at the core write boundary after a replacement submission', () => {
    const core = openCore(':memory:');
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human'); core.claimNextTask({ claimedBy: 'first' });
    core.submitResult(t.key, { summary: 'First' });
    const payload = JSON.parse(consensusBody().split('```json\n')[1]!.split('\n```')[0]!);
    payload.consensus.submission = { key: t.key, fingerprint: reviewSubmissionFingerprint(core.getTask(t.key)) };
    core.reviewRequestChanges(t.key, { feedback: 'Fix' }); core.claimNextTask({ claimedBy: 'replacement' });
    core.submitResult(t.key, { summary: 'Replacement' });
    expect(() => core.addComment(t.key, { actor: 'agent', body: 'ai-review/v2\n```json\n' + JSON.stringify(payload) + '\n```' })).toThrow(/submission changed/);
    expect(core.getTask(t.key).aiReview).toBeNull();
  });
  it('recognizes v2 and derives disputes instead of an empty clean review', () => {
    expect(isAiReviewMarker(consensusBody())).toBe(true);
    expect(summarizeAiReview(parseAiReviewComment(consensusBody()), false)).toMatchObject({ verdict: 'disputed', findings: 0 });
  });
  it('rejects a verdict that pretends split votes are clean', () => {
    expect(parseAiReviewComment(consensusBody().replace('"verdict":"disputed"', '"verdict":"clean"'))).toBeNull();
  });
  it('recognizes unanimous rejection as clean and confirmation as findings', () => {
    expect(summarizeAiReview(parseAiReviewComment(consensusBody(['reject', 'reject'])), false)?.verdict).toBe('clean');
    expect(summarizeAiReview(parseAiReviewComment(consensusBody(['confirm', 'confirm'])), false)?.findings).toBe(1);
  });
  it('does not auto-advance a disputed document and records human override', () => {
    const core = openCore(':memory:');
    const t = core.createTask({ title: 'Description', spec: 'Intent', stage: 'description' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'worker' });
    core.submitResult(t.key, { summary: 'Description', spec: 'Intent', acceptanceCriteria: 'Proof' });
    core.addComment(t.key, { actor: 'agent', body: consensusBody() });
    expect(core.getTask(t.key)).toMatchObject({ status: 'in_review', stage: 'description', aiReview: { verdict: 'disputed' } });
    expect(core.listTasks({ status: 'in_review' })[0]?.aiReview?.verdict).toBe('disputed');
    core.reviewApprove(t.key);
    expect(core.getTask(t.key).activity.some(a => a.body.includes('override:') && a.body.includes('dispute'))).toBe(true);
  });
});
