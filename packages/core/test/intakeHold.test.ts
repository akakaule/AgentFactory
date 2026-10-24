import { describe, expect, it } from 'vitest';
import { createCore, intakeRevision, InvalidTransitionError, type IntakeAssessmentV1 } from '../src/index.js';
import { intakeHeldTaskIds } from '../src/repo/tasks.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { makeTestDb } from './helpers.js';

function assessed(key: string, revision: string, stage: 'description' | 'plan' | 'implementation' = 'implementation'): IntakeAssessmentV1 {
  const parts = stage === 'description' ? { outcomeClear: 0.9, scopeBounded: 0.9 } : { outcomeClear: 0.9, scopeBounded: 0.9, verifiable: 0.9 };
  return {
    schema: 'intake/v1', status: 'assessed', taskKey: key, sourceRevision: revision, attemptId: null, stage,
    questionSet: 'intake-questions/v1', provider: { name: 'fixture', model: 'fixture-v1' },
    usage: { inputTokens: null, outputTokens: null }, assessedAt: '2026-10-23T00:00:00.000Z', latencyMs: 1,
    decisions: {
      readiness: { probability: 0.9, parts },
      complexity: { value: 'medium', probabilities: { trivial: 0.02, small: 0.08, medium: 0.7, large: 0.15, architectural: 0.05 }, confidence: null },
      risk: { value: 'low', probabilities: { low: 0.75, medium: 0.18, high: 0.06, critical: 0.01 }, confidence: null },
    },
  };
}
function unavailable(key: string, revision: string): IntakeAssessmentV1 {
  return {
    schema: 'intake/v1', status: 'unavailable', taskKey: key, sourceRevision: revision, attemptId: null, stage: 'implementation',
    questionSet: 'intake-questions/v1', provider: { name: 'fixture', model: 'fixture-v1' },
    usage: { inputTokens: null, outputTokens: null }, assessedAt: '2026-10-23T00:00:00.000Z', latencyMs: 1,
    error: { kind: 'timeout', detail: 'provider timed out' },
  };
}
const CLEAN_REVIEW = 'ai-review/v1 - clean (codex)\nlooks good\n```json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n```';
const later = (minutes: number) => () => new Date(Date.now() + minutes * 60_000).toISOString();

function setup(opts: { enabled?: boolean } = {}) {
  const db = makeTestDb();
  const core = createCore(db);
  if (opts.enabled !== false) core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'] });
  return { db, core };
}
/** The requested flow: a spec written by the description stage, auto-advanced by a clean AI review. */
function specWritten(core: ReturnType<typeof createCore>, title = 'Feature'): string {
  const t = core.createTask({ title, spec: 'rough intent', stage: 'description' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'writer' });
  core.submitResult(t.key, { summary: 'spec written', spec: 'the written spec', acceptanceCriteria: 'AC1; AC2' });
  core.addComment(t.key, { actor: 'agent', body: CLEAN_REVIEW });
  return t.key;
}

describe('intake pending hold — the written spec is assessed before implementation starts', () => {
  it('holds an auto-advanced implementation task until its written spec is assessed, then releases it', () => {
    const { core } = setup();
    const key = specWritten(core);
    const task = core.getTask(key);
    expect(task).toMatchObject({ status: 'queued', stage: 'implementation' });
    expect(task.intakeHold?.until).toBeTypeOf('string');
    expect(core.listTasks({ status: 'queued' })[0]?.intakeHold).toEqual(task.intakeHold);
    expect(core.claimNextTask({ claimedBy: 'worker' })).toBeNull();

    core.recordIntakeAssessment(key, assessed(key, intakeRevision(core.getTask(key))));
    expect(core.getTask(key).intakeHold).toBeNull();
    expect(core.claimNextTask({ claimedBy: 'worker' })?.key).toBe(key);
  });

  it('a failed (unavailable) assessment releases the hold: fail open', () => {
    const { core } = setup();
    const key = specWritten(core);
    core.recordIntakeAssessment(key, unavailable(key, intakeRevision(core.getTask(key))));
    expect(core.getTask(key).intakeHold).toBeNull();
    expect(core.claimNextTask({ claimedBy: 'worker' })?.key).toBe(key);
  });

  it('expires after maxHoldMinutes without an assessment', () => {
    const { db, core } = setup();
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'], maxHoldMinutes: 5 });
    const key = specWritten(core);
    expect(intakeHeldTaskIds(db, later(4)())).toHaveLength(1);
    expect(intakeHeldTaskIds(db, later(6)())).toEqual([]);
    expect(claimNextTask(db, { claimedBy: 'worker' }, later(4))).toBeNull();
    expect(claimNextTask(db, { claimedBy: 'worker' }, later(6))?.key).toBe(key); // fail open
  });

  it('skips a held task and claims the next claimable one', () => {
    const { core } = setup();
    const held = specWritten(core, 'Held');
    const plain = core.createTask({ title: 'Assessed', spec: 's', acceptanceCriteria: 'a' });
    core.recordIntakeAssessment(plain.key, assessed(plain.key, intakeRevision(core.getTask(plain.key))));
    core.updateStatus(plain.key, 'queued', 'human');
    expect(core.claimNextTask({ claimedBy: 'worker' })?.key).toBe(plain.key);
    expect(core.getTask(held).status).toBe('queued');
  });

  it('a pinned claim of a held task returns null; a reserved one is refused', () => {
    const { core } = setup();
    const key = specWritten(core);
    expect(core.claimNextTask({ claimedBy: 'worker', taskKey: key })).toBeNull();
    const execution = core.reserveExecution(key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#x', startImmediately: true });
    expect(execution).not.toBeNull();
    expect(() => core.claimNextTask({ claimedBy: 'default#x-a1', executionId: execution!.id })).toThrow(InvalidTransitionError);
  });

  it('changes nothing when intake is off or the workspace is not opted in', () => {
    const off = setup({ enabled: false });
    const key = specWritten(off.core);
    expect(off.core.getTask(key).intakeHold ?? null).toBeNull();
    expect(off.core.claimNextTask({ claimedBy: 'worker' })?.key).toBe(key);

    const other = setup({ enabled: false });
    other.core.setIntakeSettings({ mode: 'advisory', workspaces: ['elsewhere'] });
    const key2 = specWritten(other.core);
    expect(other.core.claimNextTask({ claimedBy: 'worker' })?.key).toBe(key2);
  });

  it('never holds a description-stage task', () => {
    const { core } = setup();
    const t = core.createTask({ title: 'Intent', spec: 'rough', stage: 'description' });
    core.updateStatus(t.key, 'queued', 'human');
    expect(core.getTask(t.key).intakeHold).toBeNull();
    expect(core.claimNextTask({ claimedBy: 'writer' })?.key).toBe(t.key);
  });

  it('does not re-hold a send-back re-queue whose spec is unchanged', () => {
    const { core } = setup();
    const key = specWritten(core);
    core.recordIntakeAssessment(key, assessed(key, intakeRevision(core.getTask(key))));
    core.claimNextTask({ claimedBy: 'worker' });
    core.submitResult(key, { summary: 'built', links: [{ kind: 'branch', label: 'feature/x', url: 'https://x' }] });
    core.reviewRequestChanges(key, { feedback: 'fix the edge case' });
    expect(core.getTask(key)).toMatchObject({ status: 'queued', intakeHold: null });
    expect(core.claimNextTask({ claimedBy: 'worker' })?.key).toBe(key);
  });
});
