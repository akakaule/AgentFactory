/**
 * Opt-in Phase 1 failure-triage evaluation (plan step 5). Runs the frozen rules over a corpus split
 * and prints Markdown tables for the dated report: rules vs the reason-only baseline, the
 * confusion matrix, per-category and per-rule counts, and every disagreement.
 *
 *   npm run failure-triage:eval -- tuning     # iterate on rules here
 *   npm run failure-triage:eval -- heldout    # only on frozen rules; report as is
 */
import { FAILURE_TRIAGE_CATEGORIES } from '../src/failureTriage.js';
import { FAILURE_TRIAGE_RULES_VERSION } from '../src/failureTriageRules.js';
import { classifyCase, classifyReasonOnly, computeMetrics, type EvaluationMetrics, type Prediction } from '../test/fixtures/failure-triage/evaluate.js';
import { TUNING } from '../test/fixtures/failure-triage/corpus/tuning.js';
import { HELDOUT } from '../test/fixtures/failure-triage/corpus/heldout.js';

const split = process.argv[2] ?? 'heldout';
const cases = split === 'tuning' ? TUNING : split === 'heldout' ? HELDOUT : split === 'all' ? [...TUNING, ...HELDOUT] : null;
if (!cases) {
  console.error(`usage: failure-triage-eval [tuning|heldout|all] (got ${split})`);
  process.exit(2);
}

const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;

function summary(name: string, m: EvaluationMetrics): string {
  return row([name, m.total, m.displayed, m.displayedCorrect, pct(m.displayedPrecision), pct(m.coverage), pct(m.abstention), pct(m.causalRecall), m.unknownMislabeled]);
}

const rules = cases.map(classifyCase);
const baseline = cases.map(classifyReasonOnly);
const r = computeMetrics(rules);
const b = computeMetrics(baseline);
const short = (c: string) => (c === 'agent_execution' ? 'agent' : c === 'configuration' ? 'config' : c === 'infrastructure' ? 'infra' : c);

const out: string[] = [];
out.push(`## ${split} split — ${cases.length} cases, ${new Set(cases.map((c) => c.family)).size} families, rules ${FAILURE_TRIAGE_RULES_VERSION}`, '');
out.push(row(['Classifier', 'Cases', 'Displayed', 'Correct', 'Displayed precision', 'Coverage', 'Abstention', 'Causal recall', 'Unknown mislabeled']));
out.push(row(Array(9).fill('---')));
out.push(summary('Rules', r), summary('Reason-only', b), '');

out.push('### Rules confusion (rows = label, columns = predicted)', '');
out.push(row(['label \\ predicted', ...FAILURE_TRIAGE_CATEGORIES.map(short)]));
out.push(row(Array(FAILURE_TRIAGE_CATEGORIES.length + 1).fill('---')));
for (const label of FAILURE_TRIAGE_CATEGORIES) out.push(row([short(label), ...FAILURE_TRIAGE_CATEGORIES.map((p) => r.confusion[label][p] || '·')]));
out.push('');

out.push('### Per category (rules)', '');
out.push(row(['Category', 'Support', 'Predicted', 'Correct', 'Precision', 'Recall']));
out.push(row(Array(6).fill('---')));
for (const c of FAILURE_TRIAGE_CATEGORIES) {
  const k = r.perCategory[c];
  out.push(row([c, k.support, k.predicted, k.correct, pct(k.predicted ? k.correct / k.predicted : null), pct(k.support ? k.correct / k.support : null)]));
}
out.push('');

out.push('### Per rule', '');
out.push(row(['Rule', 'Decided', 'Correct']));
out.push(row(['---', '---', '---']));
for (const [id, k] of Object.entries(r.perRule).sort(([a], [z]) => a.localeCompare(z))) out.push(row([`\`${id}\``, k.fired, k.correct]));
out.push('');

const misses = rules.filter((p: Prediction) => p.label !== p.predicted);
out.push(`### Disagreements (${misses.length})`, '');
out.push(row(['Case', 'Label', 'Predicted', 'Rule']));
out.push(row(['---', '---', '---', '---']));
for (const p of misses) out.push(row([`\`${p.id}\``, p.label, p.predicted, p.ruleId ? `\`${p.ruleId}\`` : '—']));

console.log(out.join('\n'));
