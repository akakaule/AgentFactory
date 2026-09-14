import { z } from 'zod';
import { parseAiReviewComment, type AiReviewFinding, type TaskDetail } from '@agentfactory/core';
import type { ReviewerProfile } from './config.js';
import { ensureMarker } from './review.js';

export interface ReviewRound {
  fingerprint: string;
  members: Array<{ profile: ReviewerProfile; prompt: string }>;
  results: Array<{ reviewer: string; body: string; findings: AiReviewFinding[] }>;
}

/** Comments/telemetry do not supersede a submission; deliverable edits and result IDs do. */
export function reviewFingerprint(task: TaskDetail): string {
  return JSON.stringify([task.status, task.stage, task.activity.filter((a) => a.type === 'result').at(-1)?.id,
    task.title, task.spec, task.acceptanceCriteria, task.plan, task.branch, task.links]);
}

const outputSchema = z.object({
  verdict: z.enum(['clean', 'findings']),
  findings: z.array(z.object({
    title: z.string().trim().min(1),
    severity: z.enum(['info', 'warning', 'error']).nullish(),
    file: z.string().nullish(), line: z.number().int().nullish(), detail: z.string().nullish(),
  })),
}).refine((v) => (v.verdict === 'clean') === (v.findings.length === 0), 'verdict contradicts findings');

/** Fail closed: the core's lenient display parser must not drop malformed findings here. */
export function collectReview(round: ReviewRound, body: string): void {
  const member = round.members[round.results.length];
  if (!member) throw new Error('review round already complete');
  const marked = ensureMarker(body, member.profile.engine);
  const fenced = marked.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? marked.slice(marked.indexOf('{'), marked.lastIndexOf('}') + 1);
  if (!candidate.trim()) throw new Error(`${member.profile.engine} produced no review JSON`);
  outputSchema.parse(JSON.parse(candidate));
  const parsed = parseAiReviewComment(marked);
  if (!parsed) throw new Error('invalid ai-review/v1 output');
  const { engine, model, reasoningEffort } = member.profile;
  const reviewer = `${engine}${model ? `/${model}` : ''}${reasoningEffort ? ` (${reasoningEffort})` : ''}`;
  round.results.push({ reviewer, body: marked, findings: parsed.findings });
}

export function combinedReview(round: ReviewRound): string {
  if (round.results.length !== round.members.length) throw new Error('review round incomplete');
  const reviewer = round.results.map((r) => r.reviewer).join(' + ');
  const findings = round.results.flatMap((r) => r.findings.map((f) => ({ ...f, title: `[${r.reviewer}] ${f.title}` })));
  return [
    `ai-review/v1 - ${findings.length ? `${findings.length} findings` : 'clean'} (${reviewer})`,
    'All configured reviewers completed independently. Findings from each reviewer are retained.',
    '```json', JSON.stringify({ reviewer, verdict: findings.length ? 'findings' : 'clean', findings }), '```',
    ...round.results.map((r) => `\n### ${r.reviewer}\n${r.body}`),
  ].join('\n');
}
