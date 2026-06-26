import { describe, it, expect } from 'vitest';
import { Reviewer } from '../src/reviewer.js';
import { makeCore, seedInReview, aiReviewBody, makeConfig, makeDeps, makeFakeSpawn, makeFakeConsole } from './helpers.js';

// ---------------------------------------------------------------------------
// poll + spawn + dedup
// ---------------------------------------------------------------------------
describe('poll + spawn', () => {
  it('spawns nothing when no task is in_review', async () => {
    const core = makeCore();
    seedInReview(core, 'ws', 'Done already'); // in_review, but we will skip after reviewing
    const { spawn, calls } = makeFakeSpawn();
    // pre-mark it reviewed so the queue is effectively empty
    const key = core.listTasks({ status: 'in_review' })[0]!.key;
    core.addComment(key, { actor: 'agent', body: aiReviewBody(1) });
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));
    await r.tick();
    expect(calls.length).toBe(0);
  });

  it('spawns a codex review with the prompt on stdin and the diff in the prompt', async () => {
    const core = makeCore();
    seedInReview(core, 'ws', 'Build it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    expect(calls.length).toBe(1);
    const req = calls[0]!.req;
    expect(req.command).toBe('codex.exe');
    expect(req.args[0]).toBe('exec');
    expect(req.args).toContain('--output-last-message');
    expect(req.args.at(-1)).toBe('-'); // prompt rides stdin, not argv
    expect(req.cwd).toBe('/logs'); // neutral dir — not the repo
    expect(req.stdin).toContain('=== DIFF ==='); // implementation prompt carries the diff
    expect(req.stdin).toContain('diff --git'); // the computed diff body
    expect(req.stdin).toContain('ai-review/v1 - <N> findings (codex)'); // the output contract
  });

  it('resolves a decorated branch-link label to a clean git ref before diffing', async () => {
    const core = makeCore();
    // The agent decorated the branch link's label with a trailing annotation — the whole
    // string must NOT reach git as a ref (it would fail SAFE_REF and skip-list the review).
    seedInReview(core, 'ws', 'Conflict fix', 'implementation', 'feature/af-x (PR 4703 source — conflict fix pushed here)');
    let seen: string | undefined;
    const computeDiff = async (_repo: string, branch: string) => {
      seen = branch;
      return { baseRef: 'main', diff: 'diff --git a/a.ts b/a.ts\n+code', commits: 1 };
    };
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { computeDiff, console: makeFakeConsole() }));

    await r.tick();
    expect(seen).toBe('feature/af-x'); // bare ref, annotation stripped
    expect(calls.length).toBe(1); // review prepared, not burned/skip-listed
  });

  it('does not re-review a task that already has a current verdict (dedup)', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Reviewed', 'implementation');
    core.addComment(key, { actor: 'agent', body: aiReviewBody(1) }); // findings, current
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    expect(calls.length).toBe(0);
  });

  it('does not double-spawn a task whose review is still in flight', async () => {
    const core = makeCore();
    seedInReview(core, 'ws', 'Slow review', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    await r.tick(); // still running (no exit) → no second spawn
    expect(calls.length).toBe(1);
  });

  it('re-reviews a task whose verdict is pending (a newer result superseded the review)', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Reopened', 'implementation');
    core.addComment(core.getTask(key).key, { actor: 'agent', body: aiReviewBody(1) }); // review R
    core.reviewRequestChanges(key, { feedback: 'please redo' }); // in_review → queued
    core.claimNextTask({ workspace: 'ws', claimedBy: 'worker-2' }); // → in_progress
    core.submitResult(key, {
      summary: 'redone',
      links: [{ kind: 'branch', label: 'feature/af-x', url: 'https://example.test/b' }],
    }); // result B (newest) → in_review, superseding R

    expect(core.getTask(key).aiReview?.verdict).toBe('pending'); // precondition
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    expect(calls.length).toBe(1); // pending ⇒ re-reviewed
  });
});

