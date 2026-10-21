import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ValidationError } from './errors.js';
import type {
  Complexity, IntakeAssessmentV1, IntakeAssessed, IntakeChoice, IntakeDecisions, IntakeErrorKind,
  IntakePolicyResult, IntakeReason, IntakeReadinessPart, IntakeSettings, Risk, Stage,
} from './types.js';
import type { Task } from './types.js';

export const INTAKE_MARKER = 'intake/v1';
export const INTAKE_OVERRIDE_MARKER = 'intake-override/v1';
export const INTAKE_CLAIM_MARKER = 'intake-claim/v1';
export const INTAKE_QUESTION_SET = 'intake-questions/v1';
export const INTAKE_POLICY_VERSION = 'intake-policy/v1';
export const COMPLEXITIES: readonly Complexity[] = ['trivial', 'small', 'medium', 'large', 'architectural'];
export const RISKS: readonly Risk[] = ['low', 'medium', 'high', 'critical'];
export const READINESS_PARTS: readonly IntakeReadinessPart[] = ['outcomeClear', 'scopeBounded', 'verifiable'];
export const INTAKE_MARKER_PREFIXES = [INTAKE_MARKER, INTAKE_OVERRIDE_MARKER, INTAKE_CLAIM_MARKER] as const;

const errorKinds = ['timeout', 'rate_limit', 'network', 'invalid_response', 'unavailable', 'input_too_large'] as const;
const stages = ['description', 'plan', 'implementation'] as const;
const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/, 'assessedAt must be an ISO UTC timestamp');
const probability = z.number().finite().min(0).max(1);
const usageCount = z.number().int().nonnegative().nullable();

const base = z.object({
  schema: z.literal(INTAKE_MARKER), taskKey: z.string().trim().min(1), sourceRevision: z.string().trim().min(1),
  attemptId: z.string().trim().min(1).nullable(), stage: z.enum(stages), questionSet: z.string().trim().min(1),
  provider: z.object({ name: z.string().trim().min(1), model: z.string().trim().min(1).nullable() }),
  usage: z.object({ inputTokens: usageCount, outputTokens: usageCount }), assessedAt: iso,
  latencyMs: z.number().finite().nonnegative(),
});
const readiness = z.object({ probability, parts: z.record(probability) });
const choice = <T extends readonly string[]>(values: T) => z.object({
  value: z.enum([...values] as unknown as [string, ...string[]]),
  probabilities: z.record(probability), confidence: probability.nullable(),
});
const decisions = z.object({ readiness, complexity: choice(COMPLEXITIES), risk: choice(RISKS) }).passthrough();
const assessedSchema = base.extend({ status: z.literal('assessed'), decisions });
const unavailableSchema = base.extend({
  status: z.literal('unavailable'), error: z.object({ kind: z.enum(errorKinds), detail: z.string().trim().min(1) }),
});
const assessmentSchema = z.discriminatedUnion('status', [assessedSchema, unavailableSchema]);

function fail(result: z.SafeParseError<unknown>): never {
  throw new ValidationError(result.error.issues.map((issue) => issue.message).join('; '));
}

export function validateIntakeAssessment(input: unknown): IntakeAssessmentV1 {
  const result = assessmentSchema.safeParse(input);
  if (!result.success) return fail(result);
  const a = result.data as IntakeAssessmentV1;
  if (a.status === 'unavailable') return a;
  const parts = Object.keys(a.decisions.readiness.parts);
  const required: IntakeReadinessPart[] = a.stage === 'description' ? ['outcomeClear', 'scopeBounded'] : [...READINESS_PARTS];
  if (parts.length !== required.length || required.some((part) => !parts.includes(part)))
    throw new ValidationError(`readiness parts do not match stage ${a.stage}`);
  const min = Math.min(...required.map((part) => a.decisions.readiness.parts[part]!));
  if (Math.abs(min - a.decisions.readiness.probability) > 1e-9)
    throw new ValidationError('readiness probability must equal the minimum readiness part');
  validateChoice(a.decisions.complexity, COMPLEXITIES, 'complexity');
  validateChoice(a.decisions.risk, RISKS, 'risk');
  return a;
}

function validateChoice<T extends string>(choiceValue: IntakeChoice<T>, order: readonly T[], name: string): void {
  const keys = Object.keys(choiceValue.probabilities);
  if (keys.length !== order.length || order.some((key) => !keys.includes(key)))
    throw new ValidationError(`${name} probabilities must contain exactly the known values`);
  const sum = order.reduce((total, key) => total + choiceValue.probabilities[key], 0);
  if (Math.abs(sum - 1) > 0.02) throw new ValidationError(`${name} probabilities must sum to 1`);
  let best = order[0]!;
  for (const key of order.slice(1)) {
    if (choiceValue.probabilities[key] > choiceValue.probabilities[best]) best = key;
  }
  if (choiceValue.value !== best) throw new ValidationError(`${name} value must be the deterministic arg-max`);
}

export function parseIntakeAssessment(input: unknown): IntakeAssessmentV1 | null {
  try { return validateIntakeAssessment(input); } catch { return null; }
}

export function isIntakeMarker(body: string): boolean {
  const text = body.trimStart().toLowerCase();
  return INTAKE_MARKER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

export function isIntakeAssessmentMarker(body: string): boolean {
  return body.trimStart().toLowerCase().startsWith(INTAKE_MARKER);
}

export function parseIntakeComment(body: string): IntakeAssessmentV1 | null {
  if (!isIntakeAssessmentMarker(body)) return null;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match?.[1]) return null;
  try { return parseIntakeAssessment(JSON.parse(match[1])); } catch { return null; }
}

