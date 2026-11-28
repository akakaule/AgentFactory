import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import type { DB } from '../src/db.js';
import { createCore, intakeRevision, buildIntakeComment, formatReviewRevision, defaultIntakeSettings, normalizeIntakeSettings, ValidationError, InvalidTransitionError,
  type Complexity, type Risk, type IntakeAssessmentV1 } from '../src/index.js';
import { createTask } from '../src/ops/createTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { addComment } from '../src/ops/addComment.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { getTask } from '../src/ops/getTask.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { appendActivity, recentActivity } from '../src/repo/activity.js';
import { isValidTransition } from '../src/transitions.js';

const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);
const GITHUB = () => 'https://github.com/acme/shop.git';
let tick = 0;
const now = () => new Date(Date.UTC(2030, 0, 1, 0, 0, tick++)).toISOString();

// Task Intelligence validates whole distributions, so each choice carries one (its value is the mode).
const COMPLEXITIES: Complexity[] = ['trivial', 'small', 'medium', 'large', 'architectural'];
const RISKS: Risk[] = ['low', 'medium', 'high', 'critical'];
function one<T extends string>(value: T, all: T[]) {
  const rest = (1 - 0.7) / (all.length - 1);
  return { value, probabilities: Object.fromEntries(all.map((v) => [v, v === value ? 0.7 : rest])) as Record<T, number>, confidence: null };
}

function assessment(key: string, revision: string, o: { complexity?: Complexity; risk?: Risk; ready?: number } = {}): IntakeAssessmentV1 {
  const ready = o.ready ?? 0.92;
  return {
    schema: 'intake/v1', status: 'assessed', taskKey: key, sourceRevision: revision, attemptId: null, stage: 'implementation',
    questionSet: 'intake-questions/v1', provider: { name: 'jev', model: 'jev-1' }, usage: { inputTokens: null, outputTokens: null },
    assessedAt: '2030-01-01T00:00:00.000Z', latencyMs: 1,
    decisions: {
      readiness: { probability: ready, parts: { outcomeClear: ready, scopeBounded: 0.95, verifiable: 0.95 } },
      complexity: one(o.complexity ?? 'small', COMPLEXITIES), risk: one(o.risk ?? 'medium', RISKS),
    },
  };
}

const cleanReview = (submissionId: number, headSha: string | null = HEAD) =>
  `ai-review/v1 - clean (codex)\n\`\`\`json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n\`\`\`\n${formatReviewRevision({ submissionId, headSha, baseSha: BASE })}`;
const findingsReview = (submissionId: number) =>
  `ai-review/v1 - 1 finding (codex)\n\`\`\`json\n{"reviewer":"codex","verdict":"findings","findings":[{"severity":"error","file":"x.ts","line":1,"title":"bug","detail":"broken","criteria":["AC1"]}]}\n\`\`\`\n${formatReviewRevision({ submissionId, headSha: HEAD, baseSha: BASE })}`;

interface Setup { policy?: boolean; listed?: boolean; risk?: Risk; complexity?: Complexity; ready?: number; assess?: 'current' | 'stale' | 'none'; head?: string | null }

/** A shop-workspace implementation task, submitted at HEAD, assessed by Task Intelligence, waiting for its review. */
function seed(o: Setup = {}): { db: DB; key: string; submissionId: number } {
  const db = makeTestDb();
  const core = createCore(db);
  core.createWorkspace({ name: 'shop', repoPath: '/repos/shop' });
  core.setIntakeSettings({ mode: 'advisory', workspaces: ['shop'], ...(o.policy === false ? {} : { autoApproveWorkspaces: o.listed === false ? [] : ['shop'] }) });
  const t = createTask(db, { title: 'Add a guard', spec: 'Do the thing.', acceptanceCriteria: '1. AC1 — the thing is done', stage: 'implementation', workspace: 'shop' });
  db.prepare("UPDATE task SET status='in_progress', branch='feature/x' WHERE key=?").run(t.key);
  const head = o.head === undefined ? HEAD : o.head;
  const sub = submitResult(db, t.key, { summary: 'done', ...(head ? { revision: { headSha: head, baseSha: BASE, source: 'origin' as const } } : {}) }, now).submission!;
  if ((o.assess ?? 'current') !== 'none') {
    const task = getTask(db, t.key);
    const revision = o.assess === 'stale' ? 'stale-revision' : intakeRevision(task);
    appendActivity(db, { taskId: t.id, type: 'comment', actor: 'agent', createdAt: now(),
      body: buildIntakeComment(assessment(t.key, revision, { ...(o.risk ? { risk: o.risk } : {}), ...(o.complexity ? { complexity: o.complexity } : {}), ...(o.ready !== undefined ? { ready: o.ready } : {}) })) });
  }
  return { db, key: t.key, submissionId: sub.id };
}