// ---------------------------------------------------------------------------
// otel token capture (bind the review's usage to the task)
// ---------------------------------------------------------------------------
describe('otel token capture', () => {
  it('codex review: sets AF_TASK_KEY (+ AF_OTEL_TOKEN) so config.toml binds the run', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Build it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const cfg = makeConfig({ engine: 'codex', otel: { endpoint: 'http://localhost:8787', token: 'svc' } });
    const r = new Reviewer(cfg, makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    const env = calls[0]!.req.env;
    expect(env['AF_TASK_KEY']).toBe(key);
    expect(env['AF_OTEL_TOKEN']).toBe('svc');
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBeUndefined(); // codex reads config.toml, not env
  });

  it('claude review: sets the OTLP env + a task.key resource attribute', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Build it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const cfg = makeConfig({ engine: 'claude', otel: { endpoint: 'http://localhost:8787', token: 'svc' } });
    const r = new Reviewer(cfg, makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    const env = calls[0]!.req.env;
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://localhost:8787');
    expect(env['OTEL_EXPORTER_OTLP_HEADERS']).toContain('Bearer svc');
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toContain(`task.key=${key}`);
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toContain('af.worker=');
    expect(env['AF_TASK_KEY']).toBeUndefined(); // claude reads the env, not config.toml
  });

  it('no otel block: spawns without any OTel env (unattributed, as before)', async () => {
    const core = makeCore();
    seedInReview(core, 'ws', 'Build it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    const env = calls[0]!.req.env;
    expect(env['AF_TASK_KEY']).toBeUndefined();
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// posting verdicts (codex: verdict from the output file)
// ---------------------------------------------------------------------------
describe('posting verdicts', () => {
  it('a clean DOC-stage verdict auto-advances the task off in_review', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Describe it', 'description');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { readOutput: () => aiReviewBody(0), console: makeFakeConsole() }));

    await r.tick();
    expect(calls[0]!.req.stdin).toContain('=== SPEC (the deliverable under review) ===');
    calls[0]!.child.exit(0); // codex finished; its output file holds a clean verdict

    const t = core.getTask(key);
    expect(t.status).toBe('queued'); // advanced off in_review by the add_comment hook
    expect(t.stage).toBe('plan'); // description → plan
  });

  it('an IMPLEMENTATION verdict posts but stays in_review (human-gated)', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Build it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { readOutput: () => aiReviewBody(0), console: makeFakeConsole() }));

    await r.tick();
    calls[0]!.child.exit(0);

    const t = core.getTask(key);
    expect(t.status).toBe('in_review'); // implementation never auto-advances
    expect(t.aiReview?.verdict).toBe('clean');
  });

  it('findings on a DOC stage post and keep the task in_review', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Plan it', 'plan');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { readOutput: () => aiReviewBody(2), console: makeFakeConsole() }));

    await r.tick();
    calls[0]!.child.exit(0);

    const t = core.getTask(key);
    expect(t.status).toBe('in_review'); // findings escalate to a human
    expect(t.aiReview?.verdict).toBe('findings');
    expect(t.aiReview?.findings).toBe(2);
  });

  it('prepends the ai-review/v1 marker when the engine output lacks it', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'No marker', 'implementation');
    const raw = 'I reviewed the diff.\n```json\n{"reviewer":"codex","verdict":"clean","findings":[]}\n```';
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { readOutput: () => raw, console: makeFakeConsole() }));

    await r.tick();
    calls[0]!.child.exit(0);

    const t = core.getTask(key);
    const comment = t.activity.find((a) => a.type === 'comment');
    expect(comment!.body.startsWith('ai-review/v1')).toBe(true);
    expect(t.aiReview?.verdict).toBe('clean'); // still parses into a clean verdict
  });

  it('claude engine: the verdict comes from stdout, args are the headless text form', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Build it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const r = new Reviewer(makeConfig({ engine: 'claude' }), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await r.tick();
    const req = calls[0]!.req;
    expect(req.command).toBe('claude.exe');
    expect(req.args).toEqual(['-p', '--output-format', 'text', '--max-turns', '1']);
    expect(req.stdin).toContain('ai-review/v1');

    calls[0]!.child.emitStdout(aiReviewBody(0, 'claude')); // claude streams the verdict on stdout
    calls[0]!.child.exit(0);
    expect(core.getTask(key).aiReview?.verdict).toBe('clean');
  });
});

