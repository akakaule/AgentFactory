import { describe, it, expect } from 'vitest';
import { deriveTaskMetrics, type ActivityStep } from '../src/metrics.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const iso = (min: number) => new Date(BASE + min * 60000).toISOString();

const move = (from: string | null, to: string, min: number): ActivityStep =>
  ({ type: 'status_change', fromStatus: from as ActivityStep['fromStatus'], toStatus: to as ActivityStep['toStatus'], createdAt: iso(min) });
const feedback = (min: number): ActivityStep =>
  ({ type: 'feedback', fromStatus: null, toStatus: null, createdAt: iso(min) });

describe('deriveTaskMetrics', () => {
  it('buckets stage durations across a simple done flow', () => {
    const m = deriveTaskMetrics([
      move(null, 'backlog', 0),
      move('backlog', 'queued', 10),
      move('queued', 'in_progress', 30),
      move('in_progress', 'in_review', 90),
      move('in_review', 'done', 150),
    ], iso(999));
    expect(m).toMatchObject({
      queueMin: 20, workMin: 60, reviewMin: 60, blockedMin: 0,
      rounds: 0, reopened: false, claimCount: 1, doneAt: iso(150),
    });
  });

  it('accumulates across review round-trips and counts feedback rounds', () => {
    const m = deriveTaskMetrics([
      move('backlog', 'queued', 10),
      move('queued', 'in_progress', 30),
      move('in_progress', 'in_review', 90),
      feedback(100),
      move('in_review', 'queued', 100),
      move('queued', 'in_progress', 110),
      move('in_progress', 'in_review', 140),
      move('in_review', 'done', 200),
    ], iso(999));
    expect(m).toMatchObject({
      queueMin: 30, workMin: 90, reviewMin: 70, blockedMin: 0,
      rounds: 1, claimCount: 2, doneAt: iso(200),
    });
  });

  it('tracks a blocked detour', () => {
    const m = deriveTaskMetrics([
      move('backlog', 'queued', 0),
      move('queued', 'in_progress', 30),
      move('in_progress', 'blocked', 50),
      move('blocked', 'in_progress', 70),
      move('in_progress', 'in_review', 100),
      move('in_review', 'done', 120),
    ], iso(999));
    expect(m).toMatchObject({ queueMin: 30, workMin: 50, blockedMin: 20, reviewMin: 20 });
  });

  it('flags reopened tasks and keeps the last done timestamp', () => {
    const m = deriveTaskMetrics([
      move('backlog', 'queued', 0),
      move('queued', 'in_progress', 10),
      move('in_progress', 'in_review', 100),
      move('in_review', 'done', 150),
      move('done', 'queued', 200),
      move('queued', 'in_progress', 220),
      move('in_progress', 'in_review', 260),
      move('in_review', 'done', 300),
    ], iso(999));
    expect(m).toMatchObject({ reopened: true, doneAt: iso(300), queueMin: 30, workMin: 130 });
  });

  it('accrues the open segment of an in-flight task to now', () => {
    const m = deriveTaskMetrics([
      move('backlog', 'queued', 10),
      move('queued', 'in_progress', 30),
    ], iso(45));
    expect(m).toMatchObject({ queueMin: 20, workMin: 15, doneAt: null });
  });

  it('counts open queue wait but no claims for a never-claimed task', () => {
    const m = deriveTaskMetrics([move('backlog', 'queued', 10)], iso(40));
    expect(m).toMatchObject({ queueMin: 30, workMin: 0, claimCount: 0 });
  });

  it('returns zeros for an unworked backlog task', () => {
    const m = deriveTaskMetrics([move(null, 'backlog', 0)], iso(60));
    expect(m).toMatchObject({ queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0, rounds: 0, claimCount: 0, doneAt: null });
  });
});
