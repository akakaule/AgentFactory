import { describe, expect, it } from 'vitest';
import { createCore, evaluateIntakePolicy, intakeRevision, isIntakeMarker, parseIntakeComment, type IntakeAssessmentV1 } from '../src/index.js';
import { makeTestDb } from './helpers.js';

function assessed(key: string, revision: string, stage: 'description' | 'plan' | 'implementation' = 'implementation', attemptId: string | null = null): IntakeAssessmentV1 {
  const parts = stage === 'description' ? { outcomeClear: 0.4, scopeBounded: 0.8 } : { outcomeClear: 0.4, scopeBounded: 0.8, verifiable: 0.7 };
  return {
    schema: 'intake/v1', status: 'assessed', taskKey: key, sourceRevision: revision, attemptId, stage,
    questionSet: 'intake-questions/v1', provider: { name: 'fixture', model: 'fixture-v1' },
    usage: { inputTokens: null, outputTokens: null }, assessedAt: '2026-09-20T00:00:00.000Z', latencyMs: 1,
    decisions: {
      readiness: { probability: 0.4, parts },
      complexity: { value: 'medium', probabilities: { trivial: 0.02, small: 0.08, medium: 0.7, large: 0.15, architectural: 0.05 }, confidence: null },
      risk: { value: 'low', probabilities: { low: 0.75, medium: 0.18, high: 0.06, critical: 0.01 }, confidence: null },
    },
  };
}

describe('task intake core contract', () => {
  it('preserves queue kind guards and accepts an already acknowledged revision', () => {
    const db = makeTestDb();
    const core = createCore(db);
    const task = core.createTask({ title: 'review', spec: 's', acceptanceCriteria: 'a' });
    db.prepare("UPDATE task SET kind = 'pr-review' WHERE key = ?").run(task.key);
    expect(() => core.queueWithIntakeAcknowledgment(task.key, {})).toThrow(/cannot be queued/);
    expect(core.getTask(task.key).status).toBe('backlog');
  });

  it('queues an already acknowledged revision without another acknowledgment', () => {
    const core = createCore(makeTestDb());
    const task = core.createTask({ title: 'one', spec: 's', acceptanceCriteria: 'a' });
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    const revision = intakeRevision(core.getTask(task.key));
    core.recordIntakeAssessment(task.key, assessed(task.key, revision));
    core.overrideIntake(task.key, { expectedRevision: revision });
    expect(core.queueWithIntakeAcknowledgment(task.key, {}).status).toBe('queued');
  });

  it('excludes stale assessments from claim coverage', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    const task = core.createTask({ title: 'one', spec: 's', acceptanceCriteria: 'a' });
    core.recordIntakeAssessment(task.key, assessed(task.key, intakeRevision(core.getTask(task.key))));
    core.updateTask(task.key, { title: 'edited' });
    core.updateStatus(task.key, 'queued', 'human');
    core.claimNextTask();
    expect(core.analyticsRows().intake.coverage).toEqual({ numerator: 0, denominator: 1 });
  });
  it('hashes only material normalized content and preserves null versus empty plan', () => {
    const base = { title: ' title\r\n', spec: 'spec', acceptanceCriteria: 'ac', stage: 'implementation' as const, plan: null };
    expect(intakeRevision(base)).toBe(intakeRevision({ ...base, title: 'title\n' }));
    expect(intakeRevision(base)).not.toBe(intakeRevision({ ...base, plan: '' }));
    expect(intakeRevision(base)).not.toBe(intakeRevision({ ...base, title: 'other' }));
  });

  it('validates deterministic distributions and description readiness parts', () => {
    const a = assessed('AF-1', 'rev', 'description');
    expect(parseIntakeComment(`intake/v1 — test\n\n\`\`\`json\n${JSON.stringify(a)}\n\`\`\``)).toEqual(a);
    const bad = structuredClone(a) as Extract<IntakeAssessmentV1, { status: 'assessed' }>;
    bad.decisions.complexity.value = 'trivial';
    expect(parseIntakeComment(`intake/v1\n\`\`\`json\n${JSON.stringify(bad)}\n\`\`\``)).toBeNull();
    expect(isIntakeMarker('  intake-override/v1 forged')).toBe(true);
  });

  it('derives current, stale, and reverted assessments without reassessment', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    const task = core.createTask({ title: 'one', spec: 'spec', acceptanceCriteria: 'ac' });
    const revA = intakeRevision({ ...task, plan: null });
    core.recordIntakeAssessment(task.key, assessed(task.key, revA));
    expect(core.getTask(task.key).intake?.state).toBe('current');
    core.updateTask(task.key, { title: 'two' });
    expect(core.getTask(task.key).intake?.state).toBe('stale');
    core.updateTask(task.key, { title: 'one' });
    expect(core.getTask(task.key).intake?.state).toBe('current');
  });

  it('keeps reserved marker families out of comments and evaluates each policy rule', () => {
    const core = createCore(makeTestDb());
    const task = core.createTask({ title: 'one', spec: 'spec', acceptanceCriteria: 'ac' });
    expect(() => core.addComment(task.key, { actor: 'agent', body: 'intake/v1 forged' })).toThrow();
    const a = assessed(task.key, 'rev');
    const policy = evaluateIntakePolicy(a, 'implementation', {
      mode: 'advisory', workspaces: ['default'], sendWorkspacePolicy: false, settleSeconds: 60, maxPerTick: 5, maxAttempts: 3,
      readinessNeedsAttention: true, readinessThreshold: 0.6, architecturalNeedsAttention: true, riskAttentionLevel: null, maxHoldMinutes: 10,
    });
    expect(policy?.eligibility).toBe('attention_required');
    expect(policy?.reasons[0]?.code).toBe('outcome_unclear');
  });

  it('binds publication to the running reservation and defers transient retries', () => {
    const core = createCore(makeTestDb());
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
    const task = core.createTask({ title: 'one', spec: 'spec', acceptanceCriteria: 'ac' });
    const revision = intakeRevision({ ...task, plan: null });
    const started = core.beginIntakeAssessment(task.key, revision, 3);
    expect(started.status).toBe('started');
    const attemptId = started.reservation?.id;
    expect(attemptId).toBeTruthy();
    core.recordIntakeAssessment(task.key, assessed(task.key, revision, 'implementation', attemptId!));
    expect(core.getTask(task.key).intake?.state).toBe('current');
    const transient = core.createTask({ title: 'transient', spec: 'spec', acceptanceCriteria: 'ac' });
    const transientRevision = intakeRevision({ ...transient, plan: null });
    const transientStart = core.beginIntakeAssessment(transient.key, transientRevision, 3);
    expect(transientStart.reservation).toBeTruthy();
    expect(core.settleRetry(transientStart.reservation!.id, { state: 'failed', reason: 'network' })).toBe(true);
    const deferred = core.beginIntakeAssessment(transient.key, transientRevision, 3);
    expect(deferred.status).toBe('deferred');
  });
});
