import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { linksFor } from '../src/repo/links.js';
import { getTask } from '../src/ops/getTask.js';
import { ValidationError, NotFoundError, InvalidTransitionError } from '../src/errors.js';
import type { Status } from '../src/types.js';

const FIXED_TS = '2030-07-01T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

describe('submitResult', () => {
  it('in_progress → in_review: status, resultSummary, links, updatedAt all set correctly', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    const detail = submitResult(
      db,
      task.key,
      { summary: 'did the thing', links: [{ kind: 'pr', label: 'PR #1', url: 'http://x/1' }] },
      fixedNow,
    );

    expect(detail.status).toBe('in_review');
    expect(detail.resultSummary).toBe('did the thing');
    expect(detail.links).toHaveLength(1);
    expect(detail.links[0].kind).toBe('pr');
    expect(detail.links[0].label).toBe('PR #1');
    expect(detail.links[0].url).toBe('http://x/1');
    expect(detail.updatedAt).toBe(FIXED_TS);

    // Verify DB row
    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_review');
    expect(row.result_summary).toBe('did the thing');
    expect(row.updated_at).toBe(FIXED_TS);
  });

  it('re-submission does not duplicate identical links (but new links still land)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const branchLink = { kind: 'branch' as const, label: 'feature/x', url: 'http://x/tree/feature/x' };

    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    submitResult(db, task.key, { summary: 'round 1', links: [branchLink] }, fixedNow);
    // request-changes round-trip, then the finish protocol resends the same branch link + a new PR
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    submitResult(db, task.key, {
      summary: 'round 2',
      links: [branchLink, { kind: 'pr', label: 'PR #1', url: 'http://x/pull/1' }],
    }, fixedNow);

    const links = linksFor(db, task.id);
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.kind).sort()).toEqual(['branch', 'pr']);
  });

  it('appends both result and status_change activities; both present in returned activity', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    const detail = submitResult(db, task.key, { summary: 'done' }, fixedNow);

    const resultAct = detail.activity.find(a => a.type === 'result');
    const statusAct = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'in_review');

    expect(resultAct).toBeDefined();
    expect(resultAct!.actor).toBe('agent');
    expect(resultAct!.body).toBe('done');
    expect(resultAct!.createdAt).toBe(FIXED_TS);

    expect(statusAct).toBeDefined();
    expect(statusAct!.actor).toBe('agent');
    expect(statusAct!.fromStatus).toBe('in_progress');
    expect(statusAct!.toStatus).toBe('in_review');
    expect(statusAct!.createdAt).toBe(FIXED_TS);
  });

  it('updatedAt is bumped to the injected ts', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    const detail = submitResult(db, task.key, { summary: 'done' }, fixedNow);

    expect(detail.updatedAt).toBe(FIXED_TS);
  });

  it.each<Status>(['backlog', 'queued', 'in_review', 'done', 'blocked'])(
    'rejects from status=%s with InvalidTransitionError; nothing changed',
    (status) => {
      const db = makeTestDb();
      const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
      db.prepare("UPDATE task SET status=? WHERE key=?").run(status, task.key);

      const activityBefore = recentActivity(db, task.id, 100).length;
      const linksBefore = linksFor(db, task.id).length;

      expect(() =>
        submitResult(db, task.key, { summary: 'should fail' })
      ).toThrow(InvalidTransitionError);

      // Status unchanged
      const row = findRowByKey(db, task.key)!;
      expect(row.status).toBe(status);
      expect(row.result_summary).toBeNull();

      // No new activity or links written
      expect(recentActivity(db, task.id, 100).length).toBe(activityBefore);
      expect(linksFor(db, task.id).length).toBe(linksBefore);
    },
  );

  it('empty summary throws ValidationError', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    expect(() =>
      submitResult(db, task.key, { summary: '   ' })
    ).toThrow(ValidationError);
  });

  it('unknown key throws NotFoundError', () => {
    const db = makeTestDb();

    expect(() =>
      submitResult(db, 'AF-9999', { summary: 'done' })
    ).toThrow(NotFoundError);
  });
});

