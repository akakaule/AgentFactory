import type { FailureTriageCategory } from './types.js';

/**
 * Client mirror of core's FAILURE_TRIAGE_CATEGORIES + taxonomy labels (the client cannot import
 * core's runtime — it pulls node:sqlite). Kept in lockstep by test/server/failureTriage.test.ts.
 */
export const FAILURE_TRIAGE_OPTIONS: ReadonlyArray<{ value: FailureTriageCategory; label: string }> = [
  { value: 'access', label: 'Access or credentials' },
  { value: 'configuration', label: 'Setup or configuration' },
  { value: 'infrastructure', label: 'Service or resource outage' },
  { value: 'build_test', label: 'Build or test failure' },
  { value: 'agent_execution', label: 'Agent execution' },
  { value: 'delivery', label: 'Branch or PR state' },
  { value: 'unknown', label: 'Cause unclear' },
];

export function failureTriageLabel(category: FailureTriageCategory): string {
  return FAILURE_TRIAGE_OPTIONS.find((o) => o.value === category)?.label ?? category;
}
