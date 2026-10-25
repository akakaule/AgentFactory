import { describe, it, expect } from 'vitest';
import { intakeRevision, type IntakeAssessmentV1 } from '@agentfactory/core';
import { Dispatcher } from '../src/dispatcher.js';
import { makeCore, makeConfig, makeDeps, makeFakeSpawn, makeFakeConsole } from './helpers.js';

const CLEAN_REVIEW = 'ai-review/v1 - clean (codex)\nok\n```json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n```';
const assessment = (key: string, revision: string): IntakeAssessmentV1 => ({
  schema: 'intake/v1', status: 'unavailable', taskKey: key, sourceRevision: revision, attemptId: null, stage: 'implementation',
  questionSet: 'intake-questions/v1', provider: { name: 'fixture', model: 'fixture-v1' },
  usage: { inputTokens: null, outputTokens: null }, assessedAt: '2026-10-23T00:00:00.000Z', latencyMs: 1,
  error: { kind: 'timeout', detail: 'provider timed out' },
});

describe('intake pending hold → dispatcher', () => {
  it('does not spawn (or spend an attempt on) a task held for its intake assessment, and spawns once it lands', async () => {
    const core = makeCore();
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['ws'] });
    const t = core.createTask({ title: 'Feature', spec: 'intent', stage: 'description', workspace: 'ws' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'writer' });
    core.submitResult(t.key, { summary: 'spec', spec: 'the written spec', acceptanceCriteria: 'AC1' });
    core.addComment(t.key, { actor: 'agent', body: CLEAN_REVIEW });
    expect(core.getTask(t.key).intakeHold).not.toBeNull();

    const fake = makeFakeSpawn();
    const console_ = makeFakeConsole();
    const dispatcher = new Dispatcher(makeConfig(), makeDeps(core, fake.spawn, { console: console_ }));
    await dispatcher.tick();
    await dispatcher.tick();
    expect(fake.calls).toHaveLength(0);
    expect(core.getRetryBudget(t.key, 'dispatcher:implementation')).toBeNull();
    expect(console_.logs.filter((l) => l.includes(`${t.key}: waiting for its intake assessment`))).toHaveLength(1); // once, not per tick

    core.recordIntakeAssessment(t.key, assessment(t.key, intakeRevision(core.getTask(t.key))));
    await dispatcher.tick();
    expect(fake.calls).toHaveLength(1);
    dispatcher.stop();
  });

  it('skip-spec: never spawns a spec writer for a simple task — the first spawn is implementation', async () => {
    const core = makeCore();
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['ws'], skipSpec: true });
    const t = core.createTask({ title: 'Fix typo', spec: 'teh → the', stage: 'description', workspace: 'ws' });
    core.updateStatus(t.key, 'queued', 'human');

    const fake = makeFakeSpawn();
    const dispatcher = new Dispatcher(makeConfig(), makeDeps(core, fake.spawn, { console: makeFakeConsole() }));
    await dispatcher.tick();
    expect(fake.calls).toHaveLength(0); // held: intake decides first
    expect(core.getRetryBudget(t.key, 'dispatcher:description')).toBeNull();

    core.recordIntakeAssessment(t.key, {
      schema: 'intake/v1', status: 'assessed', taskKey: t.key, sourceRevision: intakeRevision(core.getTask(t.key)), attemptId: null, stage: 'description',
      questionSet: 'intake-questions/v1', provider: { name: 'fixture', model: 'fixture-v1' }, usage: { inputTokens: null, outputTokens: null },
      assessedAt: '2026-10-25T00:00:00.000Z', latencyMs: 1,
      decisions: {
        readiness: { probability: 0.95, parts: { outcomeClear: 0.95, scopeBounded: 0.95 } },
        complexity: { value: 'trivial', probabilities: { trivial: 0.8, small: 0.15, medium: 0.03, large: 0.01, architectural: 0.01 }, confidence: null },
        risk: { value: 'low', probabilities: { low: 0.9, medium: 0.08, high: 0.01, critical: 0.01 }, confidence: null },
      },
    });
    await dispatcher.tick();
    expect(fake.calls).toHaveLength(1);
    expect(core.getRetryBudget(t.key, 'dispatcher:description')).toBeNull();
    expect(core.getTask(t.key).stage).toBe('implementation');
    dispatcher.stop();
  });
});
