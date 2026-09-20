import type { TaskIntakeState, IntakeDecisions, Complexity, Risk } from '@agentfactory/core';
import { IntakeProviderError, INTAKE_QUESTIONS, allowlistedState, questionKeysForStage, type ProviderResult, type TaskIntakeDecisionProvider } from '../provider.js';

interface JevOptions { endpoint: string; apiKey: string; model: string; sendWorkspacePolicy?: boolean; fetchImpl?: typeof fetch; }

export class JevTaskIntakeDecisionProvider implements TaskIntakeDecisionProvider {
  readonly name = 'jev';
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: JevOptions) { this.fetchImpl = options.fetchImpl ?? fetch; }

  async assess(state: TaskIntakeState, signal: AbortSignal): Promise<ProviderResult> {
    const keys = questionKeysForStage(state.stage);
    const questions = Object.fromEntries(keys.map((key) => [key, INTAKE_QUESTIONS[key as keyof typeof INTAKE_QUESTIONS]]));
    const body = { model: this.options.model, state: allowlistedState(state, this.options.sendWorkspacePolicy ?? false), questions };
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw new IntakeProviderError('timeout', 'provider request timed out');
      throw new IntakeProviderError('network', 'provider request failed');
    }
    let payload: unknown = null;
    try { payload = await response.json(); } catch { /* classify below without logging the body */ }
    if (response.status === 401 || response.status === 403) throw new IntakeProviderError('auth', 'provider authentication failed');
    if (response.status === 429) throw new IntakeProviderError('rate_limit', 'provider rate limit');
    if (response.status === 529) throw new IntakeProviderError('rate_limit', 'provider overloaded');
    if (!response.ok) {
      if (response.status === 422 && isSizeError(payload)) throw new IntakeProviderError('input_too_large', 'provider rejected oversized input');
      throw new IntakeProviderError('unavailable', `provider returned HTTP ${response.status}`);
    }
    try { return mapJevResponse(payload, state); }
    catch { throw new IntakeProviderError('invalid_response', 'provider response did not match the intake contract'); }
  }
}

function isSizeError(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const text = JSON.stringify(payload).toLowerCase();
  return text.includes('too large') || text.includes('token limit') || text.includes('context length') || text.includes('maximum input');
}

function mapJevResponse(payload: unknown, state: TaskIntakeState): ProviderResult {
  if (!payload || typeof payload !== 'object') throw new Error('invalid');
  const value = payload as { answers?: Record<string, unknown>; questions?: Record<string, unknown>; model?: unknown; usage?: Record<string, unknown> };
  const answers = value.answers ?? value.questions;
  if (!answers) throw new Error('missing answers');
  const answer = (key: string): Record<string, unknown> => {
    const a = answers[key];
    if (!a || typeof a !== 'object') throw new Error(`missing ${key}`);
    return a as Record<string, unknown>;
  };
  const readinessKeys = state.stage === 'description' ? ['outcomeClear', 'scopeBounded'] : ['outcomeClear', 'scopeBounded', 'verifiable'];
  const readinessParts = Object.fromEntries(readinessKeys.map((key) => [key, number(answer(key).probability)]));
  const decisions: IntakeDecisions = {
    readiness: { parts: readinessParts, probability: Math.min(...Object.values(readinessParts)) },
    complexity: choice(answer('complexity'), ['trivial', 'small', 'medium', 'large', 'architectural']),
    risk: choice(answer('risk'), ['low', 'medium', 'high', 'critical']),
  };
  const usage = value.usage ?? {};
  return {
    decisions, model: typeof value.model === 'string' ? value.model : null,
    usage: { inputTokens: optionalCount(usage.inputTokens ?? usage.input_tokens), outputTokens: optionalCount(usage.outputTokens ?? usage.output_tokens) },
  };
}

function number(value: unknown): number { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error('probability'); return value; }
function optionalCount(value: unknown): number | null { return value === null || value === undefined ? null : typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : (() => { throw new Error('usage'); })(); }
function choice<T extends Complexity | Risk>(answer: Record<string, unknown>, values: readonly T[]): { value: T; probabilities: Record<T, number>; confidence: number | null } {
  const raw = answer.probabilities;
  if (!raw || typeof raw !== 'object' || typeof answer.choice !== 'string' || !values.includes(answer.choice as T)) throw new Error('choice');
  const probabilities = Object.fromEntries(values.map((v) => [v, number((raw as Record<string, unknown>)[v])])) as Record<T, number>;
  const confidence = answer.confidence === null || answer.confidence === undefined ? null : number(answer.confidence);
  return { value: answer.choice as T, probabilities, confidence };
}
