import { z } from 'zod';
import { parseReviewJson } from './reviewJson.js';
import { candidateOutcome, consensusFindings, consensusVoteSchema, normalizeCriteria, normalizeFix, parseConsensusReview, VOTE_REASON_MAX, type AiReviewFinding, type ConsensusCandidate, type ReviewConsensus } from '@agentfactory/core';

export interface DiscoveryResult { reviewer: string; body: string; findings: AiReviewFinding[] }
// criteria/fix are cleaned the way core's normalizeFinding cleans a discovery finding, so a late
// candidate satisfies the strict consensus schema and absent links stay absent
const newFindingSchema = z.object({ title: z.string().trim().min(1), severity: z.enum(['error', 'warning', 'info']),
  file: z.string().nullable(), line: z.number().int().nullable(), detail: z.string().nullable(),
  criteria: z.array(z.unknown()).nullable().optional(), fix: z.string().nullable().optional() }).strict()
  .transform(({ criteria: rawCriteria, fix: rawFix, ...finding }): AiReviewFinding => {
    const criteria = normalizeCriteria(rawCriteria);
    const fix = normalizeFix(rawFix);
    return { ...finding, ...(criteria !== undefined ? { criteria } : {}), ...(fix !== undefined ? { fix } : {}) };
  });
// an over-long reason is capped rather than failing the whole ballot (and the discussion round)
const voteReason = z.string().nullable().optional().transform((r) => r?.trim().slice(0, VOTE_REASON_MAX) || null);
const ballotSchema = z.object({
  votes: z.array(consensusVoteSchema.omit({ reviewer: true }).extend({ id: z.string().min(1), reason: voteReason }).strict()),
  newFindings: z.array(newFindingSchema).max(20).default([]),
}).strict();
type Ballot = z.infer<typeof ballotSchema>;
export interface ConsensusState {
  phase: 'cross-examination' | 'final-ballot' | 'complete';
  participants: string[];
  candidates: ConsensusCandidate[];
  history: ReviewConsensus['history'];
  ballots: Array<{ reviewer: string; ballot: Ballot }>;
}
export function createConsensus(results: DiscoveryResult[]): ConsensusState {
  const participants = results.map(r => r.reviewer);
  if (participants.length < 2 || new Set(participants).size !== participants.length) throw new Error('consensus needs distinct reviewers');
  const candidates: ConsensusCandidate[] = results.flatMap(r => r.findings.map(finding => ({
    id: '', source: r.reviewer, finding, votes: [], outcome: 'disputed' as const,
  }))).map((c, i) => ({ ...c, id: `F${i + 1}` }));
  if (candidates.length > 200) throw new Error('too many consensus candidates');
  return { phase: candidates.length ? 'cross-examination' : 'complete', participants, candidates,
    history: results.map(r => ({ phase: 'discovery', reviewer: r.reviewer, body: r.body })), ballots: [] };
}

export function collectBallot(state: ConsensusState, body: string): void {
  if (state.phase === 'complete') throw new Error('consensus already complete');
  const ballot = ballotSchema.parse(parseReviewJson(body));
  const expected = state.candidates.map(c => c.id);
  if (ballot.votes.length !== expected.length || new Set(ballot.votes.map(v => v.id)).size !== expected.length
    || ballot.votes.some(v => !expected.includes(v.id))) throw new Error('ballot must evaluate every candidate exactly once');
  for (const vote of ballot.votes) {
    if (vote.duplicateOf !== null && !expected.slice(0, expected.indexOf(vote.id)).includes(vote.duplicateOf)) throw new Error('duplicate target must be an earlier candidate');
  }
  const reviewer = state.participants[state.ballots.length];
  if (!reviewer) throw new Error('unexpected ballot');
  state.ballots.push({ reviewer, ballot });
  state.history.push({ phase: state.phase, reviewer, body });
  if (state.ballots.length !== state.participants.length) return;

  for (const candidate of state.candidates) {
    candidate.votes = state.ballots.map(({ reviewer, ballot }) => {
      const { id: _id, ...vote } = ballot.votes.find(v => v.id === candidate.id)!;
      return { reviewer, ...vote };
    });
    candidate.outcome = candidateOutcome(candidate.votes);
  }
  for (const { reviewer, ballot } of state.ballots) for (const finding of ballot.newFindings) {
    state.candidates.push({ id: `F${state.candidates.length + 1}`, source: reviewer, finding, outcome: 'disputed',
      votes: state.participants.map(reviewer => ({ reviewer, decision: 'uncertain', severity: null,
        evidence: 'New candidate requires independent evaluation by every reviewer.', duplicateOf: null })) });
  }
  if (state.candidates.length > 200) throw new Error('too many consensus candidates');
  const unresolved = state.candidates.some(c => c.outcome === 'disputed');
  state.phase = state.phase === 'cross-examination' && unresolved ? 'final-ballot' : 'complete';
  state.ballots = [];
}

export function consensusReview(state: ConsensusState, submission?: ReviewConsensus['submission']): string {
  if (state.phase !== 'complete') throw new Error('consensus incomplete');
  const consensus: ReviewConsensus = { participants: state.participants, candidates: state.candidates, history: state.history,
    ...(submission ? { submission } : {}),
    status: state.candidates.some(c => c.outcome === 'disputed') ? 'disputed' : 'agreed' };
  const findings = consensusFindings(consensus);
  const verdict = consensus.status === 'disputed' ? 'disputed' : findings.length ? 'findings' : 'clean';
  const payload = { reviewer: state.participants.join(' + '), verdict, findings, consensus };
  if (!parseConsensusReview(payload)) throw new Error('invalid final consensus');
  return `ai-review/v2 - ${verdict}: ${findings.length} confirmed findings\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
}
