import { describe, it, expect } from 'vitest';
import { Dispatcher } from '../src/dispatcher.js';
import { parseConfig } from '../src/config.js';
import { makeCore, makeDeps, makeFakeSpawn, makeFakeConsole, seedQueuedStage } from './helpers.js';

const codexConfig = (over: Record<string, unknown> = {}) => parseConfig({
  db: ':memory:', workspaces: ['ws'], maxConcurrent: 3,
  claudeArgs: ['--model', 'sonnet'],
  codexArgs: ['--yolo'],
  stageEngines: { implementation: 'codex' },
  stageArgs: { implementation: ['--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="high"'] },
  ...over,
});

describe('board engine toggles → dispatcher fallback', () => {
  it('runs a Codex stage on Claude with Claude args only while Codex is disabled on the board', async () => {
    const core = makeCore();
    core.setEngineSettings({ codex: { enabled: false } });
    const key = seedQueuedStage(core, 'ws', 'Implement', 'implementation');
    const fake = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const deps = { ...makeDeps(core, fake.spawn, { console: console_ }), resolveCodex: () => ({ command: 'codex.exe', args: [] }) };
    const dispatcher = new Dispatcher(codexConfig(), deps);
    await dispatcher.tick();

    expect(fake.calls).toHaveLength(1);
    const req = fake.calls[0]!.req;
    expect(req.command).toBe('claude.exe');
    expect(req.args).toContain('sonnet');
    // the Codex-tier stage args must not leak into the fallback engine's argv
    expect(req.args).not.toContain('gpt-5.6-luna');
    expect(req.args.join(' ')).not.toContain('model_reasoning_effort');
    expect(req.args).not.toContain('--yolo');
    expect(req).not.toHaveProperty('stdin');
    expect(console_.logs.join('\n')).toContain(`${key}: codex is disabled on the board; falling back to claude`);
    dispatcher.stop();
  });

  it('runs a Claude stage on Codex with Codex args only while Claude is disabled', async () => {
    const core = makeCore();
    core.setEngineSettings({ claude: { enabled: false } });
    seedQueuedStage(core, 'ws', 'Describe', 'description');
    const fake = makeFakeSpawn();
    const deps = { ...makeDeps(core, fake.spawn), resolveCodex: () => ({ command: 'codex.exe', args: [] }) };
    const dispatcher = new Dispatcher(codexConfig({ stageArgs: { description: ['--model', 'opus'] } }), deps);
    await dispatcher.tick();

    const req = fake.calls[0]!.req;
    expect(req.command).toBe('codex.exe');
    expect(req.args).toContain('--yolo');
    expect(req.args).not.toContain('opus');
    expect(req.args).not.toContain('sonnet');
    expect(req).toHaveProperty('stdin', expect.stringContaining('get_next_task'));
    dispatcher.stop();
  });

  it('leaves tasks queued without burning an attempt while both engines are disabled, and resumes when one returns', async () => {
    const core = makeCore();
    core.setEngineSettings({ claude: { enabled: false }, codex: { enabled: false } });
    const key = seedQueuedStage(core, 'ws', 'Implement', 'implementation');
    const fake = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const dispatcher = new Dispatcher(codexConfig(), makeDeps(core, fake.spawn, { console: console_ }));
    await dispatcher.tick();
    await dispatcher.tick();

    expect(fake.calls).toHaveLength(0);
    expect(core.getTask(key).status).toBe('queued');
    expect(core.getTask(key).failure).toBeNull();
    expect(core.getRetryBudget(key, 'dispatcher:implementation')).toBeNull();
    expect(console_.warnings.filter((w) => w.includes('all agent engines are disabled')).length).toBe(1); // warned once, not per tick

    // the operator flips Claude back on: the very next tick spawns (settings are re-read per tick)
    core.setEngineSettings({ claude: { enabled: true } });
    await dispatcher.tick();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.req.command).toBe('claude.exe');
    dispatcher.stop();
  });

  it('keeps the configured engine untouched when it is enabled', async () => {
    const core = makeCore();
    core.setEngineSettings({ claude: { enabled: false } }); // irrelevant to a Codex stage
    seedQueuedStage(core, 'ws', 'Implement', 'implementation');
    const fake = makeFakeSpawn();
    const deps = { ...makeDeps(core, fake.spawn), resolveCodex: () => ({ command: 'codex.exe', args: [] }) };
    const dispatcher = new Dispatcher(codexConfig(), deps);
    await dispatcher.tick();
    expect(fake.calls[0]!.req.command).toBe('codex.exe');
    expect(fake.calls[0]!.req.args).toContain('gpt-5.6-luna');
    dispatcher.stop();
  });
});