describe('submitResult — stage deliverables', () => {
  const seedInProgress = (db: ReturnType<typeof makeTestDb>, stage: 'description' | 'plan' | 'implementation') => {
    const task = createTask(db, { title: 'T', spec: 'Raw idea', acceptanceCriteria: 'A', stage });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    return task;
  };

  it('description stage persists the rewritten spec + acceptanceCriteria and flips to in_review', () => {
    const db = makeTestDb();
    const task = seedInProgress(db, 'description');

    const detail = submitResult(db, task.key, {
      summary: 'description written',
      spec: 'Polished feature description',
      acceptanceCriteria: '- it works',
    }, fixedNow);

    expect(detail.status).toBe('in_review');
    expect(detail.stage).toBe('description'); // submit does not advance the stage — approval does
    expect(detail.spec).toBe('Polished feature description');
    expect(detail.acceptanceCriteria).toBe('- it works');
    expect(detail.resultSummary).toBe('description written');
  });

  it('description stage snapshots the human original spec/AC before overwriting them', () => {
    const db = makeTestDb();
    const task = seedInProgress(db, 'description'); // seed spec='Raw idea', AC='A'

    const detail = submitResult(db, task.key, {
      summary: 'description written',
      spec: 'Polished feature description',
      acceptanceCriteria: '- it works',
    }, fixedNow);

    // current fields hold the agent's rewrite, original* preserve the human wording
    expect(detail.spec).toBe('Polished feature description');
    expect(detail.acceptanceCriteria).toBe('- it works');
    expect(detail.originalSpec).toBe('Raw idea');
    expect(detail.originalAcceptanceCriteria).toBe('A');
  });

  it('a re-submitted description (after request-changes) keeps the first snapshot', () => {
    const db = makeTestDb();
    const task = seedInProgress(db, 'description');

    submitResult(db, task.key, { summary: 'v1', spec: 'Rewrite v1', acceptanceCriteria: 'AC v1' }, fixedNow);
    // simulate a human bouncing it back to in_progress for another pass
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    const detail = submitResult(db, task.key, { summary: 'v2', spec: 'Rewrite v2', acceptanceCriteria: 'AC v2' }, fixedNow);

    expect(detail.spec).toBe('Rewrite v2');
    expect(detail.originalSpec).toBe('Raw idea'); // still the human's original, not 'Rewrite v1'
    expect(detail.originalAcceptanceCriteria).toBe('A');
  });

  it('implementation stage leaves original* null (nothing was overwritten)', () => {
    const db = makeTestDb();
    const task = seedInProgress(db, 'implementation');

    const detail = submitResult(db, task.key, { summary: 'done' }, fixedNow);

    expect(detail.originalSpec).toBeNull();
    expect(detail.originalAcceptanceCriteria).toBeNull();
  });

  it('plan stage persists the plan and flips to in_review', () => {
    const db = makeTestDb();
    const task = seedInProgress(db, 'plan');

    const detail = submitResult(db, task.key, { summary: 'plan written', plan: '1. do x\n2. do y' }, fixedNow);

    expect(detail.status).toBe('in_review');
    expect(detail.stage).toBe('plan');
    expect(detail.plan).toBe('1. do x\n2. do y');
    expect(detail.spec).toBe('Raw idea'); // untouched
  });

  it.each([
    ['description', { summary: 's' }],                                            // missing spec + AC
    ['description', { summary: 's', spec: 'x' }],                                 // missing AC
    ['description', { summary: 's', spec: 'x', acceptanceCriteria: 'a', plan: 'p' }], // plan not accepted
    ['plan', { summary: 's' }],                                                   // missing plan
    ['plan', { summary: 's', plan: 'p', spec: 'x' }],                             // spec not accepted
    ['implementation', { summary: 's', spec: 'x' }],                              // doc fields not accepted
    ['implementation', { summary: 's', plan: 'p' }],
  ] as const)('%s stage rejects a wrong-shape payload %j and changes nothing', (stage, input) => {
    const db = makeTestDb();
    const task = seedInProgress(db, stage);

    expect(() => submitResult(db, task.key, { ...input }, fixedNow)).toThrow(ValidationError);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_progress');
    expect(row.result_summary).toBeNull();
    expect(row.plan).toBeNull();
  });

  it('the rejection message names the stage and the expected fields', () => {
    const db = makeTestDb();
    const task = seedInProgress(db, 'plan');

    expect(() => submitResult(db, task.key, { summary: 's' }, fixedNow)).toThrow(/plan stage/);
  });
});

