import { describe, it, expect } from 'vitest';
import { Dispatcher } from '../src/dispatcher.js';
import { parseConfig } from '../src/config.js';
import { makeCore, makeDeps, makeFakeSpawn, makeFakeConsole, seedQueuedStage } from './helpers.js';

// The committed-config shape: model tiering via stageArgs, which a board setting replaces.
const config = (over: Record<string, unknown> = {}) => parseConfig({
  db: ':memory:', maxConcurrent: 3,
  claudeArgs: ['--allowedTools', 'mcp__agentfactory'],
  codexArgs: ['--yolo'],
  stageArgs: { description: ['--model', 'claude-sonnet-5-5', '--verbose'], implementation: ['--model', 'claude-haiku-5-5'] },
  ...over,
});

const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('board agent model settings → dispatcher', () => {
  it('a global board stage profile replaces the stage args, after the global claudeArgs (AC1)', async () => {
    const core = makeCore();
    core.createWorkspace({ name: 'other', repoPath: '/repo/other' });
    core.setAgentModels({ global: { stages: { description: { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' } } }, workspaces: {} });
    seedQueuedStage(core, 'ws', 'Describe', 'description');
    seedQueuedStage(core, 'other', 'Describe too', 'description');
    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(config(), makeDeps(core, fake.spawn));
    await dispatcher.tick();

    expect(fake.calls).toHaveLength(2);
    for (const { req } of fake.calls) {
      const tail = req.args.slice(req.args.lastIndexOf('mcp__agentfactory') + 1);
      expect(tail).toEqual(['--model', 'claude-opus-5-5', '--effort', 'high']);
      expect(req.args).not.toContain('claude-sonnet-5-5');
      expect(req.args).not.toContain('--verbose');
    }
    dispatcher.stop();
  });

  it('a workspace override wins for that workspace only; the others keep global/file (AC2)', async () => {
    const core = makeCore();
    core.createWorkspace({ name: 'kl-dis', repoPath: '/repo/kl-dis' });
    core.setAgentModels({ global: {}, workspaces: { 'kl-dis': { stages: { implementation: { engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } } } } });
    seedQueuedStage(core, 'kl-dis', 'Build', 'implementation');
    seedQueuedStage(core, 'ws', 'Build too', 'implementation');
    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(config(), makeDeps(core, fake.spawn));
    await dispatcher.tick();

    const byWs = Object.fromEntries(fake.calls.map((c) => [c.req.env['AGENTFACTORY_WORKSPACE'], c.req.args]));
    expect(after(byWs['kl-dis']!, '--model')).toBe('claude-sonnet-5-5');
    expect(after(byWs['kl-dis']!, '--effort')).toBe('medium');
    expect(after(byWs['ws']!, '--model')).toBe('claude-haiku-5-5'); // the file's stageArgs, unchanged
    expect(byWs['ws']).not.toContain('--effort');
    dispatcher.stop();
  });

  it('a board profile can switch a stage to Codex with its own flags', async () => {
    const core = makeCore();
    core.setAgentModels({ global: { stages: { implementation: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' } } }, workspaces: {} });
    seedQueuedStage(core, 'ws', 'Build', 'implementation');
    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(config(), makeDeps(core, fake.spawn));
    await dispatcher.tick();

    const { req } = fake.calls[0]!;
    expect(req.command).toBe('codex.exe');
    expect(req.args.slice(-6)).toEqual(['--yolo', '-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', '-']);
    expect(req.args).not.toContain('claude-haiku-5-5');
    dispatcher.stop();
  });

  it('a board profile whose engine is off runs on the other engine at its default model (AC5)', async () => {
    const core = makeCore();
    core.setEngineSettings({ codex: { enabled: false } });
    core.setAgentModels({ global: { stages: { implementation: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' } } }, workspaces: {} });
    const key = seedQueuedStage(core, 'ws', 'Build', 'implementation');
    const fake = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const dispatcher = new Dispatcher(config(), makeDeps(core, fake.spawn, { console: console_ }));
    await dispatcher.tick();

    const { req } = fake.calls[0]!;
    expect(req.command).toBe('claude.exe');
    expect(req.args).not.toContain('--model');
    expect(req.args).not.toContain('--effort');
    expect(req.args).not.toContain('gpt-6.1-sol');
    expect(console_.logs.join('\n')).toContain(`${key}: codex is disabled on the board; falling back to claude`);
    dispatcher.stop();
  });

  it('a saved change applies to the next session without a restart (AC8)', async () => {
    const core = makeCore();
    seedQueuedStage(core, 'ws', 'First', 'implementation');
    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(config(), makeDeps(core, fake.spawn));
    await dispatcher.tick();
    expect(after(fake.calls[0]!.req.args, '--model')).toBe('claude-haiku-5-5');
    await fake.calls[0]!.child.exit(0);

    core.setAgentModels({ global: { stages: { implementation: { engine: 'claude', model: 'claude-opus-5-5', effort: 'medium' } } }, workspaces: {} });
    seedQueuedStage(core, 'ws', 'Second', 'implementation');
    await dispatcher.tick();
    const last = fake.calls.at(-1)!.req.args;
    expect(after(last, '--model')).toBe('claude-opus-5-5');
    expect(after(last, '--effort')).toBe('medium');
    dispatcher.stop();
  });

  it('a failed settings read keeps the previous answer', async () => {
    const core = makeCore();
    core.setAgentModels({ global: { stages: { implementation: { engine: 'claude', model: 'claude-opus-5-5' } } }, workspaces: {} });
    const fake = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const dispatcher = new Dispatcher(config(), makeDeps(core, fake.spawn, { console: console_ }));
    await dispatcher.tick();
    core.getAgentModels = () => { throw new Error('board down'); };
    seedQueuedStage(core, 'ws', 'Build', 'implementation');
    await dispatcher.tick();
    expect(after(fake.calls[0]!.req.args, '--model')).toBe('claude-opus-5-5');
    expect(console_.warnings.join('\n')).toContain('could not read agent model settings');
    dispatcher.stop();
  });

  it('reports its config-file defaults once, parsed from global + stage args (§6)', async () => {
    const core = makeCore();
    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(config({
      name: 'dispatcher-a', stageEngines: { plan: 'codex' },
      stageArgs: { description: ['--model', 'claude-sonnet-5-5', '--verbose'], plan: ['-m', 'gpt-6-sol'] },
    }), makeDeps(core, fake.spawn));
    await dispatcher.tick();
    await dispatcher.tick();
    const report = core.getAgentModelDefaults()['dispatcher-a']!;
    expect(report.kind).toBe('dispatcher');
    expect(report.roles.stages).toEqual({
      description: { engine: 'claude', model: 'claude-sonnet-5-5', extraArgs: ['--verbose'] },
      plan: { engine: 'codex', model: 'gpt-6-sol' },
      implementation: { engine: 'claude' },
    });
    dispatcher.stop();
  });
});
