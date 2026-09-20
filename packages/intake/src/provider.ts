import type { IntakeDecisions, TaskIntakeState, IntakeErrorKind } from '@agentfactory/core';

export const INTAKE_QUESTIONS = {
  outcomeClear: 'Is the requested outcome — what should be true when the work is finished — stated clearly enough that two engineers would describe the same result?',
  scopeBounded: 'Is the scope bounded — is it clear what is and is not part of this task?',
  verifiable: 'Could a reviewer decide from the acceptance criteria alone whether the work is complete?',
  complexity: 'How complex is this task: trivial, small, medium, large, or architectural?',
  risk: 'What is the impact if the implementation is wrong: low, medium, high, or critical?',
} as const;

export const questionKeysForStage = (stage: TaskIntakeState['stage']): readonly string[] =>
  stage === 'description' ? ['outcomeClear', 'scopeBounded', 'complexity', 'risk'] : ['outcomeClear', 'scopeBounded', 'verifiable', 'complexity', 'risk'];

export interface ProviderResult { decisions: IntakeDecisions; model: string | null; usage: { inputTokens: number | null; outputTokens: number | null }; }
export interface TaskIntakeDecisionProvider { readonly name: string; assess(state: TaskIntakeState, signal: AbortSignal): Promise<ProviderResult>; }

export type IntakeProviderErrorKind = IntakeErrorKind | 'auth';
export class IntakeProviderError extends Error {
  readonly name = 'IntakeProviderError';
  constructor(readonly kind: IntakeProviderErrorKind, message: string) { super(message); }
}

export function allowlistedState(state: TaskIntakeState, sendWorkspacePolicy = false): Record<string, unknown> {
  return {
    key: state.key, title: state.title, spec: state.spec, acceptanceCriteria: state.acceptanceCriteria,
    stage: state.stage, plan: state.plan, links: state.links.map(({ kind, label }) => ({ kind, label })),
    attachmentCount: state.attachmentCount, ...(sendWorkspacePolicy ? { workspacePolicy: state.workspacePolicy } : {}),
  };
}

function decisionsFromFixture(value: Partial<IntakeDecisions> | undefined, stage: TaskIntakeState['stage']): IntakeDecisions {
  const parts = stage === 'description' ? { outcomeClear: 0.9, scopeBounded: 0.9 } : { outcomeClear: 0.9, scopeBounded: 0.9, verifiable: 0.9 };
  const d = value ?? {};
  const readiness = { ...parts, ...(d.readiness?.parts ?? {}) };
  const complexities = { trivial: 0.02, small: 0.08, medium: 0.7, large: 0.15, architectural: 0.05, ...d.complexity?.probabilities };
  const risks = { low: 0.75, medium: 0.18, high: 0.06, critical: 0.01, ...d.risk?.probabilities };
  return {
    readiness: { parts: readiness, probability: Math.min(...Object.values(readiness)) },
    complexity: { value: d.complexity?.value ?? 'medium', probabilities: complexities, confidence: d.complexity?.confidence ?? null },
    risk: { value: d.risk?.value ?? 'low', probabilities: risks, confidence: d.risk?.confidence ?? null },
  } as IntakeDecisions;
}

export class FixtureTaskIntakeDecisionProvider implements TaskIntakeDecisionProvider {
  readonly name = 'fixture';
  constructor(private readonly fixtures: Record<string, Partial<IntakeDecisions>> = {}) {}
  async assess(state: TaskIntakeState, _signal: AbortSignal): Promise<ProviderResult> {
    return { decisions: decisionsFromFixture(this.fixtures[state.title], state.stage), model: 'fixture-v1', usage: { inputTokens: null, outputTokens: null } };
  }
}