// ---------------------------------------------------------------------------
// failure paths — advisory (no verdict, no status change) but posts a failure/v1
// note so the operator sees the auto-review didn't run; burn an attempt, skip-list
// ---------------------------------------------------------------------------
describe('failure paths', () => {
  const failureNote = (t: { activity: { type: string; body: string }[] }) =>
    t.activity.some((a) => a.type === 'comment' && a.body.startsWith('failure/v1'));

  it('an empty verdict posts a failure note, burns an attempt, and skip-lists at maxAttempts', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Empties', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const r = new Reviewer(makeConfig({ maxAttempts: 2 }), makeDeps(core, spawn, { readOutput: () => '', console: log }));

    await r.tick(); // attempt 1 — engine exits 0 but wrote nothing
    calls[0]!.child.exit(0);
    let t = core.getTask(key);
    expect(failureNote(t)).toBe(true); // failure/v1 note posted
    expect(t.failure?.reason).toBe('review_failed'); // surfaces as the task's current failure
    expect(t.failure?.source).toBe('reviewer');
    expect(t.failure?.skipListed).toBe(false);
    expect(t.status).toBe('in_review'); // advisory — no status change
    expect(t.aiReview).toBeNull(); // no verdict
    expect(r.isSkipListed(key)).toBe(false);

    await r.tick(); // attempt 2 — same, burns the last attempt
    expect(calls.length).toBe(2);
    expect(calls[1]!.req.args).toContain('exec'); // a fresh codex review
    calls[1]!.child.exit(0);
    t = core.getTask(key);
    expect(t.failure?.skipListed).toBe(true); // out of attempts ⇒ needs a human
    expect(r.isSkipListed(key)).toBe(true);
    expect(log.warnings.some((w) => w.includes('maxAttempts'))).toBe(true);

    await r.tick(); // skip-listed — no further spawns
    expect(calls.length).toBe(2);
  });

  it('a review past reviewMinutes is killed, posts a failure note, and burns an attempt', async () => {
    let nowMs = 0;
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Hangs', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const r = new Reviewer(
      makeConfig({ reviewMinutes: 10 }),
      makeDeps(core, spawn, { now: () => nowMs, readOutput: () => aiReviewBody(0), console: log }),
    );

    await r.tick(); // spawn at t=0
    expect(calls.length).toBe(1);

    nowMs = 11 * 60_000; // past the 10-minute cap
    await r.tick(); // enforceTimeouts → kill → reap (timed out)

    expect(calls[0]!.child.killed).toBe(true);
    const t = core.getTask(key);
    expect(failureNote(t)).toBe(true); // timeout posts a failure/v1 note
    expect(t.failure?.reason).toBe('review_failed');
    expect(t.status).toBe('in_review');
    expect(r.isSkipListed(key)).toBe(false); // only one attempt burned (maxAttempts 2)
    expect(log.warnings.some((w) => w.includes('timed out'))).toBe(true);
  });

  it('a later successful review supersedes the failure note (failure cleared)', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Recovers', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    let reviewN = 0; // codex reads its verdict from readOutput: empty first (fail), clean second
    const r = new Reviewer(makeConfig({ maxAttempts: 3 }), makeDeps(core, spawn, { readOutput: () => (reviewN++ === 0 ? '' : aiReviewBody(0)) }));

    await r.tick(); // attempt 1 — empty verdict → failure note
    calls[0]!.child.exit(0);
    expect(core.getTask(key).failure?.reason).toBe('review_failed');

    await r.tick(); // attempt 2 — a clean verdict this time
    calls[1]!.child.exit(0);
    const t = core.getTask(key);
    expect(t.aiReview?.verdict).toBe('clean');
    expect(t.failure).toBeNull(); // the successful review cleared the prior failure note
  });
});
