import { describe, expect, it } from 'vitest';
import {
  createCore, intakeRevision, normalizeIntakeSettings, skipSpecDecision, defaultIntakeSettings, ValidationError,
  PLACEHOLDER_ACCEPTANCE_CRITERIA, type IntakeAssessmentV1, type Complexity, type Risk,
} from '../src/index.js';
import { intakeHeldTaskIds } from '../src/repo/tasks.js';
import { createExecution } from '../src/repo/execution.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { makeTestDb } from './helpers.js';

const COMPLEXITY_P: Record<Complexity, Record<Complexity, number>> = {
  trivial: { trivial: 0.7, small: 0.2, medium: 0.06, large: 0.03, architectural: 0.01 },
  small: { trivial: 0.2, small: 0.6, medium: 0.15, large: 0.04, architectural: 0.01 },
  medium: { trivial: 0.02, small: 0.08, medium: 0.7, large: 0.15, architectural: 0.05 },
  large: { trivial: 0.01, small: 0.04, medium: 0.15, large: 0.7, architectural: 0.1 },
  architectural: { trivial: 0.01, small: 0.02, medium: 0.07, large: 0.2, architectural: 0.7 },
};
const RISK_P: Record<Risk, Record<Risk, number>> = {
  low: { low: 0.75, medium: 0.18, high: 0.06, critical: 0.01 },
  medium: { low: 0.2, medium: 0.6, high: 0.15, critical: 0.05 },
  high: { low: 0.05, medium: 0.15, high: 0.7, critical: 0.1 },
  critical: { low: 0.01, medium: 0.04, high: 0.15, critical: 0.8 },
};

function assessed(key: string, revision: string, o: { stage?: 'description' | 'implementation'; complexity?: Complexity; risk?: Risk; ready?: number } = {}): IntakeAssessmentV1 {
  const stage = o.stage ?? 'description';
  const ready = o.ready ?? 0.92;
  const parts = stage === 'description' ? { outcomeClear: ready, scopeBounded: 0.95 } : { outcomeClear: ready, scopeBounded: 0.95, verifiable: 0.95 };
  const complexity = o.complexity ?? 'small';
  const risk = o.risk ?? 'low';
  return {
    schema: 'intake/v1', status: 'assessed', taskKey: key, sourceRevision: revision, attemptId: null, stage,
    questionSet: 'intake-questions/v1', provider: { name: 'fixture', model: 'fixture-v1' },
    usage: { inputTokens: null, outputTokens: null }, assessedAt: '2026-10-25T00:00:00.000Z', latencyMs: 1,
    decisions: {
      readiness: { probability: Math.min(...Object.values(parts)), parts },
      complexity: { value: complexity, probabilities: COMPLEXITY_P[complexity], confidence: null },
      risk: { value: risk, probabilities: RISK_P[risk], confidence: null },
    },
  };
}
const later = (minutes: number) => () => new Date(Date.now() + minutes * 60_000).toISOString();

function setup(opts: { skipSpec?: boolean; workspaces?: string[]; maxHoldMinutes?: number } = {}) {
  const db = makeTestDb();
  const core = createCore(db);
  core.setIntakeSettings({ mode: 'advisory', workspaces: opts.workspaces ?? ['default'], skipSpec: opts.skipSpec ?? true, ...(opts.maxHoldMinutes ? { maxHoldMinutes: opts.maxHoldMinutes } : {}) });
  return { db, core };
}
/** A one-line intent created at the spec stage and queued, as the board does. */
function queuedIntent(core: ReturnType<typeof createCore>, title = 'Fix the README typo'): string {
  const t = core.createTask({ title, spec: 'README says "teh"; make it "the".', stage: 'description' });
  core.updateStatus(t.key, 'queued', 'human');
  return t.key;
}
const record = (core: ReturnType<typeof createCore>, key: string, o: Parameters<typeof assessed>[2] = {}) =>
  core.recordIntakeAssessment(key, assessed(key, intakeRevision(core.getTask(key)), o));