const statusOf = (db: DB, key: string) => findRowByKey(db, key)!.status;

describe('auto-approve: a clean, low-risk implementation review approves itself', () => {
  it('approves to delivering when risk ≤ medium, complexity ≤ medium and the bound review is clean', () => {
    const { db, key, submissionId } = seed({ risk: 'medium', complexity: 'medium' });
    addComment(db, key, { actor: 'agent', body: cleanReview(submissionId) }, now, GITHUB);

    expect(statusOf(db, key)).toBe('delivering');
    const detail = getTask(db, key);
    expect(detail.delivery).toMatchObject({ provider: 'github', branch: 'feature/x' });
    const change = recentActivity(db, findRowByKey(db, key)!.id, 10).find((a) => a.type === 'status_change' && a.toStatus === 'delivering')!;
    expect(change.actor).toBe('agent');
    expect(change.actorUserId ?? null).toBeNull();
    expect(change.body).toContain('auto-approved: clean AI review');
    expect(change.body).toContain('risk medium');
    expect(change.body).toContain('complexity medium');
    expect(change.body).toContain(`approved submission #${submissionId} at ${HEAD.slice(0, 7)}`);
    expect(isValidTransition(change.fromStatus!, change.toStatus!, change.actor)).toBe(true);
  });

  it.each<[string, Setup]>([
    ['the policy is off', { policy: false }],
    ['the workspace is not listed', { listed: false }],
    ['risk is high', { risk: 'high' }],
    ['risk is critical', { risk: 'critical' }],
    ['complexity is large', { complexity: 'large' }],
    ['complexity is architectural', { complexity: 'architectural' }],
    ['the assessment is stale', { assess: 'stale' }],
    ['there is no assessment', { assess: 'none' }],
    ['Task Intelligence flags it for attention (low readiness)', { ready: 0.3 }],
  ])('stays in review when %s', (_why, setup) => {
    const { db, key, submissionId } = seed(setup);
    addComment(db, key, { actor: 'agent', body: cleanReview(submissionId) }, now, GITHUB);
    expect(statusOf(db, key)).toBe('in_review');
  });

  it('stays in review when the review has findings', () => {
    const { db, key, submissionId } = seed();
    addComment(db, key, { actor: 'agent', body: findingsReview(submissionId) }, now, GITHUB);
    expect(statusOf(db, key)).toBe('in_review');
  });

  it('stays in review when the review is unbound (names no submission)', () => {
    const { db, key } = seed();
    addComment(db, key, { actor: 'agent', body: 'ai-review/v1 - clean (codex)\n```json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n```' }, now, GITHUB);
    expect(statusOf(db, key)).toBe('in_review');
  });

  it('stays in review when the submission recorded no head (nothing proves what was reviewed)', () => {
    const { db, key, submissionId } = seed({ head: null });
    addComment(db, key, { actor: 'agent', body: cleanReview(submissionId, null) }, now, GITHUB);
    expect(statusOf(db, key)).toBe('in_review');
  });

  it('stays in review when the workspace origin is not a git host (no PR or CI would follow)', () => {
    const { db, key, submissionId } = seed();
    addComment(db, key, { actor: 'agent', body: cleanReview(submissionId) }, now, () => null);
    expect(statusOf(db, key)).toBe('in_review');
  });

  it('never consults git for comments that cannot qualify', () => {
    const { db, key } = seed();
    let calls = 0;
    addComment(db, key, { actor: 'human', body: 'just a note' }, now, () => { calls++; return null; });
    expect(calls).toBe(0);
  });
});

describe('auto-approve guards', () => {
  it('an agent cannot use the new edge as a raw status move', () => {
    const { db, key } = seed();
    expect(() => updateStatus(db, key, 'delivering', 'agent')).toThrow(InvalidTransitionError);
    expect(statusOf(db, key)).toBe('in_review');
  });
});

describe('auto-approve settings', () => {
  it('is off by default with medium / medium ceilings', () => {
    expect(defaultIntakeSettings).toMatchObject({ autoApproveWorkspaces: [], autoApproveMaxRisk: 'medium', autoApproveMaxComplexity: 'medium' });
  });

  it('a stored document from before these fields normalizes to off', () => {
    expect(normalizeIntakeSettings({ mode: 'advisory', workspaces: ['shop'] })).toMatchObject({ mode: 'advisory', workspaces: ['shop'], autoApproveWorkspaces: [] });
  });

  it('refuses ceilings above medium', () => {
    const core = createCore(makeTestDb());
    expect(() => core.setIntakeSettings({ autoApproveMaxRisk: 'high' as never })).toThrow(ValidationError);
    expect(() => core.setIntakeSettings({ autoApproveMaxComplexity: 'large' as never })).toThrow(ValidationError);
  });
});
