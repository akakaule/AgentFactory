import { describe, expect, it } from 'vitest';
import { openCore, createHttpCore, reviewSubmissionFingerprint } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

describe('consensus over the HTTP core boundary', () => {
  it('preserves disputed outcomes and rejects a stale publication atomically', async () => {
    const core = openCore(':memory:'); const app = buildApp(core, { auth: { mode: 'token' } });
    const token = core.createApiToken({ label: 'reviewer', isService: true }).token;
    const http = createHttpCore('http://board', token, { fetchImpl: ((url: string | URL | Request, init?: RequestInit) => app.request(url as string, init)) as typeof fetch });
    const task = core.createTask({ title: 'HTTP consensus', spec: 'S', acceptanceCriteria: 'A', stage: 'plan' });
    core.updateStatus(task.key, 'queued', 'human'); core.claimNextTask({ claimedBy: 'worker' }); core.submitResult(task.key, { summary: 'Plan', plan: 'Steps' });
    const participants = ['claude/fable', 'codex/astra'];
    const payload = { reviewer: participants.join(' + '), verdict: 'disputed', findings: [], consensus: {
      participants, status: 'disputed', history: [], submission: { key: task.key, fingerprint: reviewSubmissionFingerprint(core.getTask(task.key)) }, candidates: [{
        id: 'F1', source: participants[0], finding: { title: 'Gap', severity: 'error', file: null, line: null, detail: 'Evidence' }, outcome: 'disputed',
        votes: participants.map((reviewer, i) => ({ reviewer, decision: i ? 'reject' : 'confirm', severity: 'error', evidence: 'Checked the plan', duplicateOf: null })),
      }],
    } };
    const body = 'ai-review/v2\n```json\n' + JSON.stringify(payload) + '\n```';
    await http.addComment(task.key, { actor: 'agent', body });
    expect(await http.getTask(task.key)).toMatchObject({ status: 'in_review', stage: 'plan', aiReview: { verdict: 'disputed' } });
    expect((await http.listTasks({ status: 'in_review' }))[0]?.aiReview?.verdict).toBe('disputed');
    core.reviewRequestChanges(task.key, { feedback: 'Rework' }); core.claimNextTask({ claimedBy: 'replacement' }); core.submitResult(task.key, { summary: 'New plan', plan: 'New steps' });
    await expect(http.addComment(task.key, { actor: 'agent', body })).rejects.toThrow('submission changed');
    expect(core.getTask(task.key).activity.filter(a => a.body.startsWith('ai-review/v2'))).toHaveLength(1);
  });
});
