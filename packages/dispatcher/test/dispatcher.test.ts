import { describe, it, expect } from 'vitest';
import { InvalidTransitionError, type Core } from '@agentfactory/core';
import { Dispatcher } from '../src/dispatcher.js';
import {
  makeCore,
  seedQueued,
  seedQueuedStage,
  makeConfig,
  makeDeps,
  makeFakeSpawn,
  makeFakeConsole,
} from './helpers.js';

/** The merged claudeArgs tail of a spawn argv — everything after the --allowedTools value. */
const argsTail = (args: string[]): string[] => args.slice(args.indexOf('mcp__agentfactory') + 1);

const workerLabel = (env: NodeJS.ProcessEnv): string => {
  const l = env['AGENTFACTORY_WORKER'];
  if (!l) throw new Error('spawn was missing AGENTFACTORY_WORKER');
  return l;
};

// ---------------------------------------------------------------------------
// spawn gating
// ---------------------------------------------------------------------------
describe('spawn gating', () => {
  it('spawns nothing when the queue is empty', async () => {
    const core = makeCore();
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));
    await d.tick();
    expect(calls.length).toBe(0);
  });

  it('spawns at most maxConcurrent, one per queued task, with distinct labels and the repo cwd', async () => {
    const core = makeCore('ws', '/repo/ws');
    const k1 = seedQueued(core, 'ws', 'One');
    const k2 = seedQueued(core, 'ws', 'Two');
    seedQueued(core, 'ws', 'Three');
    const { spawn, calls } = makeFakeSpawn();
    const mcpFiles = new Map<string, string>();
    const d = new Dispatcher(
      makeConfig({ maxConcurrent: 2 }),
      makeDeps(core, spawn, { console: makeFakeConsole(), writeMcp: (p, c) => void mcpFiles.set(p, c) }),
    );

    await d.tick();
    expect(calls.length).toBe(2); // capped at maxConcurrent, not the 3 queued

    const labels = calls.map((c) => workerLabel(c.req.env));
    expect(new Set(labels).size).toBe(2); // distinct sessions
    expect(labels[0]).toContain(k1); // oldest-first
    expect(labels[1]).toContain(k2);
    expect(calls[0]!.req.cwd).toBe('/repo/ws'); // cwd = workspace repoPath
    expect(calls[0]!.req.env['AGENTFACTORY_WORKSPACE']).toBe('ws');
    expect(calls[0]!.req.command).toBe('claude.exe');

    // --mcp-config points at a written file under logDir, carrying the worker label + db
    const args = calls[0]!.req.args;
    const mcpPath = args[args.indexOf('--mcp-config') + 1]!;
    expect(mcpPath).toContain('/logs/');
    expect(mcpPath.endsWith('.mcp.json')).toBe(true);
    const written = JSON.parse(mcpFiles.get(mcpPath)!);
    expect(written.mcpServers.agentfactory.env.AGENTFACTORY_WORKER).toBe(labels[0]);
    expect(written.mcpServers.agentfactory.env.AGENTFACTORY_DB).toBe(':memory:');

    // a second tick while both are still running adds nothing — slots are full
    await d.tick();
    expect(calls.length).toBe(2);
  });

  it('does not re-spawn a task whose session is still running (no double claim)', async () => {
    const core = makeCore();
    seedQueued(core, 'ws', 'One');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ maxConcurrent: 1 }), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await d.tick();
    await d.tick(); // task still queued (session hasn't claimed yet), but already being served
    expect(calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// workspace selection (opt-out model)
// ---------------------------------------------------------------------------
describe('workspace selection', () => {
  const spawnedWorkspaces = (calls: { req: { env: NodeJS.ProcessEnv } }[]): Set<string> =>
    new Set(calls.map((c) => c.req.env['AGENTFACTORY_WORKSPACE']!));

  it('serves every DB workspace when config.workspaces is omitted', async () => {
    const core = makeCore('ws', '/repo/ws');
    core.createWorkspace({ name: 'other', repoPath: '/repo/other' });
    seedQueued(core, 'ws', 'A');
    seedQueued(core, 'other', 'B');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(
      makeConfig({ workspaces: undefined, maxConcurrent: 5 }),
      makeDeps(core, spawn, { console: makeFakeConsole() }),
    );
    await d.tick();
    expect(spawnedWorkspaces(calls)).toEqual(new Set(['ws', 'other']));
  });

  it('picks up a workspace created AFTER startup — no restart (re-read each tick)', async () => {
    const core = makeCore('ws', '/repo/ws');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(
      makeConfig({ workspaces: undefined, maxConcurrent: 5 }),
      makeDeps(core, spawn, { console: makeFakeConsole() }),
    );
    await d.tick();
    expect(calls.length).toBe(0);
    core.createWorkspace({ name: 'late', repoPath: '/repo/late' }); // added while running
    seedQueued(core, 'late', 'L');
    await d.tick();
    expect(spawnedWorkspaces(calls)).toEqual(new Set(['late']));
  });

  it('excludeWorkspaces drops a workspace from the served-all set', async () => {
    const core = makeCore('ws', '/repo/ws');
    core.createWorkspace({ name: 'demo', repoPath: '/repo/demo' });
    seedQueued(core, 'ws', 'A');
    seedQueued(core, 'demo', 'B');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(
      makeConfig({ workspaces: undefined, excludeWorkspaces: ['demo'], maxConcurrent: 5 }),
      makeDeps(core, spawn, { console: makeFakeConsole() }),
    );
    await d.tick();
    expect(spawnedWorkspaces(calls)).toEqual(new Set(['ws']));
  });

  it('still honours an explicit workspaces allowlist (opt-in back-compat)', async () => {
    const core = makeCore('ws', '/repo/ws');
    core.createWorkspace({ name: 'other', repoPath: '/repo/other' });
    seedQueued(core, 'ws', 'A');
    seedQueued(core, 'other', 'B');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(
      makeConfig({ workspaces: ['ws'], maxConcurrent: 5 }),
      makeDeps(core, spawn, { console: makeFakeConsole() }),
    );
    await d.tick();
    expect(spawnedWorkspaces(calls)).toEqual(new Set(['ws']));
  });
});

// ---------------------------------------------------------------------------
// per-stage model / args selection
// ---------------------------------------------------------------------------
describe('per-stage claude args', () => {
  const stageArgs = {
    description: ['--model', 'haiku'],
    plan: ['--model', 'sonnet'],
    implementation: ['--model', 'opus'],
  };

  it('appends the matching stage args after the global claudeArgs', async () => {
    const core = makeCore();
    seedQueuedStage(core, 'ws', 'Build it', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(
      makeConfig({ claudeArgs: ['--global'], stageArgs }),
      makeDeps(core, spawn, { console: makeFakeConsole() }),
    );

    await d.tick();
    // global first, then the implementation-stage override (so --model opus wins)
    expect(argsTail(calls[0]!.req.args)).toEqual(['--global', '--model', 'opus']);
  });

  it('picks the doc-stage args for a description-stage task', async () => {
    const core = makeCore();
    seedQueuedStage(core, 'ws', 'Describe it', 'description');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(
      makeConfig({ claudeArgs: ['--global'], stageArgs }),
      makeDeps(core, spawn, { console: makeFakeConsole() }),
    );

    await d.tick();
    expect(argsTail(calls[0]!.req.args)).toEqual(['--global', '--model', 'haiku']);
  });

  it('falls back to just the global args for a stage with no override', async () => {
    const core = makeCore();
    seedQueuedStage(core, 'ws', 'Plan it', 'plan');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(
      makeConfig({ claudeArgs: ['--global'], stageArgs: { implementation: ['--model', 'opus'] } }),
      makeDeps(core, spawn, { console: makeFakeConsole() }),
    );

    await d.tick();
    expect(argsTail(calls[0]!.req.args)).toEqual(['--global']);
  });
});

// ---------------------------------------------------------------------------
// success path → measured metrics
// ---------------------------------------------------------------------------
describe('success path', () => {
  it('records measured metrics from the CLI result once the session submits', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Ship it');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: log }));

    await d.tick();
    const label = workerLabel(calls[0]!.req.env);

    // simulate the spawned session: it claims via get_next_task (claimedBy = its label)…
    core.claimNextTask({ workspace: 'ws', claimedBy: label });
    // …works and submits…
    core.submitResult(key, { summary: 'done' });
    // …prints the JSON result envelope to stdout, then exits 0.
    calls[0]!.child.emitStdout(
      JSON.stringify({
        type: 'result',
        total_cost_usd: 0.5,
        usage: { input_tokens: 1200, output_tokens: 300 },
        modelUsage: { 'claude-opus-4-8': {} },
      }),
    );
    calls[0]!.child.exit(0);

    const t = core.getTask(key);
    expect(t.status).toBe('in_review');
    expect(t.metrics.costUsd).toBe(0.5);
    expect(t.metrics.tokensIn).toBe(1200);
    expect(t.metrics.tokensOut).toBe(300);
    expect(t.metrics.model).toBe('claude-opus-4-8');
    expect(d.runningCount('ws')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// live agent session (the Live view's data)
// ---------------------------------------------------------------------------
describe('live agent session', () => {
  it('a claim starts a live session and a crash ends it (no lingering "running")', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Live then crash');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await d.tick();
    const label = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label });
    expect(core.listLiveAgents().map((a) => a.key)).toContain(key); // live while working

    calls[0]!.child.exit(1); // crash without submitting → release + retry
    expect(core.getTask(key).status).toBe('queued');
    expect(core.listLiveAgents()).toHaveLength(0); // ended by the reap safety-net
  });

  it('a clean submit + exit leaves no live session', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Live then submit');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await d.tick();
    const label = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label });
    core.submitResult(key, { summary: 'done' }); // submit ends it
    expect(core.listLiveAgents()).toHaveLength(0);
    calls[0]!.child.exit(0);
    expect(core.listLiveAgents()).toHaveLength(0); // reap end is idempotent
  });
});