describe('intake settings — skip spec fields', () => {
  it('defaults skip-spec off with small / low / 0.8 thresholds', () => {
    expect(defaultIntakeSettings).toMatchObject({ skipSpec: false, skipSpecMaxComplexity: 'small', skipSpecMaxRisk: 'low', skipSpecMinReadiness: 0.8 });
  });

  it('a stored document from before these fields keeps its mode and workspaces', () => {
    const legacy = { mode: 'advisory', workspaces: ['wf2'], sendWorkspacePolicy: true, settleSeconds: 60, maxPerTick: 5, maxAttempts: 3, readinessNeedsAttention: true, readinessThreshold: 0.6, architecturalNeedsAttention: true, riskAttentionLevel: null, maxHoldMinutes: 10 };
    expect(normalizeIntakeSettings(legacy)).toMatchObject({ mode: 'advisory', workspaces: ['wf2'], sendWorkspacePolicy: true, skipSpec: false });
  });

  it('refuses invalid skip-spec values', () => {
    const { core } = setup();
    expect(() => core.setIntakeSettings({ skipSpecMaxComplexity: 'medium' })).toThrow(ValidationError);
    expect(() => core.setIntakeSettings({ skipSpecMinReadiness: 1.5 })).toThrow(ValidationError);
    expect(() => core.setIntakeSettings({ skipSpec: 'yes' })).toThrow(ValidationError);
  });
});

describe('skipSpecDecision', () => {
  const on = { ...defaultIntakeSettings, skipSpec: true };
  it('qualifies a small, low-risk, clear spec-stage task and says why', () => {
    expect(skipSpecDecision(assessed('AF-1', 'r'), on)).toEqual({ reason: 'small, low risk, ready 92%' });
    expect(skipSpecDecision(assessed('AF-1', 'r', { complexity: 'trivial' }), on)).not.toBeNull();
  });
  it('refuses on any failing criterion, an implementation-stage assessment, or the toggle off', () => {
    expect(skipSpecDecision(assessed('AF-1', 'r', { complexity: 'medium' }), on)).toBeNull();
    expect(skipSpecDecision(assessed('AF-1', 'r', { risk: 'medium' }), on)).toBeNull();
    expect(skipSpecDecision(assessed('AF-1', 'r', { ready: 0.7 }), on)).toBeNull();
    expect(skipSpecDecision(assessed('AF-1', 'r', { stage: 'implementation' }), on)).toBeNull();
    expect(skipSpecDecision(assessed('AF-1', 'r', { complexity: 'small' }), { ...on, skipSpecMaxComplexity: 'trivial' })).toBeNull();
    expect(skipSpecDecision(assessed('AF-1', 'r'), defaultIntakeSettings)).toBeNull();
  });
});

describe('Task Intelligence skips the spec stage for a simple task', () => {
  it('moves a qualifying queued spec-stage task to implementation with a note', () => {
    const { core } = setup();
    const key = queuedIntent(core);
    record(core, key);
    const task = core.getTask(key);
    expect(task).toMatchObject({ status: 'queued', stage: 'implementation' });
    const note = task.activity.find((a) => a.type === 'status_change' && a.body.startsWith('Task Intelligence'));
    expect(note).toMatchObject({ actor: 'agent', fromStatus: 'queued', toStatus: 'queued' });
    expect(note?.body).toBe('Task Intelligence: simple task (small, low risk, ready 92%); stage description → implementation');
  });

  it('leaves the task at the spec stage when it does not qualify', () => {
    for (const o of [{ complexity: 'medium' as const }, { risk: 'medium' as const }, { ready: 0.7 }]) {
      const { core } = setup();
      const key = queuedIntent(core);
      record(core, key, o);
      expect(core.getTask(key).stage).toBe('description');
    }
  });

  it('does nothing with the toggle off, in a workspace intake does not cover, or for an unqueued task', () => {
    const off = setup({ skipSpec: false });
    const k1 = queuedIntent(off.core);
    record(off.core, k1);
    expect(off.core.getTask(k1).stage).toBe('description');

    const backlog = setup();
    const t = backlog.core.createTask({ title: 'Backlog', spec: 'x', stage: 'description' });
    record(backlog.core, t.key);
    expect(backlog.core.getTask(t.key).stage).toBe('description');
  });

  it('does not move a task the dispatcher has already reserved (the hold failed open first)', () => {
    const { db, core } = setup();
    const key = queuedIntent(core);
    const task = core.getTask(key);
    createExecution(db, { taskId: task.id, taskKey: key, stage: 'description', operation: 'dispatcher:description', generation: 1, attempt: 1, maxAttempts: 3, owner: 'dispatcher', now: new Date().toISOString(), state: 'reserved' });
    record(core, key);
    expect(core.getTask(key)).toMatchObject({ status: 'queued', stage: 'description' });
  });

  it('does not move a task a worker is already writing the spec for', () => {
    const { db, core } = setup({ maxHoldMinutes: 1 });
    const key = queuedIntent(core);
    // past the hold: the worker claimed the spec stage before intake answered
    expect(claimNextTask(db, { claimedBy: 'writer' }, later(2))?.key).toBe(key);
    record(core, key);
    expect(core.getTask(key)).toMatchObject({ status: 'in_progress', stage: 'description' });
  });

  it('a stale re-record after the skip is refused and never promotes twice', () => {
    const { core } = setup();
    const key = queuedIntent(core);
    const revision = intakeRevision(core.getTask(key));
    core.recordIntakeAssessment(key, assessed(key, revision));
    expect(() => core.recordIntakeAssessment(key, assessed(key, revision))).toThrow(); // revision moved with the stage
    expect(core.getTask(key).activity.filter((a) => a.body.startsWith('Task Intelligence'))).toHaveLength(1);
  });
});

