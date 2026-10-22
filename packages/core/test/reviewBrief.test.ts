import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildReviewBrief } from '../src/reviewBrief.js';
import { parseAiReviewComment, summarizeAiReview } from '../src/aiReview.js';
import { candidateOutcome, consensusFindings, consensusFindingSchema, type ConsensusCandidate, type ConsensusVote, type ReviewConsensus } from '../src/reviewConsensus.js';
import type { AiReviewSummary, ReviewBrief } from '../src/types.js';

interface Fixture { acceptanceCriteria: string; review: { reviewer: string; verdict: string; findings: unknown[]; consensus: ReviewConsensus } }
const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/review-brief/af146-round3.json', import.meta.url), 'utf8')) as Fixture;
const AC = FIXTURE.acceptanceCriteria;
const CLAUDE = 'claude/claude-fable-5-1';
const CODEX = 'codex/gpt-6-astra (medium)';

/** The stored comment as the board parses it: marker line + fenced payload. */
function summaryOf(review: Fixture['review'], superseded = false): AiReviewSummary {
  const parsed = parseAiReviewComment(`ai-review/v2 - ${review.verdict}: ${review.findings.length} confirmed findings\n\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\``);
  expect(parsed).not.toBeNull();
  return summarizeAiReview(parsed, superseded)!;
}

/** AF-146 as a reviewer on the new contract would have posted it (spec §5.5). */
const REPORTED: Record<string, string[]> = { F1: ['AC6'], F2: ['AC7'], F3: ['AC5'], F4: [], F5: ['AC3'], F6: ['AC4'], F7: ['AC6'], F8: ['AC2'], F9: ['AC5'] };
function withReportedLinks(): Fixture['review'] {
  const review = structuredClone(FIXTURE.review);
  for (const c of review.consensus.candidates) c.finding = { ...c.finding, criteria: REPORTED[c.id]! };
  review.findings = consensusFindings(review.consensus).map((f) => consensusFindingSchema.parse(f));
  return review;
}

const shape = (brief: ReviewBrief) => brief.issues.map((i) => [i.id, i.group, i.dispute, i.merged.map((m) => m.id), i.criteria]);
const rows = (brief: ReviewBrief) => brief.criteria.map((r) => [r.id, r.status, r.issueIds]);

describe('buildReviewBrief — AF-146 round 3 (spec §5.5)', () => {
  it('the stored (legacy) comment: 7 distinct issues, duplicates merged, links from the titles only', () => {
    const brief = buildReviewBrief(summaryOf(FIXTURE.review), AC, 'implementation')!;
    expect(brief.headline).toBe('changes_needed');
    expect(brief.reviewers).toEqual([CLAUDE, CODEX]);
    expect(brief.headSha).toBe('4699e45c9e47e9d45971b156c4f7773b86e3cfc3');
    expect(brief.counts).toEqual({ must: 2, call: 3, should: 2, fyi: 0, merged: 2, rejected: 0 });
    expect(shape(brief)).toEqual([
      ['F1', 'must', null, ['F7'], ['AC6']],
      ['F6', 'must', null, [], null],
      ['F3', 'call', 'severity', ['F9'], ['AC5']],
      ['F5', 'call', 'severity', [], null],
      ['F8', 'call', 'severity', [], null],
      ['F2', 'should', null, [], ['AC7']],
      ['F4', 'should', null, [], null],
    ]);
    expect(brief.unlinked).toBe(4);
    expect(rows(brief)).toEqual([
      ['AC1', 'clear', []], ['AC2', 'clear', []], ['AC3', 'clear', []], ['AC4', 'clear', []],
      ['AC5', 'your_call', ['F3']], ['AC6', 'not_met', ['F1']], ['AC7', 'concerns', ['F2']], ['AC8', 'clear', []],
    ]);
    expect(brief.criteria[3]).toMatchObject({ name: 'Race' });
    expect(brief.generalCriteria).toMatch(/^Each item is covered/);
    expect(brief.rejected).toEqual([]);
  });

  it('reviewer-reported links: AC4 and AC6 not met, AC2/AC3/AC5 your call, AC7 concerns, nothing unlinked', () => {
    const brief = buildReviewBrief(summaryOf(withReportedLinks()), AC, 'implementation')!;
    expect(shape(brief).map(([id, , , , criteria]) => [id, criteria])).toEqual([
      ['F1', ['AC6']], ['F6', ['AC4']], ['F3', ['AC5']], ['F5', ['AC3']], ['F8', ['AC2']], ['F2', ['AC7']], ['F4', []],
    ]);
    expect(brief.unlinked).toBe(0);
    expect(rows(brief)).toEqual([
      ['AC1', 'clear', []], ['AC2', 'your_call', ['F8']], ['AC3', 'your_call', ['F5']], ['AC4', 'not_met', ['F6']],
      ['AC5', 'your_call', ['F3']], ['AC6', 'not_met', ['F1']], ['AC7', 'concerns', ['F2']], ['AC8', 'clear', []],
    ]);
  });

  it('severity comes from the votes, and each side keeps its opinion and evidence', () => {
    const brief = buildReviewBrief(summaryOf(FIXTURE.review), AC, 'implementation')!;
    const f5 = brief.issues.find((i) => i.id === 'F5')!;
    // raised as info, voted warning and error → a severity dispute, not FYI
    expect(f5.group).toBe('call');
    expect(f5.opinions.map((o) => [o.reviewer, o.decision, o.severity, o.reason])).toEqual([[CLAUDE, 'confirm', 'warning', null], [CODEX, 'confirm', 'error', null]]);
    expect(f5.opinions[0]!.evidence.length).toBeGreaterThan(100);
    const f1 = brief.issues[0]!;
    expect(f1).toMatchObject({ title: 'AC6 liveness not met: wall-clock kill ignores heartbeats', file: 'packages/dispatcher/src/dispatcher.ts', line: 253, source: CLAUDE, fix: null });
    expect(f1.problem).toMatch(/^enforceTimeouts\(\)/);
    expect(f1.merged[0]).toMatchObject({ id: 'F7', title: 'Healthy workers are still killed at the session age limit', source: CODEX });
  });

  it('a superseded review reads pending but keeps its issues', () => {
    const brief = buildReviewBrief(summaryOf(FIXTURE.review, true), AC, 'implementation')!;
    expect(brief.headline).toBe('pending');
    expect(brief.issues).toHaveLength(7);
  });

  it('a doc-stage review has no criteria rows', () => {
    const brief = buildReviewBrief(summaryOf(FIXTURE.review), AC, 'description')!;
    expect(brief.criteria).toEqual([]);
    expect(brief.generalCriteria).toBeNull();
    expect(brief.unlinked).toBe(0);
    expect(brief.issues).toHaveLength(7);
  });

  it('no review, no brief', () => {
    expect(buildReviewBrief(null, AC, 'implementation')).toBeNull();
  });
});

