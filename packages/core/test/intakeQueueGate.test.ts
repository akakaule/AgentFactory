import { describe, expect, it } from 'vitest';
import { createCore, intakeQueueGate, intakeRevision, normalizeIntakeSettings, type IntakeAssessmentV1, type IntakeSettings, type IntakeSummary } from '../src/index.js';
import { defaultIntakeSettings } from '../src/intakeSettings.js';
import { makeTestDb } from './helpers.js';

function assessed(key: string, revision: string, readiness = 0.4): IntakeAssessmentV1 {
  return {
    schema: 'intake/v1', status: 'assessed', taskKey: key, sourceRevision: revision, attemptId: null, stage: 'implementation',
    questionSet: 'intake-questions/v1', provider: { name: 'fixture', model: 'fixture-v1' },
    usage: { inputTokens: null, outputTokens: null }, assessedAt: '2026-10-28T00:00:00.000Z', latencyMs: 1,
    decisions: {
      readiness: { probability: readiness, parts: { outcomeClear: readiness, scopeBounded: 0.9, verifiable: 0.9 } },
      complexity: { value: 'medium', probabilities: { trivial: 0.02, small: 0.08, medium: 0.7, large: 0.15, architectural: 0.05 }, confidence: null },
      risk: { value: 'low', probabilities: { low: 0.75, medium: 0.18, high: 0.06, critical: 0.01 }, confidence: null },
    },
  };
}

const enabled = (over: Partial<IntakeSettings> = {}): IntakeSettings => ({ ...defaultIntakeSettings, mode: 'advisory', workspaces: ['default'], ...over });
const flagged: IntakeSummary = {
  state: 'current', assessment: assessed('AF-1', 'rev'), overridden: false,
  policy: { policyVersion: 'intake-policy/v1', eligibility: 'attention_required', reasons: [{ code: 'outcome_unclear', message: 'the requested outcome is unclear' }] },
};
const eligible: IntakeSummary = { ...flagged, policy: { policyVersion: 'intake-policy/v1', eligibility: 'eligible', reasons: [] } };

describe('intakeQueueGate', () => {
  it('defaults to block, and a stored document without the gate fields reads as block / no assessment required', () => {
    expect(defaultIntakeSettings.queueGate).toBe('block');
    expect(defaultIntakeSettings.queueRequiresAssessment).toBe(false);
    const stored = normalizeIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    expect(stored.queueGate).toBe('block');
    expect(stored.queueRequiresAssessment).toBe(false);
  });

  it('allows everything when the gate is off or intake is not enabled for the workspace', () => {
    expect(intakeQueueGate(flagged, enabled({ queueGate: 'off' }), 'default')).toEqual({ action: 'allow', reasons: [] });
    expect(intakeQueueGate(flagged, enabled(), 'other')).toEqual({ action: 'allow', reasons: [] });
    expect(intakeQueueGate(flagged, enabled({ mode: 'off' }), 'default')).toEqual({ action: 'allow', reasons: [] });
  });

  it('blocks a flagged current assessment in block mode, even after an acknowledgment', () => {
    expect(intakeQueueGate(flagged, enabled(), 'default')).toEqual({ action: 'block', reasons: flagged.policy!.reasons });
    expect(intakeQueueGate({ ...flagged, overridden: true }, enabled(), 'default').action).toBe('block');
  });

  it('asks for an acknowledgment in acknowledge mode until one is recorded', () => {
    expect(intakeQueueGate(flagged, enabled({ queueGate: 'acknowledge' }), 'default')).toEqual({ action: 'acknowledge', reasons: flagged.policy!.reasons });
    expect(intakeQueueGate({ ...flagged, overridden: true }, enabled({ queueGate: 'acknowledge' }), 'default').action).toBe('allow');
  });

  it('allows an eligible current assessment', () => {
    expect(intakeQueueGate(eligible, enabled(), 'default')).toEqual({ action: 'allow', reasons: [] });
  });

  it('blocks a missing, stale or unavailable assessment only when one is required', () => {
    const stale: IntakeSummary = { ...flagged, state: 'stale', policy: null };
    const unavailable: IntakeSummary = { ...flagged, state: 'unavailable', policy: null };
    for (const s of [null, stale, unavailable]) expect(intakeQueueGate(s, enabled(), 'default').action).toBe('allow');
    const required = enabled({ queueRequiresAssessment: true });
    expect(intakeQueueGate(null, required, 'default')).toEqual({ action: 'block', reasons: [{ code: 'not_assessed', message: 'Task Intelligence has not assessed this task yet' }] });
    expect(intakeQueueGate(stale, required, 'default').reasons[0]).toEqual({ code: 'not_assessed', message: 'the task changed since Task Intelligence assessed it' });
    expect(intakeQueueGate(unavailable, required, 'default').reasons[0]).toEqual({ code: 'not_assessed', message: 'the Task Intelligence assessment failed' });
  });
});

