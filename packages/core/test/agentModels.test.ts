import { describe, it, expect } from 'vitest';
import { openCore, ValidationError } from '../src/index.js';
import {
  resolveAgentModel, resolveReviewers, profileFromArgs, modelProfileArgs, normalizeAgentModels, MODEL_CATALOG,
  type AgentModels,
} from '../src/agentModels.js';

const empty = (): AgentModels => ({ global: {}, workspaces: {} });

describe('agent model settings: storage + validation', () => {
  it('reads empty when nothing is stored, and round-trips a full document', () => {
    const core = openCore(':memory:');
    expect(core.getAgentModels()).toEqual(empty());
    core.createWorkspace({ name: 'kl-dis', repoPath: '/r' });
    const doc = {
      global: {
        stages: { description: { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }, implementation: { engine: 'claude', model: 'claude-opus-5-5', effort: 'medium' } },
        reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }],
        consensus: true,
        visualization: { engine: 'claude' },
        feedbackEval: { engine: 'codex', model: 'gpt-6-luna' },
      },
      workspaces: { 'kl-dis': { stages: { implementation: { engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } } } },
    };
    expect(core.setAgentModels(doc)).toEqual(doc);
    expect(core.getAgentModels()).toEqual(doc);
  });

  it('a save replaces the whole document (clearing a key falls back to the file)', () => {
    const core = openCore(':memory:');
    core.setAgentModels({ global: { stages: { description: { engine: 'claude' } }, consensus: false }, workspaces: {} });
    core.setAgentModels({ global: { consensus: true }, workspaces: {} });
    expect(core.getAgentModels()).toEqual({ global: { consensus: true }, workspaces: {} });
  });

  it('accepts the documented model id shapes', () => {
    const core = openCore(':memory:');
    for (const model of ['claude-opus-5-5', 'gpt-6.1-sol', 'claude-opus-5-5[1m]', 'vendor:model_v2']) {
      expect(() => core.setAgentModels({ global: { visualization: { engine: 'claude', model } }, workspaces: {} })).not.toThrow();
    }
  });

  it('rejects unsafe model ids, unknown efforts, bad reviewer lists, unknown workspaces and keys', () => {
    const core = openCore(':memory:');
    core.createWorkspace({ name: 'repo-a', repoPath: '/r' });
    const bad: unknown[] = [
      ...['has space', 'quo"te', "quo'te", 'a&b', 'a|b', '%PATH%', 'a^b', 'line\nbreak', 'a=b', 'a;b', '-leading', ''].map((model) =>
        ({ global: { stages: { description: { engine: 'claude', model } } }, workspaces: {} })),
      { global: { stages: { description: { engine: 'claude', effort: 'ultra' } } }, workspaces: {} },
      { global: { stages: { description: { engine: 'gemini' } } }, workspaces: {} },
      { global: { reviewers: [] }, workspaces: {} },
      { global: { reviewers: [{ engine: 'claude' }, { engine: 'codex' }, { engine: 'claude', model: 'a' }, { engine: 'claude', model: 'b' }, { engine: 'claude', model: 'c' }] }, workspaces: {} },
      { global: { reviewers: [{ engine: 'codex', model: 'gpt-6-sol', effort: 'high' }, { engine: 'codex', model: 'gpt-6-sol', effort: 'low' }] }, workspaces: {} },
      { global: {}, workspaces: { 'no-such-ws': { stages: { description: { engine: 'claude' } } } } },
      { global: { stages: { description: { engine: 'claude', args: ['--x'] } } }, workspaces: {} },
      { global: { typo: true }, workspaces: {} },
      { global: {}, workspaces: { 'repo-a': { consensus: true } } },
      { global: {}, workspaces: {}, extra: 1 },
      { global: {} },
    ];
    for (const doc of bad) expect(() => core.setAgentModels(doc), JSON.stringify(doc)).toThrow(ValidationError);
    expect(core.getAgentModels()).toEqual(empty());
  });

  it('a corrupt or no-longer-valid stored document reads as empty', () => {
    const core = openCore(':memory:');
    core.setKv('agent_models', '{not json');
    expect(core.getAgentModels()).toEqual(empty());
    core.setKv('agent_models', JSON.stringify({ global: { stages: { description: { engine: 'claude', model: 'bad id' } } }, workspaces: {} }));
    expect(core.getAgentModels()).toEqual(empty());
    expect(normalizeAgentModels(null)).toEqual(empty());
  });

  it('drops overrides for workspaces that no longer exist on read, and empty layers on save', () => {
    const core = openCore(':memory:');
    core.createWorkspace({ name: 'repo-a', repoPath: '/r' });
    core.setKv('agent_models', JSON.stringify({ global: {}, workspaces: { gone: { stages: { description: { engine: 'codex' } } }, 'repo-a': { feedbackEval: { engine: 'codex' } } } }));
    expect(core.getAgentModels()).toEqual({ global: {}, workspaces: { 'repo-a': { feedbackEval: { engine: 'codex' } } } });
    expect(core.setAgentModels({ global: { stages: {} }, workspaces: { 'repo-a': {} } })).toEqual(empty());
  });

  it('the catalogue lists both engines for the dropdowns', () => {
    expect(MODEL_CATALOG.filter((m) => m.engine === 'claude').map((m) => m.id)).toContain('claude-opus-5-5');
    expect(MODEL_CATALOG.filter((m) => m.engine === 'codex').map((m) => m.id)).toContain('gpt-6.1-sol');
  });
});

