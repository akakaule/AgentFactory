import { buildReviewBrief, consensusFindings, consensusFindingSchema, parseAiReviewComment, summarizeAiReview, type ReviewConsensus } from '@agentfactory/core';
import raw from '../../../../core/test/fixtures/review-brief/af146-round3.json?raw';
import type { AiReviewSummary, ReviewBrief, Stage } from '../../../client/src/types.js';

/** AF-146's round-3 consensus review (core's spec §5.5 fixture), built into briefs the way the board builds them. */
interface Fixture { acceptanceCriteria: string; review: { reviewer: string; verdict: string; findings: unknown[]; consensus: ReviewConsensus } }
const FIXTURE = JSON.parse(raw) as Fixture;

export const AF146_CRITERIA = FIXTURE.acceptanceCriteria;
export const AF146_HEAD = '4699e45c9e47e9d45971b156c4f7773b86e3cfc3';

const REPORTED: Record<string, string[]> = { F1: ['AC6'], F2: ['AC7'], F3: ['AC5'], F4: [], F5: ['AC3'], F6: ['AC4'], F7: ['AC6'], F8: ['AC2'], F9: ['AC5'] };

/** The review as the board parses it. `links` adds the new-contract criteria, a fix per finding and vote reasons. */
export function af146Review(opts: { links?: boolean; superseded?: boolean } = {}): AiReviewSummary {
  const review = structuredClone(FIXTURE.review);
  if (opts.links) {
    for (const c of review.consensus.candidates) {
      c.finding = { ...c.finding, criteria: REPORTED[c.id]!, fix: `Fix for ${c.id}.` };
      c.votes = c.votes.map((v) => ({ ...v, reason: `${v.reviewer.split('/')[0]} reason for ${c.id}.` }));
    }
    review.findings = consensusFindings(review.consensus).map((f) => consensusFindingSchema.parse(f));
  }
  const parsed = parseAiReviewComment(`ai-review/v2 - ${review.verdict}\n\n\`\`\`json\n${JSON.stringify(review)}\n\`\`\``);
  if (!parsed) throw new Error('AF-146 fixture no longer parses');
  return summarizeAiReview(parsed, opts.superseded ?? false)!;
}

export function af146Brief(opts: { links?: boolean; superseded?: boolean; stage?: Stage } = {}): ReviewBrief {
  return buildReviewBrief(af146Review(opts), AF146_CRITERIA, opts.stage ?? 'implementation')!;
}

/** A single-reviewer (v1) brief from plain findings. */
export function v1Brief(items: AiReviewSummary['items'], criteria = '1. Race — one claim wins\n2. Logs — one line', stage: Stage = 'implementation'): ReviewBrief {
  return buildReviewBrief({ verdict: items.length ? 'findings' : 'clean', findings: items.length, reviewer: 'codex', items }, criteria, stage)!;
}
