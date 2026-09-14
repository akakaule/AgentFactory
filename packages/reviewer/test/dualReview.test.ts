import { describe, expect, it } from 'vitest';
import { Reviewer } from '../src/reviewer.js';
import { parseConfig } from '../src/config.js';
import { aiReviewBody, makeCore, makeDeps, makeFakeConsole, makeFakeSpawn, seedInReview } from './helpers.js';

function setup(stage: 'implementation' | 'description' = 'implementation', codexOutput = aiReviewBody(0)) {
  const core = makeCore();
  const key = seedInReview(core, 'ws', 'Two independent reviews', stage);
  const { spawn, calls } = makeFakeSpawn();
  const config = parseConfig({ db: ':memory:', workspaces: ['ws'], visualization: { enabled: false }, reviewers: [
    { engine: 'claude', model: 'claude-fable-5-1' },
    { engine: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium' },
  ] });
  const r = new Reviewer(config, makeDeps(core, spawn, { readOutput: () => codexOutput, console: makeFakeConsole() }));
  const finishClaude = async (body = aiReviewBody(0, 'claude')) => {
    calls[0]!.child.emitStdout(body);
    await calls[0]!.child.exit(0);
  };
  return { core, key, calls, r, finishClaude };
}

describe('two-model task review', () => {
  it('waits for both clean reviews before advancing a description task', async () => {
    const { core, key, calls, r, finishClaude } = setup('description');
    await r.tick();
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(calls[0]!.req.args).toContain('claude-fable-5-1');
    await finishClaude();
    expect(core.getTask(key).status).toBe('in_review');
    expect(core.getTask(key).aiReview).toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.command).toBe('codex.exe');
    expect(calls[1]!.req.args).toContain('gpt-6-astra');
    expect(calls[1]!.req.args).toContain('model_reasoning_effort="medium"');
    await calls[1]!.child.exit(0);
    expect(core.getTask(key).stage).toBe('plan');
    const comments = core.getTask(key).activity.filter((a) => a.body.startsWith('ai-review/v1'));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain('claude-fable-5-1');
    expect(comments[0]!.body).toContain('gpt-6-astra');
  });

  it.each([[1, 0], [0, 1], [1, 1]])('preserves findings from either reviewer (%i, %i)', async (claudeFindings, codexFindings) => {
    const { core, key, calls, r, finishClaude } = setup('implementation', aiReviewBody(codexFindings));
    await r.tick();
    await finishClaude(aiReviewBody(claudeFindings, 'claude'));
    await calls[1]!.child.exit(0);
    expect(core.getTask(key).aiReview?.findings).toBe(claudeFindings + codexFindings);
    expect(core.getTask(key).aiReview?.reviewer).toContain('gpt-6-astra');
    expect(core.getTask(key).status).toBe('in_review');
    await r.tick();
    expect(calls).toHaveLength(2);
  });

  it.each(['not a review', 'ai-review/v1\n```json\n{"findings":[{}],"verdict":"clean"}\n```',
    'ai-review/v1\n```json\n{"findings":[],"verdict":"findings"}\n```'])('rejects malformed output without a clean verdict: %s', async (badOutput) => {
    const { core, key, calls, r, finishClaude } = setup();
    await r.tick();
    await finishClaude(badOutput);
    expect(core.getTask(key).aiReview).toBeNull();
    expect(core.getTask(key).failure?.reason).toBe('review_failed');
    await r.tick();
    expect(calls[1]!.req.command).toBe('claude.exe');
  });

  it('retries the entire round when the second reviewer fails', async () => {
    const { core, key, calls, r, finishClaude } = setup('implementation', '');
    await r.tick();
    await finishClaude();
    await calls[1]!.child.exit(1);
    expect(core.getTask(key).aiReview).toBeNull();
    expect(core.getTask(key).failure?.reason).toBe('review_failed');
    await r.tick();
    expect(calls[2]!.req.command).toBe('claude.exe');
  });

  it('discards an old round after the task leaves review', async () => {
    const { core, key, calls, r, finishClaude } = setup();
    await r.tick();
    await finishClaude();
    core.reviewRequestChanges(key, { feedback: 'Rework first' });
    await calls[1]!.child.exit(0);
    expect(core.getTask(key).aiReview).toBeNull();
  });

  it('does not apply an old review to a newer submission of the same stage', async () => {
    const { core, key, calls, r, finishClaude } = setup();
    await r.tick();
    await finishClaude();
    core.reviewRequestChanges(key, { feedback: 'Rework first' });
    core.claimNextTask({ workspace: 'ws', claimedBy: 'worker' });
    core.submitResult(key, { summary: 'new implementation' });
    await calls[1]!.child.exit(0);
    expect(core.getTask(key).status).toBe('in_review');
    expect(core.getTask(key).aiReview).toBeNull();
    await r.tick();
    expect(calls[2]!.req.command).toBe('claude.exe');
  });

  it('keeps the concurrency slot and gives the second reviewer an independent snapshot', async () => {
    const { core, calls, r, finishClaude } = setup();
    seedInReview(core, 'ws', 'Another task');
    await r.tick();
    expect(calls).toHaveLength(1);
    await finishClaude(aiReviewBody(1, 'claude'));
    await r.tick();
    expect(calls).toHaveLength(2);
    expect(r.runningCount('ws')).toBe(1);
    expect(calls[1]!.req.stdin).toContain('Two independent reviews');
    expect(calls[1]!.req.stdin).not.toContain('finding 1');
    expect(calls[1]!.req.args).toContain('/logs/AF-1-review-r1-2-codex.out');
  });

  it('does not launch the second reviewer during shutdown', async () => {
    const { core, key, calls, r } = setup();
    await r.tick();
    calls[0]!.child.emitStdout(aiReviewBody(0, 'claude'));
    r.stop();
    await calls[0]!.child.exit(0);
    expect(calls).toHaveLength(1);
    expect(core.getTask(key).aiReview).toBeNull();
  });
});
