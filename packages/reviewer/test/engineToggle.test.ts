import { describe, expect, it } from 'vitest';
import { Reviewer } from '../src/reviewer.js';
import { parseConfig } from '../src/config.js';
import { aiReviewBody, makeCore, makeDeps, makeFakeConsole, makeFakeSpawn, seedInReview } from './helpers.js';

const DUAL = [
  { engine: 'claude', model: 'claude-fable-5-1' },
  { engine: 'codex', model: 'gpt-6-astra', reasoningEffort: 'medium' },
];

describe('board engine toggles → reviewer', () => {
  it('runs a two-reviewer configuration as a single Claude review while Codex is disabled', async () => {
    const core = makeCore();
    core.setEngineSettings({ codex: { enabled: false } });
    const key = seedInReview(core, 'ws', 'Solo review', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const config = parseConfig({ db: ':memory:', workspaces: ['ws'], visualization: { enabled: false }, reviewers: DUAL });
    const r = new Reviewer(config, makeDeps(core, spawn, { console: console_ }));
    await r.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(calls[0]!.req.args).toContain('claude-fable-5-1');
    expect(console_.logs.join('\n')).toContain(`${key}: codex disabled on the board; single-reviewer mode via claude`);

    calls[0]!.child.emitStdout(aiReviewBody(1, 'claude'));
    await calls[0]!.child.exit(0);
    // no second member is launched; the lone verdict posts as-is
    expect(calls).toHaveLength(1);
    expect(core.getTask(key).aiReview).toMatchObject({ findings: 1, reviewer: 'claude' });
    r.stop();
  });

  it('runs the Codex member alone (with its reasoning effort) while Claude is disabled, even under consensus', async () => {
    const core = makeCore();
    core.setEngineSettings({ claude: { enabled: false } });
    const key = seedInReview(core, 'ws', 'Solo codex', 'description');
    const { spawn, calls } = makeFakeSpawn();
    const config = parseConfig({ db: ':memory:', workspaces: ['ws'], visualization: { enabled: false }, reviewers: DUAL, consensus: { enabled: true } });
    const r = new Reviewer(config, makeDeps(core, spawn, { readOutput: () => aiReviewBody(0), console: makeFakeConsole() }));
    await r.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('codex.exe');
    expect(calls[0]!.req.args).toContain('gpt-6-astra');
    expect(calls[0]!.req.args).toContain('model_reasoning_effort="medium"');
    await calls[0]!.child.exit(0);
    expect(calls).toHaveLength(1);
    // a clean single verdict still auto-advances the document stage
    expect(core.getTask(key).stage).toBe('plan');
    r.stop();
  });

  it('single-engine config: falls back to the other engine on its default model; feedback-eval too', async () => {
    const core = makeCore();
    core.setEngineSettings({ codex: { enabled: false } });
    seedInReview(core, 'ws', 'Fallback', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const config = parseConfig({ db: ':memory:', workspaces: ['ws'], visualization: { enabled: false }, engine: 'codex', model: 'gpt-6-astra' });
    const r = new Reviewer(config, makeDeps(core, spawn, { console: console_ }));
    await r.tick();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(calls[0]!.req.args).not.toContain('gpt-6-astra'); // a Codex model name never reaches Claude
    expect(console_.logs.join('\n')).toContain('codex disabled on the board; falling back to claude for review');
    r.stop();
  });

  it('visualization falls back with the review, and everything waits while both engines are off', async () => {
    const core = makeCore();
    core.setEngineSettings({ claude: { enabled: false }, codex: { enabled: false } });
    const key = seedInReview(core, 'ws', 'Wait', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const config = parseConfig({ db: ':memory:', workspaces: ['ws'], reviewers: DUAL, visualization: { enabled: true, engine: 'codex' } });
    const r = new Reviewer(config, makeDeps(core, spawn, { console: console_ }));
    await r.tick();
    await r.tick();

    expect(calls).toHaveLength(0);
    expect(core.getTask(key).failure).toBeNull();
    expect(core.getRetryBudget(key, 'reviewer:implementation')).toBeNull();
    expect(console_.warnings.filter((w) => w.includes('all agent engines are disabled'))).toHaveLength(1);

    // Claude comes back: the viz pass (configured for Codex) runs on Claude this tick …
    core.setEngineSettings({ claude: { enabled: true } });
    await r.tick();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(console_.logs.join('\n')).toContain(`${key}: codex disabled on the board; visualizing via claude`);
    r.stop();
  });

  it('leaves a fully enabled two-reviewer round untouched', async () => {
    const core = makeCore();
    seedInReview(core, 'ws', 'Both', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const config = parseConfig({ db: ':memory:', workspaces: ['ws'], visualization: { enabled: false }, reviewers: DUAL });
    const r = new Reviewer(config, makeDeps(core, spawn, { readOutput: () => aiReviewBody(0), console: makeFakeConsole() }));
    await r.tick();
    calls[0]!.child.emitStdout(aiReviewBody(0, 'claude'));
    await calls[0]!.child.exit(0);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.req.command).toBe('codex.exe');
    r.stop();
  });
});
