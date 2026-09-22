import { describe, expect, it } from 'vitest';
import { Reviewer } from '../src/reviewer.js';
import { parseConfig } from '../src/config.js';
import { aiReviewBody, makeCore, makeDeps, makeFakeConsole, makeFakeSpawn, seedInReview } from './helpers.js';

function setup(stage: 'implementation' | 'description' = 'implementation') {
  const core = makeCore(); const key = seedInReview(core, 'ws', 'Consensus', stage);
  const { spawn, calls } = makeFakeSpawn(); let output = ''; let now = 0; let head = 'a'.repeat(40);
  const config = parseConfig({ db: ':memory:', workspaces: ['ws'], visualization: { enabled: false },
    consensus: { enabled: true, totalMinutes: 30 }, reviewers: [{ engine: 'claude', model: 'fable' }, { engine: 'codex', model: 'astra' }] });
  const r = new Reviewer(config, makeDeps(core, spawn, { console: makeFakeConsole(), now: () => now, readOutput: () => output,
    computeDiff: async () => ({ baseRef: 'main', baseSha: 'b'.repeat(40), headSha: head, diff: '+bug', commits: 1 }) }));
  const finish = async (body: string, code = 0) => {
    const call = calls.at(-1)!; output = body; call.child.emitStdout(body); await call.child.exit(code); output = '';
  };
  const vote = (decision: string) => JSON.stringify({ votes: [{ id: 'F1', decision, severity: 'error', evidence: 'a.ts:1 inspected', duplicateOf: null }] });
  return { core, key, calls, r, finish, vote, setTime: (t: number) => { now = t; }, changeHead: () => { head = 'c'.repeat(40); } };
}
describe('supervised consensus', () => {
  it('does not accept a failed Codex process as a consensus vote', async () => {
    const s = setup(); await s.r.tick(); await s.finish(aiReviewBody(0)); await s.finish(aiReviewBody(0), 1);
    expect(s.core.getTask(s.key).aiReview).toBeNull();
    expect(s.core.getTask(s.key).failure?.detail).toContain('codex exited code 1');
  });
  it('advances a document only after both independent clean reviews', async () => {
    const s = setup('description'); await s.r.tick(); await s.finish(aiReviewBody(0));
    expect(s.core.getTask(s.key).status).toBe('in_review');
    await s.finish(aiReviewBody(0));
    expect(s.core.getTask(s.key)).toMatchObject({ status: 'queued', stage: 'plan' });
    expect(s.calls).toHaveLength(2);
  });
  it('rejects a malformed discussion ballot without publishing a partial review', async () => {
    const s = setup(); await s.r.tick(); await s.finish(aiReviewBody(1)); await s.finish(aiReviewBody(0));
    await s.finish('{"votes":[]}');
    expect(s.core.getTask(s.key).aiReview).toBeNull();
    expect(s.core.getTask(s.key).failure?.detail).toContain('every candidate');
  });
  it('abandons a discussion after the submission changes', async () => {
    const s = setup(); await s.r.tick(); await s.finish(aiReviewBody(1)); await s.finish(aiReviewBody(0));
    s.core.reviewRequestChanges(s.key, { feedback: 'Rework the submission' });
    s.core.claimNextTask({ workspace: 'ws', claimedBy: 'replacement' });
    s.core.submitResult(s.key, { summary: 'Replacement result' });
    await s.finish(s.vote('confirm'));
    expect(s.calls).toHaveLength(3); expect(s.core.getTask(s.key).aiReview).toBeNull();
  });
  it('waits for both cross-examinations and posts exactly one agreed review', async () => {
    const s = setup(); await s.r.tick(); await s.finish(aiReviewBody(1, 'claude')); await s.finish(aiReviewBody(0));
    expect(s.core.getTask(s.key).aiReview).toBeNull();
    expect(s.calls).toHaveLength(3);
    await s.finish(s.vote('confirm'));
    expect(s.calls.at(-1)!.req.stdin).not.toContain('a.ts:1 inspected');
    await s.finish(s.vote('confirm'));
    expect(s.core.getTask(s.key).failure).toBeNull();
    expect(s.core.getTask(s.key).aiReview).toMatchObject({ verdict: 'findings', findings: 1, consensus: { status: 'agreed' } });
    expect(s.core.getTask(s.key).activity.filter(a => a.body.startsWith('ai-review/v2'))).toHaveLength(1);
  });
  it('finishes disputes without document auto-advance or another poll retry', async () => {
    const s = setup('description'); await s.r.tick(); await s.finish(aiReviewBody(1)); await s.finish(aiReviewBody(0));
    await s.finish(s.vote('confirm')); await s.finish(s.vote('reject'));
    await s.finish(s.vote('confirm')); await s.finish(s.vote('reject'));
    expect(s.core.getTask(s.key).failure).toBeNull();
    expect(s.core.getTask(s.key)).toMatchObject({ status: 'in_review', aiReview: { verdict: 'disputed' } });
    await s.r.tick(); expect(s.calls).toHaveLength(6);
  });
  it('rejects a changed revision before final publication', async () => {
    const s = setup(); await s.r.tick(); await s.finish(aiReviewBody(0)); s.changeHead(); await s.finish(aiReviewBody(0));
    expect(s.core.getTask(s.key).aiReview).toBeNull();
  });
  it('enforces the total deadline before starting another model', async () => {
    const s = setup(); await s.r.tick(); s.setTime(31 * 60000); await s.finish(aiReviewBody(0));
    expect(s.calls).toHaveLength(1);
    expect(s.core.getTask(s.key).failure?.detail).toContain('deadline');
  });
});