describe('submitResult — the worker\'s claim per acceptance criterion', () => {
  const AC = '1. Race — one claim wins\n2. Logs — one line per claim';
  function inProgress(stage: 'implementation' | 'description' = 'implementation') {
    const db = makeTestDb();
    const task = stage === 'description'
      ? createTask(db, { title: 'T', spec: 'S', stage })
      : createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: AC });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    return { db, task };
  }
  const claimComments = (db: ReturnType<typeof makeTestDb>, id: number) =>
    recentActivity(db, id, 50).filter(a => a.type === 'comment' && a.body.startsWith('criteria-claims/v1'));

  it('stores the claims as one criteria-claims/v1 comment after the result and exposes them on the detail', () => {
    const { db, task } = inProgress();
    const detail = submitResult(db, task.key, { summary: 'done', criteria: [
      { id: 'ac2', claim: '  One log line per claim; logs.test.ts proves it.  ' },
      { id: 'AC1', claim: 'The reservation is a unique insert; race.test.ts runs two supervisors.' },
    ] }, fixedNow);
    expect(detail.criteriaClaims).toEqual([
      { id: 'AC2', claim: 'One log line per claim; logs.test.ts proves it.' },
      { id: 'AC1', claim: 'The reservation is a unique insert; race.test.ts runs two supervisors.' },
    ]);
    const comments = claimComments(db, task.id);
    expect(comments).toHaveLength(1);
    const result = detail.activity.find(a => a.type === 'result')!;
    expect(comments[0]!.id).toBeGreaterThan(result.id);
    expect(comments[0]!.actor).toBe('agent');
  });

  it('leaving criteria out (or passing none) is allowed and stores nothing', () => {
    for (const criteria of [undefined, []]) {
      const { db, task } = inProgress();
      const detail = submitResult(db, task.key, { summary: 'done', ...(criteria ? { criteria } : {}) }, fixedNow);
      expect(detail.criteriaClaims).toBeNull();
      expect(claimComments(db, task.id)).toEqual([]);
    }
  });

  it('rejects unknown and duplicate ids with an error that names the valid ids, and changes nothing', () => {
    const { db, task } = inProgress();
    expect(() => submitResult(db, task.key, { summary: 'done', criteria: [{ id: 'AC9', claim: 'x' }] }, fixedNow))
      .toThrow(new ValidationError('unknown criterion AC9; this task has AC1–AC2'));
    expect(() => submitResult(db, task.key, { summary: 'done', criteria: [{ id: 'AC1', claim: 'x' }, { id: 'ac1', claim: 'y' }] }, fixedNow))
      .toThrow(new ValidationError('criterion AC1 is listed twice; this task has AC1–AC2'));
    expect(() => submitResult(db, task.key, { summary: 'done', criteria: [{ id: 'AC1', claim: 'x'.repeat(601) }] }, fixedNow)).toThrow(ValidationError);
    expect(() => submitResult(db, task.key, { summary: 'done', criteria: [{ id: 'AC1', claim: '   ' }] }, fixedNow)).toThrow(ValidationError);
    expect(findRowByKey(db, task.key)!.status).toBe('in_progress');
    expect(claimComments(db, task.id)).toEqual([]);
  });

  it('a task whose criteria text has no list still has AC1', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'It works.' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    expect(() => submitResult(db, task.key, { summary: 'done', criteria: [{ id: 'AC2', claim: 'x' }] }, fixedNow))
      .toThrow(new ValidationError('unknown criterion AC2; this task has AC1'));
  });

  it('is rejected on a doc stage, the way verification is', () => {
    const { db, task } = inProgress('description');
    expect(() => submitResult(db, task.key, { summary: 'S', spec: 'S2', acceptanceCriteria: AC, criteria: [{ id: 'AC1', claim: 'x' }] }, fixedNow))
      .toThrow(/plan\/verification\/criteria are not accepted/);
  });

  it('a later claims comment that does not parse does not hide the real claims', () => {
    const { db, task } = inProgress();
    submitResult(db, task.key, { summary: 'done', criteria: [{ id: 'AC1', claim: 'Proven by race.test.ts.' }] }, fixedNow);
    db.prepare("INSERT INTO activity(task_id, type, actor, body, created_at) VALUES (?, 'comment', 'agent', 'criteria-claims/v1 (see above)', ?)").run(task.id, FIXED_TS);
    expect(getTask(db, task.key).criteriaClaims).toEqual([{ id: 'AC1', claim: 'Proven by race.test.ts.' }]);
  });

  it('a newer result without claims clears them; the claims survive a long activity tail', () => {
    const { db, task } = inProgress();
    submitResult(db, task.key, { summary: 'done', criteria: [{ id: 'AC1', claim: 'Proven by race.test.ts.' }] }, fixedNow);
    const insert = db.prepare("INSERT INTO activity(task_id, type, actor, body, created_at) VALUES (?, 'comment', 'human', ?, ?)");
    for (let i = 0; i < 60; i++) insert.run(task.id, `note ${i}`, FIXED_TS); // pushes the claims out of the 50-row activity slice
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    expect(submitResult(db, task.key, { summary: 'again', criteria: [{ id: 'AC2', claim: 'Proven by logs.test.ts.' }] }, fixedNow).criteriaClaims)
      .toEqual([{ id: 'AC2', claim: 'Proven by logs.test.ts.' }]);
    for (let i = 0; i < 60; i++) insert.run(task.id, `more ${i}`, FIXED_TS);
    expect(getTask(db, task.key).criteriaClaims).toEqual([{ id: 'AC2', claim: 'Proven by logs.test.ts.' }]);
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    expect(submitResult(db, task.key, { summary: 'third, no claims' }, fixedNow).criteriaClaims).toBeNull();
  });
});

