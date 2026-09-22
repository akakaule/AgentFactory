import { describe, it, expect } from 'vitest';
import { Dispatcher } from '../src/dispatcher.js';
import { parseConfig } from '../src/config.js';
import { makeCore, makeDeps, makeFakeSpawn, seedQueuedStage } from './helpers.js';

describe('stage engine selection', () => {
  it('preserves stage engines and rejects misspelled configuration', () => {
    const cfg = parseConfig({ db: ':memory:', stageEngines: { plan: 'codex', implementation: 'codex' } });
    expect(cfg).toHaveProperty('stageEngines.plan', 'codex');
    expect(() => parseConfig({ db: 'x', stageEngines: { implementation: 'unknown' } })).toThrow();
    expect(() => parseConfig({ db: 'x', stageEngine: { plan: 'codex' } })).toThrow();
  });

  it('launches the requested Codex models without Claude args and keeps description on Claude', async () => {
    const core = makeCore();
    {
      const plan = seedQueuedStage(core, 'ws', 'Plan', 'plan');
      const implementation = seedQueuedStage(core, 'ws', 'Implement', 'implementation');
      seedQueuedStage(core, 'ws', 'Describe', 'description');
      const cfg = parseConfig({
        db: ':memory:', workspaces: ['ws'], maxConcurrent: 3,
        claudeArgs: ['--model', 'sonnet'],
        stageEngines: { plan: 'codex', implementation: 'codex' },
        stageArgs: {
          plan: ['--model', 'gpt-6-astra', '-c', 'model_reasoning_effort="medium"'],
          implementation: ['--model', 'gpt-5.6-luna', '-c', 'model_reasoning_effort="high"'],
        },
      });
      const fake = makeFakeSpawn();
      const deps = { ...makeDeps(core, fake.spawn), resolveCodex: () => ({ command: 'codex.exe', args: [] }) };
      const dispatcher = new Dispatcher(cfg, deps);
      await dispatcher.tick();
      const requests = fake.calls.map(c => c.req);
      expect(requests[0]?.command).toBe('codex.exe');
      expect(requests[0]?.args).toContain('gpt-6-astra');
      expect(requests[0]?.args).toContain('model_reasoning_effort="medium"');
      expect(requests[0]?.args.join(' ')).toContain(`AGENTFACTORY_TASK_KEY="${plan}"`);
      expect(requests[0]?.args.join(' ')).toContain('AGENTFACTORY_STAGE="plan"');
      expect(requests[0]?.args).not.toContain('sonnet');
      expect(requests[0]?.args).not.toContain('--permission-mode');
      expect(requests[0]).toHaveProperty('stdin', expect.stringContaining('get_next_task'));
      expect(requests[1]?.args).toContain('gpt-5.6-luna');
      expect(requests[1]?.args).toContain('model_reasoning_effort="high"');
      expect(requests[1]?.args.join(' ')).toContain(`AGENTFACTORY_TASK_KEY="${implementation}"`);
      expect(requests[2]?.command).toBe('claude.exe');
      expect(requests[2]?.args).toContain('sonnet');
      dispatcher.stop();
    }
  });

  it('bounds Codex failures before claim even when the CLI exits zero', async () => {
    const core = makeCore();
    const key = seedQueuedStage(core, 'ws', 'Plan', 'plan');
    const cfg = parseConfig({ db: ':memory:', workspaces: ['ws'], maxAttempts: 2, stageEngines: { plan: 'codex' } });
    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(cfg, makeDeps(core, fake.spawn));
    await dispatcher.tick();
    for (let i = 0; i < 2; i++) {
      fake.calls[i]!.child.emitStdout(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', error: { message: 'approval required' } } }) + '\n');
      await fake.calls[i]!.child.exit(0);
      await dispatcher.tick();
    }
    expect(fake.calls).toHaveLength(2);
    expect(core.getTask(key).failure).toMatchObject({ skipListed: true, attempt: 2 });
  });

  it('records Codex usage and transcript on submission, and retries a crashed claimed worker', async () => {
    const core = makeCore();
    const key = seedQueuedStage(core, 'ws', 'Plan', 'plan');
    const cfg = parseConfig({ db: ':memory:', workspaces: ['ws'], stageEngines: { plan: 'codex' } });
    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(cfg, makeDeps(core, fake.spawn));
    await dispatcher.tick();
    core.claimNextTask({ taskKey: key, stage: 'plan', claimedBy: fake.calls[0]!.req.env['AGENTFACTORY_WORKER'] });
    await fake.calls[0]!.child.exit(1);
    await dispatcher.tick();
    expect(fake.calls).toHaveLength(2);
    core.claimNextTask({ taskKey: key, stage: 'plan', claimedBy: fake.calls[1]!.req.env['AGENTFACTORY_WORKER'] });
    fake.calls[1]!.child.emitStdout(JSON.stringify({ type: 'item.completed', item: { id: '1', type: 'agent_message', text: 'Plan delivered' } }) + '\n');
    fake.calls[1]!.child.emitStdout(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 120, cached_input_tokens: 30, output_tokens: 20 } }) + '\n');
    core.submitResult(key, { summary: 'Done', plan: 'Steps' });
    await fake.calls[1]!.child.exit(0);
    expect(core.getTask(key).status).toBe('in_review');
    expect(core.getTask(key).metrics.tokensIn).toBe(120);
    expect(core.getTranscript(key)).toMatchObject({ engine: 'codex', state: 'final', blocks: [expect.objectContaining({ text: 'Plan delivered' })] });
  });
});