describe('queueing through the intake gate', () => {
  it('refuses to queue a flagged backlog or cancelled task in block mode and names the reason', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    const task = core.createTask({ title: 'flagged', spec: 's', acceptanceCriteria: 'a' });
    const revision = intakeRevision({ ...core.getTask(task.key), plan: null });
    core.recordIntakeAssessment(task.key, assessed(task.key, revision));

    expect(core.getTask(task.key).queueGate).toEqual({ action: 'block', reasons: [{ code: 'outcome_unclear', message: 'the requested outcome is unclear' }] });
    expect(() => core.queueWithIntakeAcknowledgment(task.key, { expectedRevision: revision }))
      .toThrow('Task Intelligence blocks queueing: the requested outcome is unclear');
    expect(core.getTask(task.key).status).toBe('backlog');

    core.updateStatus(task.key, 'cancelled', 'human');
    expect(() => core.queueWithIntakeAcknowledgment(task.key, { expectedRevision: revision })).toThrow(/blocks queueing/);
    expect(core.getTask(task.key).status).toBe('cancelled');
  });

  it('queues the task once its edited spec assesses eligible', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    const task = core.createTask({ title: 'flagged', spec: 's', acceptanceCriteria: 'a' });
    core.recordIntakeAssessment(task.key, assessed(task.key, intakeRevision({ ...core.getTask(task.key), plan: null })));
    core.updateTask(task.key, { spec: 'a clearer spec' });
    core.recordIntakeAssessment(task.key, assessed(task.key, intakeRevision({ ...core.getTask(task.key), plan: null }), 0.9));

    expect(core.getTask(task.key).queueGate).toEqual({ action: 'allow', reasons: [] });
    expect(core.queueWithIntakeAcknowledgment(task.key, {}).status).toBe('queued');
    expect(core.getTask(task.key).queueGate).toBeNull();
  });

  it('refuses an acknowledgment in block mode', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    const task = core.createTask({ title: 'flagged', spec: 's', acceptanceCriteria: 'a' });
    const revision = intakeRevision({ ...core.getTask(task.key), plan: null });
    core.recordIntakeAssessment(task.key, assessed(task.key, revision));
    expect(() => core.overrideIntake(task.key, { expectedRevision: revision })).toThrow(/cannot be acknowledged/);
  });

  it('blocks an unassessed task when an assessment is required, and an import then stays in backlog', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'], queueRequiresAssessment: true });
    const task = core.createTask({ title: 'fresh', spec: 's', acceptanceCriteria: 'a' });
    expect(() => core.queueWithIntakeAcknowledgment(task.key, {})).toThrow('Task Intelligence blocks queueing: Task Intelligence has not assessed this task yet');

    const imported = core.importTask({ workspace: 'default', dedupPrefix: 'AB#1:', title: 'AB#1: item', spec: 's', acceptanceCriteria: 'a', note: 'from ADO', queue: true });
    expect(imported.task.status).toBe('backlog');
  });

  it('leaves workspaces without intake ungated', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['elsewhere'], queueRequiresAssessment: true });
    const task = core.createTask({ title: 'fresh', spec: 's', acceptanceCriteria: 'a' });
    expect(core.getTask(task.key).queueGate).toEqual({ action: 'allow', reasons: [] });
    expect(core.queueWithIntakeAcknowledgment(task.key, {}).status).toBe('queued');
  });
});