// ---------------------------------------------------------------------------
// OTel token capture (when configured, OTel owns metrics)
// ---------------------------------------------------------------------------
describe('otel token capture', () => {
  it('sets OTEL_* env (incl task.key + bearer) on the spawned session', async () => {
    const core = makeCore();
    seedQueued(core, 'ws', 'Otel');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ otel: { endpoint: 'http://localhost:8787', token: 'svc' } }), makeDeps(core, spawn));

    await d.tick();
    const env = calls[0]!.req.env;
    expect(env['CLAUDE_CODE_ENABLE_TELEMETRY']).toBe('1');
    expect(env['OTEL_EXPORTER_OTLP_ENDPOINT']).toBe('http://localhost:8787');
    expect(env['OTEL_EXPORTER_OTLP_HEADERS']).toContain('Bearer svc');
    expect(env['OTEL_RESOURCE_ATTRIBUTES']).toContain('task.key=');
  });

  it('with otel configured, a session exit does NOT write task_metric (OTel owns it)', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Otel');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ otel: { endpoint: 'http://localhost:8787' } }), makeDeps(core, spawn, { console: makeFakeConsole() }));

    await d.tick();
    const label = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label });
    core.submitResult(key, { summary: 'done' });
    calls[0]!.child.emitStdout(JSON.stringify({ type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 1200, output_tokens: 300 } }));
    calls[0]!.child.exit(0);

    expect(core.getTask(key).metrics.tokensIn).toBeNull(); // dispatcher skipped the stdout parse
  });
});

