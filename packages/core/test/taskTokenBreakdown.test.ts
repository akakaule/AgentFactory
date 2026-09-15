import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { addTaskMetrics } from '../src/ops/addTaskMetrics.js';
import { getTask } from '../src/ops/getTask.js';

describe('task token breakdown', () => {
  it('groups reports by session stage, recorded engine and model without losing totals', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'Usage', spec: 'S', acceptanceCriteria: 'A' });
    const at = (minute: number) => `2026-09-14T10:${String(minute).padStart(2, '0')}:00.000Z`;
    const session = (stage: string, start: number, end: number) => db.prepare(
      'INSERT INTO agent_session(task_id, workspace, stage, started_at, heartbeat_at, ended_at) VALUES (?,?,?,?,?,?)',
    ).run(task.id, 'default', stage, at(start), at(end), at(end));
    session('description', 10, 15);
    session('plan', 20, 25);
    session('implementation', 30, 35);
    // Reports on the start boundary and after submit must retain their pipeline stage.
    addTaskMetrics(db, task.key, { tokensIn: 100, tokensOut: 10, model: 'model-a', reportedBy: 'otel:claude' }, () => at(10));
    addTaskMetrics(db, task.key, { tokensIn: 200, tokensOut: 20, model: 'model-b', reportedBy: 'otel:codex' }, () => at(22));
    addTaskMetrics(db, task.key, { tokensIn: 300, tokensOut: 30, model: 'model-b', reportedBy: 'otel:codex' }, () => at(32));
    addTaskMetrics(db, task.key, { tokensIn: 400, tokensOut: 40, model: 'model-b', reportedBy: 'otel:codex' }, () => at(36));
    addTaskMetrics(db, task.key, { tokensIn: 50, tokensOut: 5, model: 'model-a', reportedBy: 'otel:claude' }, () => at(37));
    // A report before any claim is unknown; a model name does not prove an engine.
    addTaskMetrics(db, task.key, { tokensIn: 7, model: 'gpt-example', reportedBy: 'wrapper' }, () => at(1));
    // Another task's sessions and usage must not leak into this task.
    const other = createTask(db, { title: 'Other', spec: 'S', acceptanceCriteria: 'A' });
    addTaskMetrics(db, other.key, { tokensIn: 99999 });

    expect(getTask(db, task.key).metrics).toMatchObject({
      tokensIn: 1057, tokensOut: 105,
      tokenBreakdown: [
        { stage: 'description', agent: 'claude', model: 'model-a', tokensIn: 100, tokensOut: 10 },
        { stage: 'plan', agent: 'codex', model: 'model-b', tokensIn: 200, tokensOut: 20 },
        { stage: 'implementation', agent: 'claude', model: 'model-a', tokensIn: 50, tokensOut: 5 },
        { stage: 'implementation', agent: 'codex', model: 'model-b', tokensIn: 700, tokensOut: 70 },
        { stage: null, agent: null, model: 'gpt-example', tokensIn: 7, tokensOut: null },
      ],
    });
  });

  it('keeps unreported counts distinct from zero and omits reports without token usage', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'Usage', spec: 'S', acceptanceCriteria: 'A' });
    expect(getTask(db, task.key).metrics).toMatchObject({ tokenBreakdown: [] });
    addTaskMetrics(db, task.key, { costUsd: 1, model: 'cost-only' });
    addTaskMetrics(db, task.key, { tokensOut: 0 });
    expect(getTask(db, task.key).metrics).toMatchObject({
      tokenBreakdown: [{ stage: null, agent: null, model: null, tokensIn: null, tokensOut: 0 }],
    });
    addTaskMetrics(db, task.key, { tokensIn: 20 });
    expect(getTask(db, task.key).metrics).toMatchObject({
      tokenBreakdown: [{ stage: null, agent: null, model: null, tokensIn: 20, tokensOut: 0 }],
    });
  });
});
