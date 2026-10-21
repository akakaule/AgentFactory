/**
 * Advisory failure triage — the taxonomy, the episode/evidence rule, the display policy, and the
 * `failure-triage-feedback/v1` marker convention (docs/spec/2026-09-25-failure-triage-design.md).
 *
 * Phase 1 labels are derived at read time from the `failure/v1` notes by local rules; only human
 * feedback is persisted. Nothing here changes a claim, retry budget, status, or notification, and
 * none of it reaches a worker (the MCP layer strips it).
 */
import { z } from 'zod';
import type { FailureTriageCategory, FailureTriageFeedback, FailureTriageRuleResult, FailureTriageSummary } from './types.js';
import { parseFailureComment, type ParsedFailure } from './failure.js';
import { failureEvidenceText } from './failureTriageEvidence.js';
import { classifyByRules } from './failureTriageRules.js';

/** Reserved for Phase 2 provider assessments; reserved now so no comment can squat the prefix. */
export const FAILURE_TRIAGE_MARKER = 'failure-triage/v1';
export const FAILURE_TRIAGE_FEEDBACK_MARKER = 'failure-triage-feedback/v1';
export const FAILURE_TRIAGE_MARKER_PREFIXES = [FAILURE_TRIAGE_MARKER, FAILURE_TRIAGE_FEEDBACK_MARKER] as const;
export const FAILURE_TRIAGE_DISPLAY_VERSION = 'failure-triage-display/v2';
export const FAILURE_TRIAGE_NOTE_MAX = 500;

/** Fixed category order — deterministic reporting and the correction selector. */
export const FAILURE_TRIAGE_CATEGORIES: readonly FailureTriageCategory[] = ['access', 'configuration', 'infrastructure', 'build_test', 'agent_execution', 'delivery', 'unknown'];

/** Display label and fixed next-check suggestion per category (spec §6). Never model-generated. */
export const FAILURE_TRIAGE_TAXONOMY: Record<FailureTriageCategory, { label: string; suggestion: string }> = {
  access: { label: 'Access or credentials', suggestion: 'Check the reported credential, account entitlement, or execution permission.' },
  configuration: { label: 'Setup or configuration', suggestion: 'Check the reported setup, dependency, or configuration.' },
  infrastructure: { label: 'Service or resource outage', suggestion: 'Check the reported service availability or resource limit.' },
  build_test: { label: 'Build or test failure', suggestion: 'Inspect the failing build step or test and its captured error.' },
  agent_execution: { label: 'Agent execution', suggestion: 'Inspect the agent output and required completion steps.' },
  delivery: { label: 'Branch or PR state', suggestion: 'Inspect the branch and PR state reported by the delivery failure.' },
  unknown: { label: 'Cause unclear', suggestion: 'Inspect the source log; the available evidence does not establish a likely cause.' },
};

/** True iff a comment body carries a reserved failure-triage marker (well-formed or not). */
export function isFailureTriageMarker(body: string): boolean {
  const text = body.trimStart().toLowerCase();
  return FAILURE_TRIAGE_MARKER_PREFIXES.some((prefix) => text.startsWith(prefix));
}

// ── episodes and evidence (spec §4) ─────────────────────────────────────────────────────────

export interface FailureNote { id: number; body: string; createdAt: string; }

export interface FailureTriageClassification { evidenceActivityId: number | null; rules: FailureTriageRuleResult; }

/**
 * The note whose evidence the rules read. Normally the failure note itself. A `max_attempts` note
 * carries no log — the dispatcher writes it right after the final attempt's crash/timeout note — so
 * its evidence is the immediately preceding failure note, provided that note is in the same episode
 * (no result / ai-review / restart between them), parses, and came from the same source. Nothing
 * else borrows an earlier note's log: a different reason can have a different cause.
 */
export function classifyFailureNote(
  note: FailureNote, parsed: ParsedFailure, previous: FailureNote | null, previousInEpisode: boolean,
): FailureTriageClassification {
  let evidence: { note: FailureNote; parsed: ParsedFailure } | null = { note, parsed };
  if (parsed.reason === 'max_attempts') {
    const prior = previous && previousInEpisode ? parseFailureComment(previous.body) : null;
    evidence = previous && prior && prior.source === parsed.source ? { note: previous, parsed: prior } : null;
  }
  if (!evidence) return { evidenceActivityId: null, rules: classifyByRules(parsed.reason, parsed.detail, null) };
  const text = failureEvidenceText(evidence.note.body, evidence.parsed.detail);
  return { evidenceActivityId: evidence.note.id, rules: classifyByRules(evidence.parsed.reason, evidence.parsed.detail, text) };
}

/** Display policy v2 (Phase 1 sources): the latest human label wins, else the rule result. */
export function summarizeFailureTriage(
  sourceActivityId: number, classification: FailureTriageClassification, human: FailureTriageFeedback | null,
): FailureTriageSummary {
  const category = human ? human.category : classification.rules.category;
  const { label, suggestion } = FAILURE_TRIAGE_TAXONOMY[category];
  return {
    sourceActivityId, evidenceActivityId: classification.evidenceActivityId,
    classifier: human ? 'human' : 'rules', category, label, suggestion,
    rules: classification.rules, human,
  };
}

// ── feedback marker ─────────────────────────────────────────────────────────────────────────

export interface FailureTriageFeedbackRecord {
  sourceActivityId: number; action: 'confirm' | 'correct'; category: FailureTriageCategory;
  shownCategory: FailureTriageCategory; classifier: 'rules' | 'human'; rulesVersion: string | null; note: string | null;
}

const category = z.enum(FAILURE_TRIAGE_CATEGORIES as unknown as [FailureTriageCategory, ...FailureTriageCategory[]]);
const feedbackRecord = z.object({
  sourceActivityId: z.number().int().positive(),
  action: z.enum(['confirm', 'correct']),
  category, shownCategory: category,
  classifier: z.enum(['rules', 'human']),
  rulesVersion: z.string().min(1).nullable(),
  note: z.string().max(FAILURE_TRIAGE_NOTE_MAX).nullable(),
});

export function buildFailureTriageFeedbackComment(record: FailureTriageFeedbackRecord): string {
  const label = FAILURE_TRIAGE_TAXONOMY[record.category].label;
  const head = record.action === 'confirm'
    ? `confirmed: ${label}`
    : `corrected to ${label} (shown: ${FAILURE_TRIAGE_TAXONOMY[record.shownCategory].label})`;
  return `${FAILURE_TRIAGE_FEEDBACK_MARKER} — ${head}\n\`\`\`json\n${JSON.stringify(record)}\n\`\`\``;
}

/** The feedback record, or null for any body that is not a well-formed feedback marker (inert). */
export function parseFailureTriageFeedbackComment(body: string): FailureTriageFeedbackRecord | null {
  if (!body.trimStart().toLowerCase().startsWith(FAILURE_TRIAGE_FEEDBACK_MARKER)) return null;
  const match = body.match(/```json\s*([\s\S]*?)\s*```/i);
  if (!match?.[1]) return null;
  try {
    const result = feedbackRecord.safeParse(JSON.parse(match[1]));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}
