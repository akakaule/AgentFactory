import { z } from 'zod';
import type { AiReviewFinding, TaskDetail } from './types.js';

/** The same generation check runs in the supervisor and inside core's write transaction. */
export function reviewSubmissionFingerprint(task: TaskDetail): string {
  return JSON.stringify([task.status, task.stage, task.activity.filter(a => a.type === 'result').at(-1)?.id,
    task.title, task.spec, task.acceptanceCriteria, task.plan, task.branch, task.links]);
}

export const consensusFindingSchema = z.object({
  title: z.string().trim().min(1), severity: z.enum(['error', 'warning', 'info']).nullable(),
  file: z.string().nullable(), line: z.number().int().nullable(), detail: z.string().nullable(),
}).strict();
export const consensusVoteSchema = z.object({
  reviewer: z.string().min(1), decision: z.enum(['confirm', 'reject', 'uncertain']),
  severity: z.enum(['error', 'warning', 'info']).nullable(), evidence: z.string().trim().min(1),
  duplicateOf: z.string().min(1).nullable(),
}).strict();
const candidateSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), finding: consensusFindingSchema,
  votes: z.array(consensusVoteSchema), outcome: z.enum(['confirmed', 'rejected', 'disputed']),
}).strict();
export const consensusSchema = z.object({
  submission: z.object({ key: z.string().min(1), fingerprint: z.string().min(1),
    headSha: z.string().optional(), baseSha: z.string().optional() }).strict().optional(),
  participants: z.array(z.string().min(1)).min(2).max(8),
  status: z.enum(['agreed', 'disputed']), candidates: z.array(candidateSchema).max(200),
  history: z.array(z.object({ phase: z.enum(['discovery', 'cross-examination', 'final-ballot']), reviewer: z.string(), body: z.string() }).strict()).max(24),
}).strict();
export type ConsensusVote = z.infer<typeof consensusVoteSchema>;
export type ConsensusCandidate = z.infer<typeof candidateSchema>;
export type ReviewConsensus = z.infer<typeof consensusSchema>;

export function candidateOutcome(votes: ConsensusVote[]): ConsensusCandidate['outcome'] {
  if (votes.length && votes.every(v => v.decision === 'reject')) return 'rejected';
  if (votes.length && votes.every(v => v.decision === 'confirm' && v.severity !== null && v.severity === votes[0]!.severity)) return 'confirmed';
  return 'disputed';
}

/** Shared by the trusted supervisor and the core boundary: derive, never trust final totals. */
export function consensusFindings(consensus: ReviewConsensus): AiReviewFinding[] {
  const { participants, candidates } = consensus;
  if (new Set(participants).size !== participants.length || new Set(candidates.map(c => c.id)).size !== candidates.length) throw new Error('duplicate consensus identity');
  const findings: AiReviewFinding[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!participants.includes(candidate.source) || candidate.votes.length !== participants.length
      || new Set(candidate.votes.map(v => v.reviewer)).size !== participants.length
      || candidate.votes.some(v => !participants.includes(v.reviewer))) throw new Error('incomplete consensus votes');
    if (candidate.outcome !== candidateOutcome(candidate.votes)) throw new Error('outcome contradicts votes');
    for (const vote of candidate.votes) {
      if (vote.duplicateOf !== null && !candidates.slice(0, index).some(c => c.id === vote.duplicateOf)) throw new Error('invalid duplicate target');
    }
    if (candidate.outcome !== 'confirmed') continue;
    const duplicate = candidate.votes[0]!.duplicateOf;
    const target = candidates.find(c => c.id === duplicate);
    if (target?.outcome === 'confirmed' && candidate.votes.every(v => v.duplicateOf === duplicate)
      && target.votes[0]!.severity === candidate.votes[0]!.severity) continue;
    findings.push({ ...candidate.finding, severity: candidate.votes[0]!.severity });
  }
  const disputed = candidates.some(c => c.outcome === 'disputed');
  if (consensus.status !== (disputed ? 'disputed' : 'agreed')) throw new Error('consensus status contradicts votes');
  if (consensus.history.some(h => !participants.includes(h.reviewer))) throw new Error('unknown discussion participant');
  return findings;
}

const finalSchema = z.object({ reviewer: z.string().min(1), verdict: z.enum(['clean', 'findings', 'disputed']),
  findings: z.array(consensusFindingSchema), consensus: consensusSchema }).strict();
export function parseConsensusReview(raw: unknown): z.infer<typeof finalSchema> | null {
  const parsed = finalSchema.safeParse(raw);
  if (!parsed.success) return null;
  try {
    const data = parsed.data;
    const findings = consensusFindings(data.consensus);
    const verdict = data.consensus.status === 'disputed' ? 'disputed' : findings.length ? 'findings' : 'clean';
    if (verdict !== data.verdict || JSON.stringify(findings.map(f => consensusFindingSchema.parse(f))) !== JSON.stringify(data.findings)) return null;
    return data;
  } catch { return null; }
}
