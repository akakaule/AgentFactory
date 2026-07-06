import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { addPrFeedback } from '../src/ops/addPrFeedback.js';
import { applyFeedbackFix } from '../src/ops/applyFeedbackFix.js';
import { addComment } from '../src/ops/addComment.js';
import { buildPrFeedbackComment, parsePrFeedbackComment, buildFeedbackEvalComment, parseFeedbackEvalComment } from '../src/prFeedback.js';
import { ValidationError } from '../src/errors.js';
import type { DB } from '../src/db.js';

function deliveringTask(db: DB): string {
  const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  db.prepare("UPDATE task SET status='delivering', branch='feature/x' WHERE key=?").run(t.key);
  return t.key;
}

describe('pr-feedback / feedback-eval markers', () => {
  it('round-trips both markers; malformed/unknown degrade to null', () => {
    expect(parsePrFeedbackComment(buildPrFeedbackComment({ feedback: 'fix the null check', author: 'sam' })))
      .toEqual({ feedback: 'fix the null check', author: 'sam', url: null });
    expect(parseFeedbackEvalComment(buildFeedbackEvalComment({ disposition: 'warranted', reasoning: 'real npe', suggestedChange: 'add a guard' })))
      .toEqual({ disposition: 'warranted', reasoning: 'real npe', suggestedChange: 'add a guard' });
    expect(parseFeedbackEvalComment('feedback-eval/v1\n```json\n{"disposition":"nope"}\n```')).toBeNull();
    expect(parsePrFeedbackComment('just a plain comment')).toBeNull();
  });
});

describe('addPrFeedback', () => {
  it('appends a pr-feedback/v1 comment on a delivering task without changing status', () => {
    const db = makeTestDb();
    const key = deliveringTask(db);
    const detail = addPrFeedback(db, key, { feedback: 'please rename X to Y' });
    expect(detail.status).toBe('delivering');
    const last = detail.activity.filter((a) => a.type === 'comment').at(-1)!;
    expect(parsePrFeedbackComment(last.body)?.feedback).toBe('please rename X to Y');
  });

  it('refuses a non-delivering task and empty feedback', () => {
    const db = makeTestDb();
    const backlog = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(() => addPrFeedback(db, backlog.key, { feedback: 'x' })).toThrow(ValidationError);
    const key = deliveringTask(db);
    expect(() => addPrFeedback(db, key, { feedback: '   ' })).toThrow(ValidationError);
  });
});

describe('applyFeedbackFix', () => {
  it('pulls delivering→queued with a composed feedback activity (PR comment + suggested change)', () => {
    const db = makeTestDb();
    const key = deliveringTask(db);
    addPrFeedback(db, key, { feedback: 'the retry loop can spin forever' });
    addComment(db, key, { actor: 'agent', body: buildFeedbackEvalComment({ disposition: 'warranted', reasoning: 'unbounded loop', suggestedChange: 'add a max-attempts guard' }) });

    const detail = applyFeedbackFix(db, key, null);
    expect(detail.status).toBe('queued');
    expect(detail.claimedBy).toBeNull(); // setStatus('queued') clears the claimant
    const fb = detail.activity.filter((a) => a.type === 'feedback').at(-1)!;
    expect(fb.body).toContain('the retry loop can spin forever');
    expect(fb.body).toContain('add a max-attempts guard');
  });

  it('refuses when no feedback was forwarded, and on a non-delivering task', () => {
    const db = makeTestDb();
    const key = deliveringTask(db);
    expect(() => applyFeedbackFix(db, key, null)).toThrow(ValidationError); // nothing to apply yet
    const backlog = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(() => applyFeedbackFix(db, backlog.key, null)).toThrow(ValidationError); // not delivering
  });
});
