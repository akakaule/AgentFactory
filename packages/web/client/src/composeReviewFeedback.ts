import type { ReviewBrief, ReviewIssue } from './types.js';
import { locationOf, shortNames } from './reviewText.js';

/** The human's decision on one issue: send it back as Must fix or Should fix, or dismiss it.
 *  An issue with no decision is not sent. */
export type ReviewDecision = 'must' | 'should' | 'dismiss';
export type ReviewDecisions = Partial<Record<string, ReviewDecision>>;

/** Must issues start as Must fix and should issues as Should fix; your-call and FYI issues wait for
 *  the human. A pending review (a newer result awaits review) is read-only, so nothing is preselected. */
export function defaultDecisions(brief: ReviewBrief | null): ReviewDecisions {
  const out: ReviewDecisions = {};
  if (!brief || brief.headline === 'pending') return out;
  for (const issue of brief.issues) {
    if (issue.group === 'must') out[issue.id] = 'must';
    else if (issue.group === 'should') out[issue.id] = 'should';
  }
  return out;
}

/** The issues that go back to the agent, in issue order, with how each is sent. */
export function selectedIssues(brief: ReviewBrief | null, decisions: ReviewDecisions): Array<{ issue: ReviewIssue; as: 'must' | 'should' }> {
  return (brief?.issues ?? []).flatMap((issue) => {
    const as = decisions[issue.id];
    return as === 'must' || as === 'should' ? [{ issue, as }] : [];
  });
}

const indent = (text: string) => text.split('\n').join('\n   ');

function entry(n: number, issue: ReviewIssue): string {
  const loc = locationOf(issue);
  const head = [issue.id, ...(issue.criteria ?? []), issue.title].join(' · ');
  return [
    `${n}. ${head}${loc ? ` (${loc})` : ''}`,
    ...(issue.problem ? [`   Problem: ${indent(issue.problem)}`] : []),
    ...(issue.fix ? [`   Fix: ${indent(issue.fix)}`] : []),
  ].join('\n');
}

/**
 * The request-changes body the agent gets (spec §6.7): a line naming the review, the issues decided
 * Must fix and Should fix — each with its criteria, location, problem and fix — and the human's note.
 * Sections with no entries are left out. With nothing selected (or no review) it is the note alone.
 */
export function composeReviewFeedback(brief: ReviewBrief | null, decisions: ReviewDecisions, note: string): string {
  const selected = selectedIssues(brief, decisions);
  const trimmed = note.trim();
  if (!brief || selected.length === 0) return trimmed;
  const names = [...shortNames(brief.reviewers).values()].join(' + ');
  const of = brief.headSha ? ` of ${brief.headSha.slice(0, 7)}` : '';
  const sections = [`Changes requested after the AI review${of}${names ? ` (${names})` : ''}, curated by a human.`];
  for (const [as, title] of [['must', 'Must fix'], ['should', 'Should fix']] as const) {
    const issues = selected.filter((s) => s.as === as).map((s) => s.issue);
    if (issues.length) sections.push(`## ${title}\n\n${issues.map((issue, i) => entry(i + 1, issue)).join('\n')}`);
  }
  if (trimmed) sections.push(`## Note from the human reviewer\n\n${trimmed}`);
  return sections.join('\n\n');
}