describe('hold — a queued spec-stage task waits for intake when skip-spec is on', () => {
  it('holds it until assessed, then releases it', () => {
    const { db, core } = setup();
    const key = queuedIntent(core, 'Needs a real spec');
    expect(core.getTask(key).intakeHold?.until).toBeTypeOf('string');
    expect(intakeHeldTaskIds(db)).toHaveLength(1);
    expect(core.claimNextTask({ claimedBy: 'writer' })).toBeNull();
    record(core, key, { complexity: 'medium' });
    expect(core.getTask(key).intakeHold).toBeNull();
    expect(core.claimNextTask({ claimedBy: 'writer' })?.key).toBe(key);
  });

  it('does not hold spec-stage tasks with skip-spec off', () => {
    const { core } = setup({ skipSpec: false });
    const key = queuedIntent(core);
    expect(core.getTask(key).intakeHold).toBeNull();
  });

  it('fails open after maxHoldMinutes', () => {
    const { db, core } = setup({ maxHoldMinutes: 5 });
    const key = queuedIntent(core);
    expect(intakeHeldTaskIds(db, later(4)())).toHaveLength(1);
    expect(claimNextTask(db, { claimedBy: 'writer' }, later(6))?.key).toBe(key);
  });

  it('a skipped task is not held again at implementation', () => {
    const { core } = setup();
    const key = queuedIntent(core);
    record(core, key);
    expect(core.getTask(key)).toMatchObject({ stage: 'implementation', intakeHold: null });
    expect(core.claimNextTask({ claimedBy: 'worker' })?.key).toBe(key);
  });
});

describe('a skipped task: the implementation worker writes the acceptance criteria', () => {
  function skippedAndClaimed() {
    const { core } = setup();
    const key = queuedIntent(core);
    record(core, key);
    core.claimNextTask({ claimedBy: 'worker' });
    return { core, key };
  }

  it('starts with the placeholder criteria', () => {
    const { core, key } = skippedAndClaimed();
    expect(core.getTask(key).acceptanceCriteria).toBe(PLACEHOLDER_ACCEPTANCE_CRITERIA);
  });

  it('accepts acceptanceCriteria on the implementation submit and checks claims against them', () => {
    const { core, key } = skippedAndClaimed();
    const ac = '1. README spells "the" correctly\n2. No other text changes';
    core.submitResult(key, { summary: 'fixed', acceptanceCriteria: ac, criteria: [{ id: 'AC1', claim: 'fixed line 3' }, { id: 'AC2', claim: 'one-word diff' }] });
    expect(core.getTask(key)).toMatchObject({ status: 'in_review', acceptanceCriteria: ac });
  });

  it('refuses claims for ids the submitted criteria do not have', () => {
    const { core, key } = skippedAndClaimed();
    expect(() => core.submitResult(key, { summary: 'fixed', acceptanceCriteria: '1. One thing', criteria: [{ id: 'AC2', claim: 'x' }] })).toThrow(ValidationError);
  });

  it('refuses acceptanceCriteria on an implementation task that already has real criteria', () => {
    const { core } = setup({ skipSpec: false });
    const t = core.createTask({ title: 'Real', spec: 's', acceptanceCriteria: '1. Real criterion' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'worker' });
    expect(() => core.submitResult(t.key, { summary: 'done', acceptanceCriteria: '1. Rewritten' })).toThrow(ValidationError);
  });
});