// ---------------------------------------------------------------------------
// crash path → release, retry, skip-list
// ---------------------------------------------------------------------------
describe('crash path', () => {
  it('releases a stranded claim with a log-tail comment, retries, then skip-lists at maxAttempts', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Crashy');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig({ maxAttempts: 2 }), makeDeps(core, spawn, { console: log }));

    // attempt 1 — claim then die without submitting
    await d.tick();
    const label1 = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label1 });
    calls[0]!.child.emitStdout('TypeError: boom\n  at worker.ts:42\n');
    calls[0]!.child.exit(1);

    let t = core.getTask(key);
    expect(t.status).toBe('queued'); // released within the reap
    const comment = t.activity.find((a) => a.type === 'comment' && a.body.includes('Log tail'));
    expect(comment).toBeTruthy();
    expect(comment!.body).toContain('boom'); // the tail is quoted
    expect(comment!.body).toContain('attempt 1/2');
    expect(d.isSkipListed(key)).toBe(false);

    // attempt 2 — a fresh session, labelled a2
    await d.tick();
    expect(calls.length).toBe(2);
    const label2 = workerLabel(calls[1]!.req.env);
    expect(label2).toContain('-a2');
    core.claimNextTask({ workspace: 'ws', claimedBy: label2 });
    calls[1]!.child.exit(1);

    t = core.getTask(key);
    expect(t.status).toBe('queued');
    expect(d.isSkipListed(key)).toBe(true); // burned both attempts
    expect(log.warnings.some((w) => w.includes('maxAttempts'))).toBe(true);

    // attempt 3 must NOT spawn — the task is skip-listed
    await d.tick();
    expect(calls.length).toBe(2);
  });

  it('retries a skip-listed task after an operator restart clears its failure', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Stuck');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig({ maxAttempts: 2 }), makeDeps(core, spawn, { console: log }));

    // burn both attempts → skip-listed
    await d.tick();
    core.claimNextTask({ workspace: 'ws', claimedBy: workerLabel(calls[0]!.req.env) });
    calls[0]!.child.exit(1);
    await d.tick();
    core.claimNextTask({ workspace: 'ws', claimedBy: workerLabel(calls[1]!.req.env) });
    calls[1]!.child.exit(1);
    expect(d.isSkipListed(key)).toBe(true);
    expect(core.getTask(key).failure).toMatchObject({ skipListed: true });

    // no respawn while skip-listed
    await d.tick();
    expect(calls.length).toBe(2);

    // operator restarts from the board → failure cleared → dispatcher forgets the burned budget
    core.restartTask(key);
    await d.tick();
    expect(core.getTask(key).failure).toBeNull();
    expect(d.isSkipListed(key)).toBe(false);
    expect(calls.length).toBe(3);
    expect(workerLabel(calls[2]!.req.env)).toContain('-a1'); // a FRESH attempt budget, not -a3
    expect(log.logs.some((l) => l.includes('was restarted from the board'))).toBe(true);
  });

  it('only releases the task carrying its OWN worker label (lost race exits clean)', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Contested');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: log }));

    await d.tick();
    // the session lost the race — a different worker holds the task.
    core.claimNextTask({ workspace: 'ws', claimedBy: 'someone-else' });
    calls[0]!.child.exit(0);

    const t = core.getTask(key);
    expect(t.status).toBe('in_progress'); // untouched
    expect(t.claimedBy).toBe('someone-else'); // the dispatcher did NOT release another claim
    expect(d.runningCount('ws')).toBe(0);
    expect(log.errors).toEqual([]); // clean exit, no error
  });
});