// ── synthetic consensus cases ─────────────────────────────────────────────

const A = 'claude/a';
const B = 'codex/b';
const vote = (reviewer: string, decision: ConsensusVote['decision'], severity: ConsensusVote['severity'], duplicateOf: string | null = null, reason?: string): ConsensusVote =>
  ({ reviewer, decision, severity, evidence: `${reviewer} looked at it`, duplicateOf, ...(reason !== undefined ? { reason } : {}) });
function candidate(id: string, votes: ConsensusVote[], title = `Issue ${id}`, criteria?: string[]): ConsensusCandidate {
  return { id, source: A, finding: { title, severity: 'warning', file: null, line: null, detail: null, ...(criteria ? { criteria } : {}) }, votes, outcome: candidateOutcome(votes) };
}
function consensusSummary(candidates: ConsensusCandidate[]): AiReviewSummary {
  const disputed = candidates.some((c) => c.outcome === 'disputed');
  return { verdict: disputed ? 'disputed' : 'findings', findings: 0, reviewer: `${A} + ${B}`, items: [],
    consensus: { participants: [A, B], status: disputed ? 'disputed' : 'agreed', candidates, history: [] } };
}
const CRITERIA = '1. One — a\n2. Two — b';

describe('buildReviewBrief — dispute kinds and merges', () => {
  it('confirm against reject is a validity dispute; all-uncertain is unverified; the reason rides the opinion', () => {
    const brief = buildReviewBrief(consensusSummary([
      candidate('F1', [vote(A, 'confirm', 'error', null, 'It loses data on retry.'), vote(B, 'reject', 'error', null, 'The guard already prevents it.')]),
      candidate('F2', [vote(A, 'uncertain', null), vote(B, 'uncertain', null)]),
      candidate('F3', [vote(A, 'confirm', 'warning'), vote(B, 'uncertain', null)]),
    ]), CRITERIA, 'implementation')!;
    expect(shape(brief).map(([id, group, dispute]) => [id, group, dispute])).toEqual([['F1', 'call', 'validity'], ['F2', 'call', 'unverified'], ['F3', 'call', 'validity']]);
    expect(brief.headline).toBe('your_call');
    expect(brief.issues[0]!.opinions.map((o) => o.reason)).toEqual(['It loses data on retry.', 'The guard already prevents it.']);
  });

  it('rejected candidates are listed apart, and a duplicate of a rejected root stays an issue of its own', () => {
    const brief = buildReviewBrief(consensusSummary([
      candidate('F1', [vote(A, 'reject', 'error'), vote(B, 'reject', null)]),
      candidate('F2', [vote(A, 'confirm', 'warning', 'F1'), vote(B, 'confirm', 'warning', 'F1')]),
    ]), CRITERIA, 'implementation')!;
    expect(brief.rejected.map((r) => [r.id, r.title, r.opinions.length])).toEqual([['F1', 'Issue F1', 2]]);
    expect(shape(brief)).toEqual([['F2', 'should', null, [], null]]);
    expect(brief.counts).toMatchObject({ should: 1, merged: 0, rejected: 1 });
    expect(brief.headline).toBe('minor');
  });

  it('a merged must raises a should root; chains resolve to the root; on a tie the root keeps its dispute kind', () => {
    const brief = buildReviewBrief(consensusSummary([
      candidate('F1', [vote(A, 'confirm', 'warning'), vote(B, 'confirm', 'warning')], 'Root', ['AC1']),
      candidate('F2', [vote(A, 'confirm', 'error', 'F1'), vote(B, 'confirm', 'error', 'F1')], 'Dup', ['AC2']),
      candidate('F3', [vote(A, 'confirm', 'info', 'F2'), vote(B, 'confirm', 'info', 'F2')], 'Dup of dup'),
      candidate('F4', [vote(A, 'confirm', 'warning'), vote(B, 'confirm', 'error')], 'Severity root'),
      candidate('F5', [vote(A, 'confirm', 'warning', 'F4'), vote(B, 'reject', 'error', 'F4')], 'Validity dup'),
      candidate('F6', [vote(A, 'confirm', 'warning', 'F4'), vote(B, 'confirm', 'warning', null)], 'Not every vote names it'),
    ]), CRITERIA, 'implementation')!;
    expect(shape(brief)).toEqual([
      ['F1', 'must', null, ['F2', 'F3'], ['AC1', 'AC2']],
      ['F4', 'call', 'severity', ['F5'], null],
      ['F6', 'should', null, [], null],
    ]);
    expect(brief.counts).toEqual({ must: 1, call: 1, should: 1, fyi: 0, merged: 3, rejected: 0 });
    expect(rows(brief)).toEqual([['AC1', 'not_met', ['F1']], ['AC2', 'not_met', ['F1']]]);
  });

  it('a clean consensus has the clean headline and no issues', () => {
    const brief = buildReviewBrief(consensusSummary([]), CRITERIA, 'implementation')!;
    expect(brief.headline).toBe('clean');
    expect(brief.issues).toEqual([]);
    expect(rows(brief)).toEqual([['AC1', 'clear', []], ['AC2', 'clear', []]]);
  });
});