describe('submitResult — workspace verification gate', () => {
  const setVerifyCommand = (db: ReturnType<typeof makeTestDb>, cmd: string | null) =>
    db.prepare('UPDATE workspace SET verify_command=? WHERE id=1').run(cmd);
  const seedImpl = (db: ReturnType<typeof makeTestDb>) => {
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);
    return task;
  };

  it('blocks an implementation submit with no verification when the workspace requires one', () => {
    const db = makeTestDb();
    setVerifyCommand(db, 'npm test && npm run build');
    const task = seedImpl(db);

    expect(() => submitResult(db, task.key, { summary: 'done' }, fixedNow)).toThrow(ValidationError);
    expect(() => submitResult(db, task.key, { summary: 'done' }, fixedNow)).toThrow(/npm test && npm run build/);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_progress'); // nothing advanced
  });

  it('accepts the submit when verification is reported, and records it as a comment', () => {
    const db = makeTestDb();
    setVerifyCommand(db, 'npm test');
    const task = seedImpl(db);

    const detail = submitResult(db, task.key, { summary: 'done', verification: 'all green' }, fixedNow);

    expect(detail.status).toBe('in_review');
    const verifyComment = detail.activity.find((a) => a.type === 'comment' && a.body === 'verify: all green');
    expect(verifyComment).toBeDefined();
    expect(verifyComment!.actor).toBe('agent');
  });

  it('does not require verification when the workspace configures no command (today’s behaviour)', () => {
    const db = makeTestDb();
    setVerifyCommand(db, null);
    const task = seedImpl(db);

    const detail = submitResult(db, task.key, { summary: 'done' }, fixedNow);
    expect(detail.status).toBe('in_review');
    expect(detail.activity.some((a) => a.type === 'comment' && a.body.startsWith('verify:'))).toBe(false);
  });

  it('rejects verification on a doc stage even when a command is configured', () => {
    const db = makeTestDb();
    setVerifyCommand(db, 'npm test');
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'plan' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    expect(() => submitResult(db, task.key, { summary: 's', plan: 'p', verification: 'green' }, fixedNow)).toThrow(ValidationError);
  });
});