// ---------------------------------------------------------------------------
// permission-denied path → warn, count the attempt, skip-list
// ---------------------------------------------------------------------------
describe('permission-denied path', () => {
  const denialEnvelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    permission_denials: [{ tool_name: 'mcp__agentfactory__get_next_task', tool_use_id: 'toolu_01x', tool_input: {} }],
  });

  it('treats a clean unclaimed exit with denials as a failed attempt and skip-lists at maxAttempts', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Denied');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig({ maxAttempts: 2 }), makeDeps(core, spawn, { console: log }));

    // attempt 1 — the session never claims: its MCP tool call is permission-denied
    await d.tick();
    calls[0]!.child.emitStdout(denialEnvelope);
    calls[0]!.child.exit(0);

    expect(log.warnings.some((w) => w.includes('permission denied') && w.includes('mcp__agentfactory__get_next_task'))).toBe(true);
    expect(d.isSkipListed(key)).toBe(false);
    let t = core.getTask(key);
    expect(t.status).toBe('queued'); // never claimed, nothing to release
    expect(t.activity.some((a) => a.type === 'comment' && a.body.includes('permission denied'))).toBe(true);

    // attempt 2 — same denial burns the last attempt
    await d.tick();
    expect(calls.length).toBe(2);
    calls[1]!.child.emitStdout(denialEnvelope);
    calls[1]!.child.exit(0);

    expect(d.isSkipListed(key)).toBe(true);
    expect(log.warnings.some((w) => w.includes('maxAttempts'))).toBe(true);

    // no further spawns — the misconfiguration no longer burns sessions forever
    await d.tick();
    expect(calls.length).toBe(2);
  });

  it('keeps the plain clean-exit message when an unclaimed session reports no denials', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Raced');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: log }));

    await d.tick();
    core.claimNextTask({ workspace: 'ws', claimedBy: 'someone-else' }); // lost race
    calls[0]!.child.emitStdout(JSON.stringify({ type: 'result', subtype: 'success', permission_denials: [] }));
    calls[0]!.child.exit(0);

    expect(log.logs.some((l) => l.includes('claimed nothing'))).toBe(true);
    expect(log.warnings).toEqual([]);
    expect(d.isSkipListed(key)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// session timeout
// ---------------------------------------------------------------------------
describe('session timeout', () => {
  it('kills a session past maxSessionMinutes, releases its claim, and retries', async () => {
    let nowMs = 0;
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Slow');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig({ maxSessionMinutes: 10 }), makeDeps(core, spawn, { now: () => nowMs, console: log }));

    await d.tick(); // spawn at t=0
    const label = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label });

    nowMs = 11 * 60_000; // past the 10-minute cap
    await d.tick(); // enforceTimeouts → kill → reap → release → retry

    expect(calls[0]!.child.killed).toBe(true);
    const t = core.getTask(key);
    expect(t.status).toBe('queued');
    const comment = t.activity.find((a) => a.type === 'comment' && a.body.includes('timed out'));
    expect(comment).toBeTruthy();
    // released, then re-served in the same cycle as attempt 2
    expect(calls.length).toBe(2);
    expect(workerLabel(calls[1]!.req.env)).toContain('-a2');
  });
});

