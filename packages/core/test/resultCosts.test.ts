import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { resultEventsFor } from '../src/resultCosts.js';
import type { ActivityStep } from '../src/metrics.js';

const step = (fromStatus: ActivityStep['fromStatus'], toStatus: ActivityStep['toStatus'], body = '', createdAt = '2026-06-01T00:00:00.000Z'): ActivityStep =>
  ({ type: 'status_change', fromStatus, toStatus, body, createdAt });

describe('resultEventsFor', () => {
  it('reads approved specs, merged PRs and delivery repairs from the activity log', () => {
    const db = makeTestDb();
    const events = resultEventsFor(db, 1, 'ws', [
      step('in_review', 'queued', 'auto-approved: clean AI review; stage description → implementation'),
      step('in_review', 'queued', 'approved; stage plan → implementation'), // legacy plan approval: not a spec, not a send-back
      step('delivering', 'queued', 'CI failed'),
      step('delivering', 'done', 'PR #12 merged; checks passed. Original delivery complete; further CI repair is separate work.'),
      step('delivering', 'done', 'force-completed by a human'), // not a verified merge
    ]);
    expect(events.map((e) => [e.kind, e.stage])).toEqual([
      ['approved_spec', 'description'], ['delivery_repair', 'implementation'], ['merged_pr', 'implementation'],
    ]);
  });
});
