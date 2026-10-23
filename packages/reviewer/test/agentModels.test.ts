import { describe, expect, it } from 'vitest';
import { openCore } from '@agentfactory/core';
import { Reviewer } from '../src/reviewer.js';
import { parseConfig } from '../src/config.js';
import { aiReviewBody, makeCore, makeDeps, makeFakeConsole, makeFakeSpawn, seedInReview } from './helpers.js';

// The file default: one Codex review on its default model.
const fileConfig = (over: Record<string, unknown> = {}) =>
  parseConfig({ db: ':memory:', visualization: { enabled: false }, engine: 'codex', ...over });

const BOARD_REVIEWERS = [
  { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' },
  { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' },
] as const;

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('board agent model settings → reviewer', () => {
  it('runs the board reviewer list with each profile\'s flags and posts one combined verdict (AC4)', async () => {
    const core = makeCore();
    core.setAgentModels({ global: { reviewers: [...BOARD_REVIEWERS] }, workspaces: {} });
    const key = seedInReview(core, 'ws', 'Two reviews', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(fileConfig(), makeDeps(core, spawn, { readOutput: () => aiReviewBody(0), console: makeFakeConsole() }));
    await r.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('codex.exe');
    const codex = calls[0]!.req.args;
    expect(codex.slice(codex.indexOf('-m'), codex.indexOf('-m') + 4)).toEqual(['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"']);
    await calls[0]!.child.exit(0);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.command).toBe('claude.exe');
    expect(after(calls[1]!.req.args, '--model')).toBe('claude-opus-5-5');
    expect(after(calls[1]!.req.args, '--effort')).toBe('high');
    calls[1]!.child.emitStdout(aiReviewBody(0, 'claude'));
    await calls[1]!.child.exit(0);

    const reviews = core.getTask(key).activity.filter((a) => a.type === 'comment' && a.body.startsWith('ai-review/v1'));
    expect(reviews).toHaveLength(1);
    r.stop();
  });

  it('a workspace reviewer list replaces the global one for that workspace only', async () => {
    const core = makeCore();
    core.createWorkspace({ name: 'kl-dis', repoPath: '/repo/kl-dis' });
    core.setAgentModels({ global: { reviewers: [...BOARD_REVIEWERS] }, workspaces: { 'kl-dis': { reviewers: [{ engine: 'claude', model: 'claude-sonnet-5-5' }] } } });
    seedInReview(core, 'kl-dis', 'Solo', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const r = new Reviewer(fileConfig({ workspaces: ['kl-dis'] }), makeDeps(core, spawn, { console: console_ }));
    await r.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(after(calls[0]!.req.args, '--model')).toBe('claude-sonnet-5-5');
    expect(console_.logs.join('\n')).not.toContain('disabled on the board'); // a one-reviewer list, nothing switched off
    calls[0]!.child.emitStdout(aiReviewBody(0, 'claude'));
    await calls[0]!.child.exit(0);
    expect(calls).toHaveLength(1);
    r.stop();
  });

  it('skips a board reviewer whose engine is off; the other reviews alone (AC5)', async () => {
    const core = makeCore();
    core.setEngineSettings({ codex: { enabled: false } });
    core.setAgentModels({ global: { reviewers: [...BOARD_REVIEWERS] }, workspaces: {} });
    const key = seedInReview(core, 'ws', 'Solo', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const r = new Reviewer(fileConfig(), makeDeps(core, spawn, { console: console_ }));
    await r.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(after(calls[0]!.req.args, '--effort')).toBe('high');
    expect(console_.logs.join('\n')).toContain(`${key}: codex disabled on the board; single-reviewer mode via claude`);
    r.stop();
  });

  // With findings from one member, a consensus round launches a cross-examination after both
  // discoveries; without it, the combined verdict posts after the second.
  const runRound = async (board: Record<string, unknown>, file: Record<string, unknown> = {}) => {
    const core = makeCore();
    core.setAgentModels({ global: board, workspaces: {} });
    const key = seedInReview(core, 'ws', 'Round', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const r = new Reviewer(fileConfig(file), makeDeps(core, spawn, {
      console: console_, readOutput: () => aiReviewBody(1),
      computeDiff: async () => ({ baseRef: 'main', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), diff: '+x', commits: 1 }),
    }));
    await r.tick();
    await calls[0]!.child.exit(0);
    calls[1]!.child.emitStdout(aiReviewBody(0, 'claude'));
    await calls[1]!.child.exit(0);
    r.stop();
    return { calls, console_, review: core.getTask(key).aiReview };
  };

  it('board consensus runs the discussion round without a consensus block in the file', async () => {
    const { calls, console_, review } = await runRound({ reviewers: [...BOARD_REVIEWERS], consensus: true });
    expect(calls).toHaveLength(3); // cross-examination
    expect(review).toBeNull();
    expect(console_.errors).toEqual([]);
  });

  it('board consensus: false turns off a file-enabled round', async () => {
    const { calls, review } = await runRound({ consensus: false },
      { consensus: { enabled: true }, reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol' }, { engine: 'claude', model: 'claude-opus-5-5' }] });
    expect(calls).toHaveLength(2);
    expect(review).not.toBeNull();
  });

  it('visualization uses the board profile, and drops model + effort on fallback', async () => {
    const core = makeCore();
    core.setAgentModels({ global: { visualization: { engine: 'claude', model: 'claude-haiku-5-5', effort: 'low' } }, workspaces: {} });
    seedInReview(core, 'ws', 'Viz', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(fileConfig({ visualization: { enabled: true } }), makeDeps(core, spawn, { console: makeFakeConsole() }));
    await r.tick();
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(after(calls[0]!.req.args, '--model')).toBe('claude-haiku-5-5');
    expect(after(calls[0]!.req.args, '--effort')).toBe('low');
    r.stop();

    const core2 = makeCore();
    core2.setEngineSettings({ claude: { enabled: false } });
    core2.setAgentModels({ global: { visualization: { engine: 'claude', model: 'claude-haiku-5-5', effort: 'low' } }, workspaces: {} });
    seedInReview(core2, 'ws', 'Viz', 'implementation');
    const fake2 = makeFakeSpawn();
    const r2 = new Reviewer(fileConfig({ visualization: { enabled: true } }), makeDeps(core2, fake2.spawn, { console: makeFakeConsole() }));
    await r2.tick();
    expect(fake2.calls[0]!.req.command).toBe('codex.exe');
    expect(fake2.calls[0]!.req.args).not.toContain('claude-haiku-5-5');
    expect(fake2.calls[0]!.req.args.join(' ')).not.toContain('model_reasoning_effort');
    r2.stop();
  });

  it('feedback evaluation uses the board profile', async () => {
    const core = openCore(':memory:', { resolveOrigin: () => 'https://github.com/o/r' });
    core.createWorkspace({ name: 'ws', repoPath: '/repo/ws' });
    core.setAgentModels({ global: { feedbackEval: { engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } }, workspaces: {} });
    const key = seedInReview(core, 'ws', 'Delivered', 'implementation');
    core.reviewApprove(key);
    core.addPrFeedback(key, { feedback: 'missing guard' });
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(fileConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));
    await r.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(after(calls[0]!.req.args, '--model')).toBe('claude-sonnet-5-5');
    expect(after(calls[0]!.req.args, '--effort')).toBe('medium');
    r.stop();
  });

  it('reports its config-file defaults to the board', async () => {
    const core = makeCore();
    const { spawn } = makeFakeSpawn();
    const config = fileConfig({ name: 'reviewer-a', model: 'gpt-6-astra', visualization: { enabled: true, engine: 'claude' },
      reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' }, { engine: 'claude', model: 'claude-opus-5-5' }] });
    const r = new Reviewer(config, makeDeps(core, spawn, { console: makeFakeConsole() }));
    await r.tick();
    expect(core.getAgentModelDefaults()['reviewer-a']).toMatchObject({
      kind: 'reviewer',
      roles: {
        reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { engine: 'claude', model: 'claude-opus-5-5' }],
        consensus: false,
        visualization: { engine: 'claude' },
        feedbackEval: { engine: 'codex', model: 'gpt-6-astra' },
      },
    });
    r.stop();
  });
});