// ---------------------------------------------------------------------------
// stale-claim reaper (DB-scan recovery of orphaned in_progress claims)
// ---------------------------------------------------------------------------
describe('stale-claim reaper', () => {
  const HOUR = 3_600_000;
  // The core stamps DB rows with real system time (nowIso), while deps.now() is injected.
  // Offsetting deps.now() into the future makes a just-made claim look that many ms stale,
  // and — because a spawned session's startedAtMs uses the same offset clock — keeps
  // enforceTimeouts inert (its elapsed measurement nets the offset out to ~0).
  const staleNow = (ms: number) => () => Date.now() + ms;

  it('reaps a stale interactive claim, posts a stale failure note, and respawns it', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Abandoned');
    // an interactive /work-task style claim: plain workspace label, no live dispatcher child
    core.claimNextTask({ workspace: 'ws', claimedBy: 'ws' });
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120 }), makeDeps(core, spawn, { now: staleNow(3 * HOUR), console: log }));

    await d.tick();

    const t = core.getTask(key);
    // released and re-served in the same tick as a fresh dispatcher attempt
    expect(calls.length).toBe(1);
    expect(workerLabel(calls[0]!.req.env)).toBe(`ws#${key}-a1`);
    const comment = t.activity.find((a) => a.type === 'comment' && a.body.includes('failure/v1'));
    expect(comment).toBeTruthy();
    expect(comment!.body).toContain('"reason":"stale"');
    expect(comment!.body).toContain('"source":"dispatcher"');
    // a foreign claim carries no attempt budget, so no attempt bookkeeping in the note
    expect(comment!.body).not.toContain('"attempt"');
    expect(d.isSkipListed(key)).toBe(false);
    // the orphaned live session row was ended by the release
    expect(core.listLiveAgents().some((a) => a.key === key)).toBe(false);
    expect(log.logs.some((l) => l.includes('reaping stale claim'))).toBe(true);
  });

  it('never reaps its own live child', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Working');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120 }), makeDeps(core, spawn, { now: staleNow(3 * HOUR), console: makeFakeConsole() }));

    await d.tick(); // spawn
    const label = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label });

    await d.tick(); // the reaper must skip the live child despite the stale-looking offset clock

    const t = core.getTask(key);
    expect(t.status).toBe('in_progress');
    expect(t.claimedBy).toBe(label);
    expect(calls[0]!.child.killed).toBe(false);
    expect(t.activity.some((a) => a.body.includes('failure/v1'))).toBe(false);
    expect(calls.length).toBe(1); // not respawned
  });

  it('leaves a claim whose heartbeat is within the threshold', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Recent');
    core.claimNextTask({ workspace: 'ws', claimedBy: 'ws' });
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120 }), makeDeps(core, spawn, { now: staleNow(30 * 60_000), console: makeFakeConsole() }));

    await d.tick(); // 30m < 120m ⇒ not stale

    const t = core.getTask(key);
    expect(t.status).toBe('in_progress');
    expect(t.activity.some((a) => a.body.includes('failure/v1'))).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('falls back to claimed_at when the live session row is gone', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'NoSession');
    core.claimNextTask({ workspace: 'ws', claimedBy: 'ws' });
    core.endAgentSession(key); // drop the live heartbeat row; only task.claimed_at remains
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120 }), makeDeps(core, spawn, { now: staleNow(3 * HOUR), console: makeFakeConsole() }));

    await d.tick();

    const t = core.getTask(key);
    expect(t.activity.some((a) => a.type === 'comment' && a.body.includes('"reason":"stale"'))).toBe(true);
    expect(calls.length).toBe(1); // respawned from the claimed_at fallback
  });

  it('tolerates a race where the release transition is no longer valid', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Racy');
    core.claimNextTask({ workspace: 'ws', claimedBy: 'ws' });
    const { spawn } = makeFakeSpawn();
    const log = makeFakeConsole();
    // updateStatus throws as if a human settled the task in the gap before release
    const racy = new Proxy(core, {
      get(target, prop, receiver) {
        if (prop === 'updateStatus') return () => { throw new InvalidTransitionError('in_progress -> queued raced'); };
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as unknown as Core;
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120 }), makeDeps(racy, spawn, { now: staleNow(3 * HOUR), console: log }));

    await expect(d.tick()).resolves.toBeUndefined(); // never throws out of the tick

    // release-first ordering ⇒ no spurious failure note when the release lost the race
    expect(core.getTask(key).activity.some((a) => a.body.includes('failure/v1'))).toBe(false);
    expect(d.isSkipListed(key)).toBe(false);
    expect(log.logs.some((l) => l.toLowerCase().includes('race'))).toBe(true);
  });

  it('aborts silently when the task advanced out of in_progress before release', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Advanced');
    core.claimNextTask({ workspace: 'ws', claimedBy: 'ws' });
    const { spawn, calls } = makeFakeSpawn();
    // the freshness re-check sees the task already moved to in_review (a concurrent submit)
    const proxy = new Proxy(core, {
      get(target, prop, receiver) {
        if (prop === 'getTask') return (k: string) => ({ ...target.getTask(k), status: 'in_review' });
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as unknown as Core;
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120 }), makeDeps(proxy, spawn, { now: staleNow(3 * HOUR), console: makeFakeConsole() }));

    await d.tick();

    const t = core.getTask(key); // the real task was never released or commented on
    expect(t.status).toBe('in_progress');
    expect(t.activity.some((a) => a.body.includes('failure/v1'))).toBe(false);
    expect(calls.length).toBe(0);
  });

  it('skip-lists a dispatcher-orphaned claim at the attempt cap and does not respawn it', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Orphan');
    core.claimNextTask({ workspace: 'ws', claimedBy: `ws#${key}-a2` }); // orphaned at attempt 2
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120, maxAttempts: 2 }), makeDeps(core, spawn, { now: staleNow(3 * HOUR), console: log }));

    await d.tick();

    const t = core.getTask(key);
    expect(t.status).toBe('queued');
    const comment = t.activity.find((a) => a.body.includes('"reason":"stale"'));
    expect(comment!.body).toContain('attempt 2/2');
    expect(d.isSkipListed(key)).toBe(true);
    expect(t.activity.some((a) => a.body.includes('"reason":"max_attempts"'))).toBe(true);
    expect(calls.length).toBe(0); // skip-listed ⇒ not respawned
  });

  it('re-serves a stale dispatcher-orphan below the cap as the next attempt', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'OrphanRetry');
    core.claimNextTask({ workspace: 'ws', claimedBy: `ws#${key}-a1` });
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 120, maxAttempts: 2 }), makeDeps(core, spawn, { now: staleNow(3 * HOUR), console: makeFakeConsole() }));

    await d.tick();

    expect(core.getTask(key).status).toBe('queued');
    expect(d.isSkipListed(key)).toBe(false);
    expect(calls.length).toBe(1);
    // the parsed attempt carried across the reap ⇒ the respawn is attempt 2
    expect(workerLabel(calls[0]!.req.env)).toBe(`ws#${key}-a2`);
  });

  it('does nothing when staleClaimMinutes is 0', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Disabled');
    core.claimNextTask({ workspace: 'ws', claimedBy: 'ws' });
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ staleClaimMinutes: 0 }), makeDeps(core, spawn, { now: staleNow(3 * HOUR), console: makeFakeConsole() }));

    await d.tick();

    const t = core.getTask(key);
    expect(t.status).toBe('in_progress');
    expect(t.activity.some((a) => a.body.includes('failure/v1'))).toBe(false);
    expect(calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// transcript capture (live tail + persisted artifact)
// ---------------------------------------------------------------------------
describe('transcript capture', () => {
  const userLine = (uuid: string, text: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp: '2026-06-27T00:00:00.000Z' });

  /** A fake transcript file the test grows; tailFile hands back whole lines from `offset`. */
  function fakeTranscriptFs() {
    const PATH = '/proj/sess-1.jsonl';
    const state = { content: '' };
    return {
      state,
      deps: {
        uuid: () => 'sess-1',
        findTranscript: () => (state.content ? PATH : null),
        tailFile: (p: string, offset: number) => {
          if (p !== PATH) return null;
          const lastNl = state.content.lastIndexOf('\n');
          if (lastNl < offset) return { chunk: '', offset };
          return { chunk: state.content.slice(offset, lastNl + 1), offset: lastNl + 1 };
        },
        readFile: (p: string) => (p === PATH ? state.content : null),
      },
    };
  }

  it('forces the session id, tails live, then persists the full transcript on a clean exit', async () => {
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Talk');
    const { spawn, calls } = makeFakeSpawn();
    const { state, deps } = fakeTranscriptFs();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole(), ...deps }));

    await d.tick(); // spawn
    const args = calls[0]!.req.args;
    expect(args[args.indexOf('--session-id') + 1]).toBe('sess-1');
    const label = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label });

    state.content = userLine('u1', 'hello') + '\n';
    await d.tick(); // tailTranscripts → appendTranscript on the claimed key
    let tr = core.getTranscript(key);
    expect(tr.state).toBe('live');
    expect(tr.blocks[0]).toMatchObject({ kind: 'text', text: 'hello' });

    state.content += userLine('u2', 'world') + '\n';
    core.submitResult(key, { summary: 'done' });
    calls[0]!.child.exit(0); // reap → persistTranscript

    tr = core.getTranscript(key);
    expect(tr.state).toBe('final');
    expect(tr.blocks.map((b) => (b.kind === 'text' ? b.text : ''))).toEqual(['hello', 'world']);
  });

  it('persists the transcript even for a timed-out, stranded session (post-mortem)', async () => {
    let nowMs = 0;
    const core = makeCore();
    const key = seedQueued(core, 'ws', 'Slow talker');
    const { spawn, calls } = makeFakeSpawn();
    const { state, deps } = fakeTranscriptFs();
    const d = new Dispatcher(
      makeConfig({ maxSessionMinutes: 10 }),
      makeDeps(core, spawn, { now: () => nowMs, console: makeFakeConsole(), ...deps }),
    );

    await d.tick();
    const label = workerLabel(calls[0]!.req.env);
    core.claimNextTask({ workspace: 'ws', claimedBy: label });
    state.content = userLine('u1', 'thinking hard') + '\n';

    nowMs = 11 * 60_000; // exceed the cap → kill → reap → persist
    await d.tick();

    expect(core.getTask(key).status).toBe('queued'); // released for retry
    const tr = core.getTranscript(key);
    expect(tr.state).toBe('final'); // yet the transcript survived the strand
    expect(tr.blocks[0]).toMatchObject({ kind: 'text', text: 'thinking hard' });
  });
});