export function buildIntakeComment(assessment: IntakeAssessmentV1): string {
  const summary = assessment.status === 'unavailable'
    ? `assessment unavailable (${assessment.error.kind})`
    : `ready ${Math.round(assessment.decisions.readiness.probability * 100)}% · ${assessment.decisions.complexity.value} · ${assessment.decisions.risk.value} risk (${assessment.provider.name})`;
  return `${INTAKE_MARKER} — ${summary}\n\n\`\`\`json\n${JSON.stringify(assessment)}\n\`\`\``;
}

export function normalizeIntakeText(value: string): string {
  return value.replace(/\r\n/g, '\n').trim();
}

export interface IntakeRevisionInput { title: string; spec: string; acceptanceCriteria: string; stage: Stage; plan: string | null; }
export function intakeRevision(task: Pick<Task, 'title' | 'spec' | 'acceptanceCriteria' | 'stage'> & { plan: string | null }): string {
  const canonical: IntakeRevisionInput = {
    title: normalizeIntakeText(task.title), spec: normalizeIntakeText(task.spec),
    acceptanceCriteria: normalizeIntakeText(task.acceptanceCriteria), stage: task.stage,
    plan: task.plan === null ? null : normalizeIntakeText(task.plan),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const riskRank: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export function evaluateIntakePolicy(a: IntakeAssessmentV1, stage: Stage, settings: IntakeSettings): IntakePolicyResult | null {
  if (a.status !== 'assessed' || a.stage !== stage) return null;
  const reasons: IntakeReason[] = [];
  if (settings.readinessNeedsAttention && a.decisions.readiness.probability < settings.readinessThreshold) {
    const order = stage === 'description' ? ['outcomeClear', 'scopeBounded'] as const : READINESS_PARTS;
    let weakest = order[0]!;
    for (const part of order.slice(1)) {
      if (a.decisions.readiness.parts[part]! < a.decisions.readiness.parts[weakest]!) weakest = part;
    }
    const messages: Record<IntakeReadinessPart, string> = {
      outcomeClear: 'the requested outcome is unclear', scopeBounded: 'the task scope is not bounded', verifiable: 'the acceptance criteria are not verifiable',
    };
    reasons.push({ code: weakest === 'outcomeClear' ? 'outcome_unclear' : weakest === 'scopeBounded' ? 'scope_unbounded' : 'not_verifiable', message: messages[weakest] });
  }
  if (settings.architecturalNeedsAttention && stage === 'implementation' && a.decisions.complexity.value === 'architectural')
    reasons.push({ code: 'architectural', message: 'architectural work needs a reviewed plan before implementation' });
  if (settings.riskAttentionLevel && riskRank[a.decisions.risk.value] >= riskRank[settings.riskAttentionLevel])
    reasons.push({ code: 'risk_at_or_above', message: `risk is ${a.decisions.risk.value}` });
  return { policyVersion: INTAKE_POLICY_VERSION, eligibility: reasons.length ? 'attention_required' : 'eligible', reasons };
}

export function buildIntakeOverrideComment(input: { sourceRevision: string; policy: IntakePolicyResult; reason: string | null; settings: IntakeSettings }): string {
  const reasonText = input.policy.reasons.map((r) => r.message).join('; ');
  const record = { sourceRevision: input.sourceRevision, policyVersion: input.policy.policyVersion, reasons: input.policy.reasons.map((r) => r.code), reason: input.reason, settings: input.settings };
  return `${INTAKE_OVERRIDE_MARKER} — queued despite: ${reasonText}\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
}

export function intakeOverrideRevision(body: string): string | null {
  if (!body.trimStart().toLowerCase().startsWith(INTAKE_OVERRIDE_MARKER)) return null;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as { sourceRevision?: unknown };
    return typeof value.sourceRevision === 'string' && value.sourceRevision.length > 0 ? value.sourceRevision : null;
  } catch { return null; }
}

export interface IntakeClaimContext {
  sourceRevision: string; stage: Stage; assessmentRevision: string | null;
  policyVersion: 'intake-policy/v1'; settings: IntakeSettings;
}
export function buildIntakeClaimComment(context: IntakeClaimContext): string {
  return `${INTAKE_CLAIM_MARKER}\n\`\`\`json\n${JSON.stringify(context)}\n\`\`\``;
}
export function parseIntakeClaimComment(body: string): IntakeClaimContext | null {
  if (!body.trimStart().toLowerCase().startsWith(INTAKE_CLAIM_MARKER)) return null;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match?.[1]) return null;
  try {
    const value = JSON.parse(match[1]) as IntakeClaimContext;
    if (typeof value.sourceRevision !== 'string' || !stages.includes(value.stage) || (value.assessmentRevision !== null && typeof value.assessmentRevision !== 'string')) return null;
    if (value.policyVersion !== INTAKE_POLICY_VERSION || !value.settings || typeof value.settings !== 'object') return null;
    return value;
  } catch { return null; }
}

export function isKnownIntakeErrorKind(value: string): value is IntakeErrorKind {
  return (errorKinds as readonly string[]).includes(value);
}

export function asAssessed(a: IntakeAssessmentV1): IntakeAssessed | null { return a.status === 'assessed' ? a : null; }