describe('agent model settings: precedence', () => {
  const doc: AgentModels = {
    global: {
      stages: { description: { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }, implementation: { engine: 'claude', model: 'claude-opus-5-5', effort: 'medium' } },
      reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }],
    },
    workspaces: {
      'kl-dis': { stages: { implementation: { engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, description: { engine: 'codex' } }, reviewers: [{ engine: 'claude' }] },
    },
  };

  it('workspace override → board global → file default → null', () => {
    expect(resolveAgentModel(doc, 'implementation', 'kl-dis')).toEqual({ engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' });
    expect(resolveAgentModel(doc, 'implementation', 'other')).toEqual({ engine: 'claude', model: 'claude-opus-5-5', effort: 'medium' });
    expect(resolveAgentModel(doc, 'visualization', 'other')).toBeNull();
    expect(resolveAgentModel(doc, 'visualization', 'other', { engine: 'codex', model: 'gpt-6-sol' })).toEqual({ engine: 'codex', model: 'gpt-6-sol' });
    expect(resolveAgentModel(empty(), 'description', 'x')).toBeNull();
  });

  it('an unset plan stage uses the description profile, layer by layer', () => {
    expect(resolveAgentModel(doc, 'plan', 'kl-dis')).toEqual({ engine: 'codex' });
    expect(resolveAgentModel(doc, 'plan', 'other')).toEqual({ engine: 'claude', model: 'claude-opus-5-5', effort: 'high' });
    const withPlan: AgentModels = { global: { stages: { plan: { engine: 'codex', model: 'gpt-6-astra' }, description: { engine: 'claude' } } }, workspaces: { w: { stages: { description: { engine: 'claude', model: 'x' } } } } };
    expect(resolveAgentModel(withPlan, 'plan', 'w')).toEqual({ engine: 'claude', model: 'x' });
    expect(resolveAgentModel(withPlan, 'plan', 'other')).toEqual({ engine: 'codex', model: 'gpt-6-astra' });
  });

  it('the reviewer list is replaced whole: workspace → global → file', () => {
    expect(resolveReviewers(doc, 'kl-dis')).toEqual([{ engine: 'claude' }]);
    expect(resolveReviewers(doc, 'other')).toEqual([{ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
    const file = [{ engine: 'codex' as const }];
    expect(resolveReviewers(empty(), 'other', file)).toBe(file);
    expect(resolveReviewers(empty(), 'other')).toBeNull();
  });
});

describe('agent model settings: CLI flags', () => {
  it('builds the engine flags for a profile (unset fields add nothing)', () => {
    expect(modelProfileArgs({ engine: 'claude', model: 'claude-opus-5-5', effort: 'high' })).toEqual(['--model', 'claude-opus-5-5', '--effort', 'high']);
    expect(modelProfileArgs({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' })).toEqual(['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"']);
    expect(modelProfileArgs({ engine: 'claude' })).toEqual([]);
    expect(modelProfileArgs({ engine: 'codex', effort: 'low' })).toEqual(['-c', 'model_reasoning_effort="low"']);
  });

  it('parses a file profile back out of args — last value wins, the rest is extra', () => {
    expect(profileFromArgs('claude', ['--model', 'claude-sonnet-5-5', '--allowedTools', 'x'], ['--model', 'claude-opus-5-5', '--effort', 'high', '--verbose']))
      .toEqual({ engine: 'claude', model: 'claude-opus-5-5', effort: 'high', extraArgs: ['--verbose'] });
    expect(profileFromArgs('claude', ['--model=claude-haiku-5-5'], [])).toEqual({ engine: 'claude', model: 'claude-haiku-5-5' });
    expect(profileFromArgs('codex', ['-m', 'gpt-6-sol'], ['--model', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="xhigh"']))
      .toEqual({ engine: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' });
    expect(profileFromArgs('codex', [], ['-c', 'model_reasoning_effort=low', '-c', 'other=1']))
      .toEqual({ engine: 'codex', effort: 'low', extraArgs: ['-c', 'other=1'] });
    expect(profileFromArgs('codex', [], [])).toEqual({ engine: 'codex' });
  });
});

describe('agent model defaults report', () => {
  it('stores each supervisor\'s report with its arrival time', () => {
    const core = openCore(':memory:');
    expect(core.getAgentModelDefaults()).toEqual({});
    core.reportAgentModelDefaults({ supervisor: 'dispatcher', kind: 'dispatcher', roles: { stages: { implementation: { engine: 'claude', model: 'claude-opus-5-5', extraArgs: ['--verbose'] } } } });
    core.reportAgentModelDefaults({ supervisor: 'reviewer', kind: 'reviewer', roles: { reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }], consensus: false } });
    const got = core.getAgentModelDefaults();
    expect(Object.keys(got).sort()).toEqual(['dispatcher', 'reviewer']);
    expect(got['dispatcher']!.roles.stages?.implementation?.model).toBe('claude-opus-5-5');
    expect(typeof got['reviewer']!.at).toBe('string');
  });

  it('rejects a malformed report and reads a corrupt store as empty', () => {
    const core = openCore(':memory:');
    expect(() => core.reportAgentModelDefaults({ supervisor: '', kind: 'dispatcher', roles: {} })).toThrow(ValidationError);
    expect(() => core.reportAgentModelDefaults({ supervisor: 'x', kind: 'watcher', roles: {} })).toThrow(ValidationError);
    core.setKv('agent_model_defaults', 'nope');
    expect(core.getAgentModelDefaults()).toEqual({});
  });
});