describe('buildReviewBrief — single reviewer (v1)', () => {
  const v1 = (items: AiReviewSummary['items'], verdict: AiReviewSummary['verdict'] = 'findings'): AiReviewSummary =>
    ({ verdict, findings: items.length, reviewer: 'codex', items });

  it('maps each finding to F<n> by severity, with no opinions or merges', () => {
    const brief = buildReviewBrief(v1([
      { severity: 'error', file: 'a.ts', line: 3, title: 'Breaks AC2', detail: 'It throws.', fix: 'Catch it.' },
      { severity: 'warning', file: null, line: null, title: 'Slow', detail: null, criteria: [] },
      { severity: 'info', file: null, line: null, title: 'Naming', detail: null, criteria: ['AC1'] },
      { severity: null, file: null, line: null, title: 'Unrated', detail: null },
    ]), CRITERIA, 'implementation')!;
    expect(brief.issues.map((i) => [i.id, i.group, i.criteria, i.source, i.opinions, i.merged])).toEqual([
      ['F1', 'must', ['AC2'], 'codex', [], []],
      ['F2', 'should', [], 'codex', [], []],
      ['F4', 'should', null, 'codex', [], []],
      ['F3', 'fyi', ['AC1'], 'codex', [], []],
    ]);
    expect(brief.issues[0]).toMatchObject({ problem: 'It throws.', fix: 'Catch it.', file: 'a.ts', line: 3, dispute: null });
    expect(brief).toMatchObject({ headline: 'changes_needed', reviewers: ['codex'], headSha: null, unlinked: 1, rejected: [] });
    expect(rows(brief)).toEqual([['AC1', 'concerns', ['F3']], ['AC2', 'not_met', ['F1']]]);
  });

  it('a clean single review is clean', () => {
    expect(buildReviewBrief(v1([], 'clean'), CRITERIA, 'implementation')).toMatchObject({ headline: 'clean', issues: [] });
  });
});
