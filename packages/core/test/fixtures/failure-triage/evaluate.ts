/**
 * Phase 1 failure-triage evaluation (plan step 5): run corpus cases through the exact read-model
 * path (buildFailureComment → parseFailureComment → classifyFailureNote) and compute the spec §10
 * metrics. Pure — the opt-in CLI (packages/core/scripts/failure-triage-eval.ts) only formats.
 */
import type { FailureTriageCategory } from '../../../src/types.js';
import { buildFailureComment, parseFailureComment } from '../../../src/failure.js';
import { FAILURE_TRIAGE_CATEGORIES, classifyFailureNote, type FailureNote } from '../../../src/failureTriage.js';
import type { CorpusCase } from './corpus/types.js';

export interface Prediction { id: string; family: string; label: FailureTriageCategory; predicted: FailureTriageCategory; ruleId: string | null }

/** The note body exactly as its writer would have stored it. */
function noteBody(note: CorpusCase['notes'][number]): string {
  return buildFailureComment({
    reason: note.reason, detail: note.detail, source: note.source,
    ...(note.attempt !== undefined ? { attempt: note.attempt } : {}),
    ...(note.maxAttempts !== undefined ? { maxAttempts: note.maxAttempts } : {}),
    ...(note.body !== undefined ? { body: note.body } : {}),
  });
}

/** Classify a case's current (last) note with the Phase 1 rules, as the read model does. */
export function classifyCase(c: CorpusCase): Prediction {
  const notes: FailureNote[] = c.notes.map((n, i) => ({ id: i + 1, body: noteBody(n), createdAt: `2027-01-01T00:00:0${i}.000Z` }));
  const current = notes.at(-1);
  const parsed = current ? parseFailureComment(current.body) : null;
  if (!current || !parsed) throw new Error(`corpus case ${c.id} has no parseable current note`);
  const previous = notes.length > 1 ? notes[notes.length - 2]! : null;
  const { rules } = classifyFailureNote(current, parsed, previous, c.sameEpisode ?? true);
  return { id: c.id, family: c.family, label: c.label, predicted: rules.category, ruleId: rules.ruleId };
}

/** The reference baseline from spec §10: only the writer's explicit reason, nothing from the log. */
export function classifyReasonOnly(c: CorpusCase): Prediction {
  const reason = c.notes.at(-1)?.reason;
  const predicted: FailureTriageCategory =
    reason === 'permission_denied' ? 'access' : reason === 'merge_conflict' || reason === 'pr_closed' ? 'delivery' : 'unknown';
  return { id: c.id, family: c.family, label: c.label, predicted, ruleId: null };
}

export interface CategoryCounts { support: number; predicted: number; correct: number }

export interface EvaluationMetrics {
  total: number;
  /** Non-unknown predictions — the labels a user would actually see. */
  displayed: number;
  displayedCorrect: number;
  /** displayedCorrect / displayed; null when nothing was displayed. */
  displayedPrecision: number | null;
  /** displayed / total. */
  coverage: number;
  /** 1 − coverage: the share left "Cause unclear". */
  abstention: number;
  /** Examples whose true label is a cause (not unknown). */
  causal: number;
  /** displayedCorrect / causal: how many real causes the rules surface. */
  causalRecall: number | null;
  /** Of the truly-unknown examples, how many still received a (necessarily wrong) label. */
  unknownMislabeled: number;
  /** confusion[label][predicted]. */
  confusion: Record<FailureTriageCategory, Record<FailureTriageCategory, number>>;
  perCategory: Record<FailureTriageCategory, CategoryCounts>;
  /** ruleId → how often it decided the label and how often that was right. */
  perRule: Record<string, { fired: number; correct: number }>;
}

const ratio = (num: number, den: number): number | null => (den === 0 ? null : num / den);

export function computeMetrics(predictions: readonly Prediction[]): EvaluationMetrics {
  const zeroRow = () => Object.fromEntries(FAILURE_TRIAGE_CATEGORIES.map((c) => [c, 0])) as Record<FailureTriageCategory, number>;
  const confusion = Object.fromEntries(FAILURE_TRIAGE_CATEGORIES.map((c) => [c, zeroRow()])) as EvaluationMetrics['confusion'];
  const perCategory = Object.fromEntries(FAILURE_TRIAGE_CATEGORIES.map((c) => [c, { support: 0, predicted: 0, correct: 0 }])) as EvaluationMetrics['perCategory'];
  const perRule: EvaluationMetrics['perRule'] = {};
  let displayed = 0, displayedCorrect = 0, causal = 0, unknownMislabeled = 0;
  for (const p of predictions) {
    confusion[p.label][p.predicted] += 1;
    perCategory[p.label].support += 1;
    perCategory[p.predicted].predicted += 1;
    if (p.label === p.predicted) perCategory[p.label].correct += 1;
    if (p.label !== 'unknown') causal += 1;
    if (p.predicted !== 'unknown') {
      displayed += 1;
      if (p.label === p.predicted) displayedCorrect += 1;
      if (p.label === 'unknown') unknownMislabeled += 1;
    }
    if (p.ruleId) {
      const rule = (perRule[p.ruleId] ??= { fired: 0, correct: 0 });
      rule.fired += 1;
      if (p.label === p.predicted) rule.correct += 1;
    }
  }
  const total = predictions.length;
  return {
    total, displayed, displayedCorrect,
    displayedPrecision: ratio(displayedCorrect, displayed),
    coverage: total === 0 ? 0 : displayed / total,
    abstention: total === 0 ? 0 : 1 - displayed / total,
    causal, causalRecall: ratio(displayedCorrect, causal), unknownMislabeled,
    confusion, perCategory, perRule,
  };
}
