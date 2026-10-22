/**
 * The review brief — the AI review shaped for the human decision at the review gate
 * (docs/spec/2026-10-21-review-decision-panel-design.md §5). Pure and derived at read time from
 * the AiReviewSummary and the task's acceptance criteria, so it works on every stored review. It
 * lives in core because the approve rule (ops/approval.ts) needs the same headline the board
 * shows, and the web client can import core's types but not its runtime.
 */
import type {
  AiReviewFinding, AiReviewSeverity, AiReviewSummary, ReviewBrief, ReviewCandidateRef, ReviewCriterionRow,
  ReviewDispute, ReviewGroup, ReviewHeadline, ReviewIssue, ReviewOpinion, Stage,
} from './types.js';
import type { ConsensusCandidate, ReviewConsensus } from './reviewConsensus.js';
import { parseAcceptanceCriteria } from './acceptanceCriteria.js';

const GROUP_RANK: Record<ReviewGroup, number> = { must: 0, call: 1, should: 2, fyi: 3 };
const SEVERITY_GROUP: Record<AiReviewSeverity, ReviewGroup> = { error: 'must', warning: 'should', info: 'fyi' };
// legacy reviews have no criteria field: take the ids a title mentions ("AC6 liveness not met")
const TITLE_CRITERION = /\bAC\s?(\d+)\b/gi;

interface Placement { group: ReviewGroup; dispute: ReviewDispute | null }

/** Group and dispute kind of a non-rejected candidate, from its outcome and votes (§5.1 table). */
function placement(c: ConsensusCandidate): Placement {
  if (c.outcome === 'confirmed') return { group: SEVERITY_GROUP[c.votes[0]!.severity!], dispute: null };
  if (c.votes.every((v) => v.decision === 'confirm')) return { group: 'call', dispute: 'severity' };
  if (c.votes.every((v) => v.decision === 'uncertain')) return { group: 'call', dispute: 'unverified' };
  return { group: 'call', dispute: 'validity' };
}

const opinionsOf = (c: ConsensusCandidate): ReviewOpinion[] =>
  c.votes.map((v) => ({ reviewer: v.reviewer, decision: v.decision, severity: v.severity, reason: v.reason ?? null, evidence: v.evidence }));
const refOf = (c: ConsensusCandidate): ReviewCandidateRef => ({ id: c.id, title: c.finding.title, source: c.source, opinions: opinionsOf(c) });
const byCriterionNumber = (a: string, b: string) => Number(a.slice(2)) - Number(b.slice(2));

/**
 * The criterion ids an issue puts at risk: the union of what its findings report, else (legacy)
 * the known ids their titles mention, else null — unknown.
 */
function criteriaOf(findings: AiReviewFinding[], known: Set<string>): string[] | null {
  const reported = findings.filter((f) => f.criteria !== undefined);
  if (reported.length) return [...new Set(reported.flatMap((f) => f.criteria!))].sort(byCriterionNumber);
  if (known.size === 0) return null;
  const ids = new Set<string>();
  for (const f of findings) for (const m of f.title.matchAll(TITLE_CRITERION)) {
    const id = `AC${Number(m[1])}`;
    if (known.has(id)) ids.add(id);
  }
  return ids.size ? [...ids].sort(byCriterionNumber) : null;
}

function issueOf(id: string, finding: AiReviewFinding, at: Placement, source: string | null, opinions: ReviewOpinion[]): ReviewIssue {
  return {
    id, group: at.group, dispute: at.dispute, title: finding.title, problem: finding.detail, fix: finding.fix ?? null,
    file: finding.file, line: finding.line, criteria: null, source, opinions, merged: [],
  };
}

