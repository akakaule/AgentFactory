import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { answerBlock } from '../src/ops/answerBlock.js';
import { listTasks } from '../src/ops/listTasks.js';
import { getTask } from '../src/ops/getTask.js';
import { formatBlockNote, parseBlockNote, type DecisionRequest } from '../src/decision.js';
import { InvalidTransitionError, ValidationError } from '../src/errors.js';

const decision: DecisionRequest = {
  question: 'Refresh the token on every request or near expiry?',
  options: [
    { id: 'expiry', label: 'Only near expiry', detail: 'one refresh per hour' },
    { id: 'every', label: 'On every request' },
  ],
  recommended: 'expiry',
};

function blockedTask(note?: string) {
  const db = makeTestDb();
  const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  db.prepare("UPDATE task SET status='in_progress', branch='feature/t' WHERE key=?").run(task.key);
  updateStatus(db, task.key, 'blocked', 'agent', undefined, null, note);
  return { db, key: task.key };
}

describe('decision/v1 block notes', () => {
  it('round-trips the reason and the decision', () => {
    const body = formatBlockNote('spec does not say how', decision);
    expect(parseBlockNote(body)).toEqual({ reason: 'spec does not say how', decision });
  });

  it('uses the question as the reason when none is given', () => {
    expect(parseBlockNote(formatBlockNote(undefined, decision)).reason).toBe(decision.question);
  });

  it('a plain note has no decision', () => {
    expect(parseBlockNote('needs a DB password')).toEqual({ reason: 'needs a DB password', decision: null });
  });

  it('a malformed marker yields no decision and stays out of the reason', () => {
    expect(parseBlockNote('stuck\ndecision/v1 {"question":"q","options":[]}')).toEqual({ reason: 'stuck', decision: null });
  });

  it('refuses a decision whose recommendation is not an option', () => {
    expect(() => formatBlockNote('x', { ...decision, recommended: 'nope' })).toThrow(ValidationError);
  });

  it('refuses a decision with one option', () => {
    expect(() => formatBlockNote('x', { ...decision, options: [decision.options[0]!] })).toThrow(ValidationError);
  });
});

describe('Task.block', () => {
  it('list rows and detail carry the reason and decision of a blocked task', () => {
    const { db, key } = blockedTask(formatBlockNote('spec is ambiguous', decision));
    const row = listTasks(db).find((t) => t.key === key)!;
    expect(row.block?.reason).toBe('spec is ambiguous');
    expect(row.block?.decision).toEqual(decision);
    expect(getTask(db, key).block?.decision?.recommended).toBe('expiry');
  });

  it('is null once the task is no longer blocked', () => {
    const { db, key } = blockedTask('needs a password');
    updateStatus(db, key, 'queued', 'human');
    expect(listTasks(db).find((t) => t.key === key)!.block).toBeNull();
  });
});

describe('answerBlock', () => {
  it('records the chosen option as binding feedback and re-queues', () => {
    const { db, key } = blockedTask(formatBlockNote('spec is ambiguous', decision));
    const detail = answerBlock(db, key, { optionId: 'expiry', answer: 'and log each refresh' });
    expect(detail.status).toBe('queued');
    const fb = detail.activity.find((a) => a.type === 'feedback')!;
    expect(fb.actor).toBe('human');
    expect(fb.body).toContain(`Answer to your question: ${decision.question}`);
    expect(fb.body).toContain('Chosen: Only near expiry');
    expect(fb.body).toContain('and log each refresh');
    const moved = detail.activity.find((a) => a.type === 'status_change' && a.toStatus === 'queued')!;
    expect(moved.body).toBe('answered: Only near expiry');
  });

  it('takes a free-text answer for a plain block', () => {
    const { db, key } = blockedTask('needs a DB password');
    const detail = answerBlock(db, key, { answer: 'use the one in the vault' });
    expect(detail.status).toBe('queued');
    expect(detail.activity.find((a) => a.type === 'feedback')!.body).toContain('Answer to your question: needs a DB password');
  });

  it('refuses an unknown option, an empty answer and a task that is not blocked', () => {
    const { db, key } = blockedTask(formatBlockNote('x', decision));
    expect(() => answerBlock(db, key, { optionId: 'nope' })).toThrow(ValidationError);
    expect(() => answerBlock(db, key, { answer: '   ' })).toThrow(ValidationError);
    answerBlock(db, key, { optionId: 'every' });
    expect(() => answerBlock(db, key, { optionId: 'every' })).toThrow(InvalidTransitionError);
  });
});
