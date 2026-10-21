import type { AiReviewSeverity, ReviewBrief, ReviewCriterionRow, ReviewGroup, ReviewHeadline, ReviewIssue, ReviewOpinion } from './types.js';

/** The words the review panel, the card chip and the dialogs share (spec §6). */

export const HEADLINE_TITLE: Record<ReviewHeadline, string> = {
  changes_needed: 'Changes needed', your_call: 'Your call', minor: 'Minor issues only', clean: 'No issues found', pending: 'Review pending',
};
export const GROUP_LABEL: Record<ReviewGroup, string> = { must: 'Must fix', call: 'Your call', should: 'Should fix', fyi: 'FYI' };
export const SEVERITY_LABEL: Record<AiReviewSeverity, string> = { error: 'Must fix', warning: 'Should fix', info: 'FYI' };
export const ROW_STATUS_LABEL: Record<ReviewCriterionRow['status'], string> = {
  not_met: 'Not met', your_call: 'Your call', concerns: 'Concerns', clear: 'Nothing flagged',
};

const capitalize = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "claude/claude-fable-5-1" → "Claude"; "codex/gpt-6-astra (medium)" → "Codex". */
export function reviewerShortName(reviewer: string): string {
  return capitalize(reviewer.split('/')[0]!.trim());
}

/** Short names for a reviewer list, keyed by full name — the full names when two would collide. */
export function shortNames(reviewers: string[]): Map<string, string> {
  const short = reviewers.map(reviewerShortName);
  const unique = new Set(short).size === short.length;
  return new Map(reviewers.map((r, i) => [r, unique ? short[i]! : r]));
}

/** "Claude and Codex" / "Claude, Codex and Gemini". */
export function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/** "AC4 Race", or the id alone for an unnamed criterion. */
export function criterionLabel(row: Pick<ReviewCriterionRow, 'id' | 'name'>): string {
  return row.name ? `${row.id} ${row.name}` : row.id;
}

/** The card chip: its label and the short count text beside it. */
export function chipText(brief: ReviewBrief): { label: string; detail: string | null } {
  const { must, call, should, fyi } = brief.counts;
  switch (brief.headline) {
    case 'changes_needed':
      return { label: 'Changes needed', detail: [must ? `${must} must fix` : null, call ? `${call} your call` : null].filter(Boolean).join(' · ') || null };
    case 'your_call': return { label: `Your call · ${call}`, detail: null };
    case 'minor': return { label: `Minor issues · ${should + fyi}`, detail: null };
    case 'clean': return { label: 'No issues found', detail: null };
    case 'pending': return { label: 'Review pending', detail: null };
  }
}

/** Why the open decisions are the human's: the reviewers disagree on severity, on validity, or nobody verified them. */
function callReason(calls: ReviewIssue[], reviewers: number): string {
  const one = calls.length === 1;
  const they = reviewers === 2 ? 'both reviewers' : 'the reviewers';
  if (calls.some((i) => i.dispute === 'validity')) return one ? 'the reviewers disagree whether it\'s a problem' : 'the reviewers disagree whether they\'re problems';
  if (calls.every((i) => i.dispute === 'unverified')) return one ? 'it was raised late and no reviewer has verified it' : 'they were raised late and no reviewer has verified them';
  return one ? `${they} agree it's real but not on how serious` : `${they} agree they're real but not on how serious`;
}

/**
 * The verdict card's one sentence, e.g. "2 must-fix issues: AC4 Race and AC6 Liveness aren't met.
 * 3 more need your decision: both reviewers agree they're real but not on how serious. 2 should-fix."
 */
export function reviewSentence(brief: ReviewBrief): string {
  if (brief.headline === 'pending') return 'The reviewer hasn\'t looked at the latest result yet. The issues below are from the previous review.';
  if (brief.headline === 'clean') {
    if (brief.reviewers.length === 0) return 'The reviewer found nothing to fix.';
    if (brief.reviewers.length === 1) return `${reviewerShortName(brief.reviewers[0]!)} found nothing to fix.`;
    return `${brief.reviewers.length === 2 ? 'Both' : `All ${brief.reviewers.length}`} reviewers found nothing to fix.`;
  }
  const { must, should, fyi } = brief.counts;
  const parts: string[] = [];
  if (must > 0) {
    const notMet = brief.criteria.filter((r) => r.status === 'not_met').map(criterionLabel);
    parts.push(`${plural(must, 'must-fix issue', 'must-fix issues')}${notMet.length ? `: ${joinNames(notMet)} ${notMet.length === 1 ? 'isn\'t' : 'aren\'t'} met` : ''}.`);
  }
  const calls = brief.issues.filter((i) => i.group === 'call');
  if (calls.length > 0) {
    const verb = calls.length === 1 ? 'needs' : 'need';
    parts.push(`${must > 0 ? `${calls.length} more` : calls.length} ${verb} your decision: ${callReason(calls, brief.reviewers.length)}.`);
  }
  const minor = [should ? `${should} should-fix` : null, fyi ? `${fyi} FYI` : null].filter(Boolean).join(', ');
  if (minor) parts.push(brief.headline === 'minor' ? `Nothing blocks approval: ${minor}.` : `${minor}.`);
  return parts.join(' ');
}

/** How a reviewer's vote reads on an issue card: "Claude rates it Should fix", "Codex: not a problem". */
export function opinionVerdict(opinion: ReviewOpinion, name: string): string {
  if (opinion.decision === 'reject') return `${name}: not a problem`;
  if (opinion.decision === 'uncertain') return `${name}: unsure`;
  return opinion.severity ? `${name} rates it ${SEVERITY_LABEL[opinion.severity]}` : `${name} confirms it`;
}

/** First `max` characters of a long text, cut at a word boundary. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 20)).trimEnd()}…`;
}

/** `file:line`, `file`, or null. */
export function locationOf(issue: Pick<ReviewIssue, 'file' | 'line'>): string | null {
  if (!issue.file) return null;
  return issue.line !== null ? `${issue.file}:${issue.line}` : issue.file;
}