/** §5.1: walk the candidates in order — rejected apart, unanimous duplicates into their root. */
function consensusIssues(consensus: ReviewConsensus, known: Set<string>): { issues: ReviewIssue[]; rejected: ReviewCandidateRef[] } {
  const issues = new Map<string, { issue: ReviewIssue; findings: AiReviewFinding[] }>();
  const mergedInto = new Map<string, string>(); // merged candidate id → root issue id
  const rejectedIds = new Set<string>();
  const rejected: ReviewCandidateRef[] = [];
  for (const c of consensus.candidates) {
    if (c.outcome === 'rejected') { rejectedIds.add(c.id); rejected.push(refOf(c)); continue; }
    const at = placement(c);
    const target = c.votes[0]?.duplicateOf ?? null;
    let root = target !== null && c.votes.every((v) => v.duplicateOf === target) ? target : null;
    // duplicateOf only points at earlier candidates, so the root is already resolved
    while (root !== null && mergedInto.has(root)) root = mergedInto.get(root)!;
    const into = root !== null && !rejectedIds.has(root) ? issues.get(root) : undefined;
    if (into) {
      mergedInto.set(c.id, root!);
      into.issue.merged.push(refOf(c));
      into.findings.push(c.finding);
      // a merged candidate raises its root; on a tie the root wins
      if (GROUP_RANK[at.group] < GROUP_RANK[into.issue.group]) { into.issue.group = at.group; into.issue.dispute = at.dispute; }
      continue;
    }
    issues.set(c.id, { issue: issueOf(c.id, c.finding, at, c.source, opinionsOf(c)), findings: [c.finding] });
  }
  for (const { issue, findings } of issues.values()) issue.criteria = criteriaOf(findings, known);
  return { issues: [...issues.values()].map((x) => x.issue), rejected };
}

/** §5.2: a single reviewer's findings, F1…Fn by position, grouped by severity (null → should). */
function singleReviewIssues(review: AiReviewSummary, known: Set<string>): ReviewIssue[] {
  return review.items.map((f, i) => {
    const issue = issueOf(`F${i + 1}`, f, { group: f.severity ? SEVERITY_GROUP[f.severity] : 'should', dispute: null }, review.reviewer, []);
    issue.criteria = criteriaOf([f], known);
    return issue;
  });
}

function headlineOf(review: AiReviewSummary, issues: ReviewIssue[]): ReviewHeadline {
  if (review.verdict === 'pending') return 'pending';
  if (issues.some((i) => i.group === 'must')) return 'changes_needed';
  if (issues.some((i) => i.group === 'call')) return 'your_call';
  return issues.length ? 'minor' : 'clean';
}

function rowStatus(linked: ReviewIssue[]): ReviewCriterionRow['status'] {
  if (linked.some((i) => i.group === 'must')) return 'not_met';
  if (linked.some((i) => i.group === 'call')) return 'your_call';
  return linked.length ? 'concerns' : 'clear';
}

export function buildReviewBrief(review: AiReviewSummary | null, acceptanceCriteria: string, stage: Stage): ReviewBrief | null {
  if (!review) return null;
  const parsed = parseAcceptanceCriteria(acceptanceCriteria);
  const known = new Set(parsed.items.map((i) => i.id));
  const consensus = review.consensus;
  const { issues: unordered, rejected } = consensus ? consensusIssues(consensus, known) : { issues: singleReviewIssues(review, known), rejected: [] };
  // Array.prototype.sort is stable: candidate order holds within a group
  const issues = [...unordered].sort((a, b) => GROUP_RANK[a.group] - GROUP_RANK[b.group]);
  const count = (g: ReviewGroup) => issues.filter((i) => i.group === g).length;
  // the criteria are the deliverable at the doc stages, so only an implementation review has rows
  const criteria: ReviewCriterionRow[] = stage === 'implementation'
    ? parsed.items.map((item) => {
      const linked = issues.filter((i) => i.criteria?.includes(item.id));
      return { id: item.id, name: item.name, text: item.text, status: rowStatus(linked), issueIds: linked.map((i) => i.id) };
    })
    : [];
  return {
    headline: headlineOf(review, issues),
    reviewers: consensus ? consensus.participants : review.reviewer ? [review.reviewer] : [],
    headSha: consensus?.submission?.headSha ?? null,
    counts: { must: count('must'), call: count('call'), should: count('should'), fyi: count('fyi'),
      merged: issues.reduce((n, i) => n + i.merged.length, 0), rejected: rejected.length },
    issues, rejected, criteria,
    generalCriteria: criteria.length ? parsed.general : null,
    unlinked: criteria.length ? issues.filter((i) => i.criteria === null).length : 0,
  };
}
