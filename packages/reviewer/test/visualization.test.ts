import { describe, it, expect } from 'vitest';
import type { Core } from '@agentfactory/core';
import { Reviewer } from '../src/reviewer.js';
import { makeCore, seedInReview, aiReviewBody, makeConfig, makeDeps, makeFakeSpawn, makeFakeConsole, sampleHtml } from './helpers.js';
import type { ReviewerConfig } from '../src/config.js';

/** The test base has visualization off; these tests opt in (the production zod default is on). */
function vizConfig(overrides: Partial<ReviewerConfig> = {}): ReviewerConfig {
  return makeConfig({ visualization: { enabled: true }, ...overrides });
}

/** Serve the viz session HTML and the review session a clean verdict from the same fake. */
function byPath(vizOut: string, reviewOut = aiReviewBody(0)): (path: string) => string {
  return (path) => (path.includes('-viz-') ? vizOut : reviewOut);
}

const failureNote = (core: Core, key: string): boolean =>
  core.getTask(key).activity.some((a) => a.type === 'comment' && a.body.startsWith('failure/v1'));

describe('auto-visualization', () => {
  it('visualizes first, reviews next tick, and links the page from the verdict', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Ship it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(vizConfig(), makeDeps(core, spawn, { readOutput: byPath(sampleHtml()), console: makeFakeConsole() }));

    await r.tick(); // tick 1: the viz session takes the workspace's only slot
    expect(calls.length).toBe(1);
    const req = calls[0]!.req;
    expect(req.command).toBe('codex.exe');
    expect(req.args).toContain(`/logs/${key}-viz-1.out`);
    expect(req.stdin).toContain('<!doctype html>'); // the raw-HTML contract
    expect(req.stdin).toContain('=== DIFF ===');
    expect(req.stdin).not.toContain('ai-review/v1');

    await r.tick(); // same key running — nothing new spawns
    expect(calls.length).toBe(1);

    await calls[0]!.child.exit(0); // engine wrote the page → reviewer attaches it
    expect(core.getTask(key).hasVisualization).toBe(true);
    expect(core.getVisualizationHtml(key)).toBe(sampleHtml());

    await r.tick(); // tick 2: the review runs, page already attached
    expect(calls.length).toBe(2);
    expect(calls[1]!.req.args).toContain(`/logs/${key}-review-1.out`);
    await calls[1]!.child.exit(0);

    const comment = core.getTask(key).activity.find((a) => a.type === 'comment' && a.body.startsWith('ai-review/v1'));
    expect(comment).toBeDefined();
    expect(comment!.body.endsWith(`Visualization: /api/tasks/${key}/visualization`)).toBe(true);
    expect(core.getTask(key).aiReview?.verdict).toBe('clean'); // trailing link line doesn't break the parser

    await r.tick(); // all served — nothing new
    expect(calls.length).toBe(2);
  });

  it('doc stages get no visualization — the review runs immediately', async () => {
    const core = makeCore();
    seedInReview(core, 'ws', 'Plan it', 'plan');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(vizConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    expect(calls.length).toBe(1);
    expect(calls[0]!.req.args).toContain('/logs/AF-1-review-1.out');
  });

  it('a visualization newer than the latest submission is fresh — straight to review', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Already drawn', 'implementation');
    core.attachVisualization(key, { html: sampleHtml() }); // after submit ⇒ fresh
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(vizConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    expect(calls.length).toBe(1);
    expect(calls[0]!.req.args).toContain(`/logs/${key}-review-1.out`);
  });

  it('a visualization older than the latest submission is stale — it regenerates', async () => {
    const core = makeCore();
    const t = core.createTask({ title: 'Superseded page', spec: 's', acceptanceCriteria: 'ac', workspace: 'ws', stage: 'implementation' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ workspace: 'ws', claimedBy: 'worker' });
    core.attachVisualization(t.key, { html: sampleHtml('old') });
    await new Promise((res) => setTimeout(res, 5)); // strictly-later result timestamp
    core.submitResult(t.key, { summary: 'done', links: [{ kind: 'branch', label: 'feature/af-x', url: 'https://example.test/b' }] });

    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(vizConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    expect(calls.length).toBe(1);
    expect(calls[0]!.req.args).toContain(`/logs/${t.key}-viz-1.out`);
  });

  it('viz failures are log-only: no failure/v1, no review-budget burn, verdict posts without the link', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Stubborn page', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const r = new Reviewer(vizConfig({ maxAttempts: 2 }), makeDeps(core, spawn, { readOutput: byPath(''), console: log }));

    await r.tick(); // viz attempt 1 — empty output
    await calls[0]!.child.exit(0);
    expect(failureNote(core, key)).toBe(false);
    expect(log.warnings.some((w) => w.includes('visualization of AF-1 failed'))).toBe(true);

    await r.tick(); // viz attempt 2 — budget exhausted after this
    expect(calls[1]!.req.args).toContain(`/logs/${key}-viz-2.out`);
    await calls[1]!.child.exit(0);
    expect(log.warnings.some((w) => w.includes('giving up on visualization'))).toBe(true);

    await r.tick(); // review proceeds untouched by the viz burns
    expect(calls.length).toBe(3);
    expect(calls[2]!.req.args).toContain(`/logs/${key}-review-1.out`);
    await calls[2]!.child.exit(0);

    const t = core.getTask(key);
    expect(t.aiReview?.verdict).toBe('clean');
    expect(failureNote(core, key)).toBe(false);
    expect(r.isSkipListed(key)).toBe(false);
    const comment = t.activity.find((a) => a.type === 'comment' && a.body.startsWith('ai-review/v1'));
    expect(comment!.body).not.toContain('Visualization:'); // nothing to link
    expect(t.hasVisualization).toBe(false);

    await r.tick(); // no fourth spawn — viz stays given up until a new submission
    expect(calls.length).toBe(3);
  });

  it('salvages a fence-wrapped document', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Fenced', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(vizConfig(), makeDeps(core, spawn, { readOutput: byPath('```html\n' + sampleHtml() + '\n```'), console: makeFakeConsole() }));

    await r.tick();
    await calls[0]!.child.exit(0);
    expect(core.getVisualizationHtml(key)?.startsWith('<!doctype html>')).toBe(true);
  });

  it('prose-only output burns an attempt and attaches nothing', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Chatty engine', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const r = new Reviewer(vizConfig(), makeDeps(core, spawn, { readOutput: byPath('sorry, no page today'), console: log }));

    await r.tick();
    await calls[0]!.child.exit(0);
    expect(core.getTask(key).hasVisualization).toBe(false);
    expect(log.warnings.some((w) => w.includes('did not produce an HTML document'))).toBe(true);
    expect(failureNote(core, key)).toBe(false);
  });

  it('an oversize document burns an attempt', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Huge page', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const huge = '<!doctype html>' + 'a'.repeat(4 * 1024 * 1024);
    const r = new Reviewer(vizConfig(), makeDeps(core, spawn, { readOutput: byPath(huge), console: log }));

    await r.tick();
    await calls[0]!.child.exit(0);
    expect(core.getTask(key).hasVisualization).toBe(false);
    expect(log.warnings.some((w) => w.includes('exceeds'))).toBe(true);
  });

  it('a hung viz session times out, is killed, and burns log-only', async () => {
    let nowMs = 0;
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Hung artist', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const deps = {
      ...makeDeps(core, spawn, { now: () => nowMs, readOutput: byPath(''), console: log }),
      terminateProcessTree: () => void calls[0]!.child.kill('SIGKILL'),
    };
    const r = new Reviewer(vizConfig({ reviewMinutes: 10 }), deps);

    await r.tick();
    nowMs = 11 * 60_000;
    await r.tick();

    expect(core.getTask(key).hasVisualization).toBe(false);
    expect(log.warnings.some((w) => w.includes('timed out'))).toBe(true);
    expect(failureNote(core, key)).toBe(false);
  });

  it('accepts a completed codex page found at the timeout boundary', async () => {
    let nowMs = 0;
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Slow but done', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const deps = {
      ...makeDeps(core, spawn, { now: () => nowMs, readOutput: byPath(sampleHtml()), console: makeFakeConsole() }),
      terminateProcessTree: () => void calls[0]!.child.kill('SIGKILL'),
    };
    const r = new Reviewer(vizConfig({ reviewMinutes: 10 }), deps);

    await r.tick();
    nowMs = 11 * 60_000;
    await r.tick();

    expect(core.getTask(key).hasVisualization).toBe(true);
  });

  it('a failed attach does not burn — the next poll retries and succeeds', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Flaky board', 'implementation');
    let failOnce = true;
    const wrapped = {
      ...core,
      attachVisualization: (k: string, input: { html: string }) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('board unreachable');
        }
        return core.attachVisualization(k, input);
      },
    } as Core;
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const r = new Reviewer(vizConfig(), makeDeps(wrapped, spawn, { readOutput: byPath(sampleHtml()), console: log }));

    await r.tick();
    await calls[0]!.child.exit(0); // attach throws — logged, not burned
    expect(log.errors.some((e) => e.includes('failed to attach visualization'))).toBe(true);

    await r.tick(); // retried as attempt 1 of the same submission
    expect(calls.length).toBe(2);
    expect(calls[1]!.req.args).toContain(`/logs/${key}-viz-1.out`);
    await calls[1]!.child.exit(0);
    expect(core.getTask(key).hasVisualization).toBe(true);
  });

  it('visualization.enabled: false goes straight to review', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'No frills', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    expect(calls.length).toBe(1);
    expect(calls[0]!.req.args).toContain(`/logs/${key}-review-1.out`);
  });

  it('visualization.engine overrides the review engine for the viz session only', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Mixed engines', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(
      vizConfig({ visualization: { enabled: true, engine: 'claude' } }),
      makeDeps(core, spawn, { readOutput: byPath('', aiReviewBody(0)), console: makeFakeConsole() }),
    );

    await r.tick(); // viz on claude — page arrives on stdout
    expect(calls[0]!.req.command).toBe('claude.exe');
    expect(calls[0]!.req.args).not.toContain('--output-last-message');
    calls[0]!.child.emitStdout(sampleHtml());
    await calls[0]!.child.exit(0);
    expect(core.getTask(key).hasVisualization).toBe(true);

    await r.tick(); // review stays on the top-level codex engine
    expect(calls[1]!.req.command).toBe('codex.exe');
  });

  it('pr-review tasks fetch the PR head and visualize origin/<branch>', async () => {
    const core = makeCore();
    const t = core.createTask({
      title: 'Review PR 7',
      spec: 'review it',
      acceptanceCriteria: 'review given',
      workspace: 'ws',
      kind: 'pr-review',
      links: [{ kind: 'branch', label: 'feature/teammate', url: 'https://example.test/pr/7' }],
    });
    core.updateStatus(t.key, 'in_review', 'human'); // pr-review's straight-into-review edge
    const { spawn, calls } = makeFakeSpawn();
    const fetched: Array<[string, string]> = [];
    const r = new Reviewer(
      vizConfig(),
      makeDeps(core, spawn, {
        fetchRef: async (repoPath, ref) => void fetched.push([repoPath, ref]),
        readOutput: byPath(sampleHtml()),
        console: makeFakeConsole(),
      }),
    );

    await r.tick();
    expect(calls[0]!.req.args).toContain(`/logs/${t.key}-viz-1.out`);
    expect(fetched).toEqual([['/repo/ws', 'feature/teammate']]);
    expect(calls[0]!.req.stdin).toContain('origin/feature/teammate');
  });

  it('a review-skip-listed task still gets a visualization for its next submission', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Human review needed', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    // everything fails: one viz attempt + one review attempt each burn out at maxAttempts 1
    const r = new Reviewer(vizConfig({ maxAttempts: 1 }), makeDeps(core, spawn, { readOutput: byPath('', ''), console: log }));

    await r.tick(); // viz attempt 1 — burns the viz budget for this submission
    await calls[0]!.child.exit(0);
    await r.tick(); // review attempt 1 — burns the review budget ⇒ skip-listed
    await calls[1]!.child.exit(0);
    expect(r.isSkipListed(key)).toBe(true);

    // a human bounces it and the worker resubmits — a NEW submission
    core.reviewRequestChanges(key, { feedback: 'redo' });
    core.claimNextTask({ workspace: 'ws', claimedBy: 'worker' });
    await new Promise((res) => setTimeout(res, 5));
    core.submitResult(key, { summary: 'done again', links: [{ kind: 'branch', label: 'feature/af-x', url: 'https://example.test/b' }] });

    await r.tick(); // review is still skip-listed, but the viz pass ignores that
    expect(calls.length).toBe(3);
    expect(calls[2]!.req.args).toContain(`/logs/${key}-viz-1.out`);
  });
});
