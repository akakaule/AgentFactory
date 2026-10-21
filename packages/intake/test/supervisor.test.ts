import { describe, expect, it, vi } from 'vitest';
import { createCore, openDb, runMigrations } from '@agentfactory/core';
import { parseConfig } from '../src/config.js';
import { FixtureTaskIntakeDecisionProvider, IntakeProviderError } from '../src/provider.js';
import { JevTaskIntakeDecisionProvider } from '../src/providers/jev.js';
import { IntakeSupervisor } from '../src/supervisor.js';

describe('intake supervisor', () => {
  function setup() {
    const db = openDb(':memory:');
    runMigrations(db);
    const core = createCore(db);
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'], settleSeconds: 0 });
    const task = core.createTask({ title: 'one', spec: 's', acceptanceCriteria: 'a' });
    const config = parseConfig({ db: ':memory:', provider: { name: 'fixture' } });
    return { db, core, task, config };
  }

  it('reassesses an edited revision', async () => {
    const { core, task, config } = setup();
    const provider = new FixtureTaskIntakeDecisionProvider();
    const assess = vi.spyOn(provider, 'assess');
    const supervisor = new IntakeSupervisor(config, { core, provider });
    await supervisor.tick();
    core.updateTask(task.key, { title: 'edited' });
    await supervisor.tick();
    expect(assess).toHaveBeenCalledTimes(2);
    expect(core.getTask(task.key).intake?.state).toBe('current');
  });

  it('applies live workspace-policy opt-out before provider input', async () => {
    const { core, config } = setup();
    core.updateWorkspace('default', { policy: 'PRIVATE_POLICY_SENTINEL' });
    const provider = new FixtureTaskIntakeDecisionProvider();
    const assess = vi.spyOn(provider, 'assess');
    const supervisor = new IntakeSupervisor(config, { core, provider });
    await supervisor.tick();
    expect(JSON.stringify(assess.mock.calls)).not.toContain('PRIVATE_POLICY_SENTINEL');
  });

  it('changes outgoing policy text when the live setting changes without restarting', async () => {
    const { core, config } = setup();
    core.updateWorkspace('default', { policy: 'PRIVATE_POLICY_SENTINEL' });
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'], settleSeconds: 0, sendWorkspacePolicy: true });
    const fetchImpl = vi.fn().mockImplementation(async () => new Response('{}', { status: 400 }));
    const provider = new JevTaskIntakeDecisionProvider({ endpoint: 'https://example.test', apiKey: 'test', model: 'test', sendWorkspacePolicy: true, fetchImpl });
    const supervisor = new IntakeSupervisor(config, { core, provider });
    await supervisor.tick();
    expect(fetchImpl.mock.calls[0]?.[1].body).toContain('PRIVATE_POLICY_SENTINEL');
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'], settleSeconds: 0, sendWorkspacePolicy: false });
    core.createTask({ title: 'two', spec: 's', acceptanceCriteria: 'a' });
    await supervisor.tick();
    expect(fetchImpl.mock.calls[1]?.[1].body).not.toContain('PRIVATE_POLICY_SENTINEL');
  });

  it('stops polling after auth failure and refunds its attempt', async () => {
    const { core, db, config } = setup();
    const assess = vi.fn().mockRejectedValue(new IntakeProviderError('auth', 'sanitized'));
    const exit = vi.fn();
    const supervisor = new IntakeSupervisor(config, { core, provider: { name: 'fixture', assess }, exit });
    await supervisor.safeTick();
    await supervisor.safeTick();
    expect(assess).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM retry_attempt').get()).toMatchObject({ n: 0 });
  });

  it('retries invalid responses after durable backoff', async () => {
    const { core, db, task, config } = setup();
    const fixture = new FixtureTaskIntakeDecisionProvider();
    const assess = vi.fn().mockRejectedValueOnce(new IntakeProviderError('invalid_response', 'sanitized')).mockImplementation((...args: Parameters<typeof fixture.assess>) => fixture.assess(...args));
    const supervisor = new IntakeSupervisor(config, { core, provider: { name: 'fixture', assess } });
    await supervisor.tick();
    expect(core.getTask(task.key).intake).toBeNull();
    await supervisor.tick();
    expect(assess).toHaveBeenCalledTimes(1);
    db.prepare("UPDATE retry_attempt SET settled_at = '2020-01-01T00:00:00.000Z'").run();
    await supervisor.tick();
    expect(assess).toHaveBeenCalledTimes(2);
    expect(core.getTask(task.key).intake?.state).toBe('current');
  });

  it('treats HTTP 529 as retryable overload', async () => {
    const { core, db, task, config } = setup();
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'], settleSeconds: 0, maxAttempts: 2 });
    const provider = new JevTaskIntakeDecisionProvider({ endpoint: 'https://example.test', apiKey: 'test', model: 'test', fetchImpl: vi.fn().mockResolvedValue(new Response('{}', { status: 529 })) });
    const supervisor = new IntakeSupervisor(config, { core, provider });
    await supervisor.tick();
    expect(core.getTask(task.key).intake).toBeNull();
    await supervisor.tick();
    expect(db.prepare('SELECT COUNT(*) AS n FROM retry_attempt').get()).toMatchObject({ n: 1 });
    db.prepare("UPDATE retry_attempt SET settled_at = '2020-01-01T00:00:00.000Z'").run();
    await supervisor.tick();
    await supervisor.tick();
    await supervisor.tick();
    expect(db.prepare('SELECT COUNT(*) AS n FROM retry_attempt').get()).toMatchObject({ n: 2 });
    expect(core.getTask(task.key).intake?.state).toBe('unavailable');
    expect(core.intakeHistory(task.key)).toHaveLength(1);
  });
  it('uses fixture decisions, selection ordering, reservations, and the intake heartbeat', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const core = createCore(db);
    core.setIntakeSettings({ mode: 'advisory', workspaces: ['default'], maxPerTick: 5, settleSeconds: 0 });
    const queued = core.createTask({ title: 'queued', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(queued.key, 'queued', 'human');
    const backlog = core.createTask({ title: 'backlog', spec: 's', acceptanceCriteria: 'a' });
    const supervisor = new IntakeSupervisor(parseConfig({ db: ':memory:', provider: { name: 'fixture' } }), {
      core, provider: new FixtureTaskIntakeDecisionProvider(), console: { log() {}, warn() {}, error() {} },
    });
    await supervisor.tick();
    expect(core.getTask(queued.key).intake?.state).toBe('current');
    expect(core.getTask(backlog.key).intake?.state).toBe('current');
    expect(core.listSupervisors()[0]?.kind).toBe('intake');
    const attempts = db.prepare("SELECT a.state FROM retry_attempt a JOIN retry_budget b ON b.id = a.budget_id WHERE b.operation LIKE 'intake:assess:%'").all() as Array<{ state: string }>;
    expect(attempts.every((a) => a.state === 'succeeded')).toBe(true);
  });

  it('accepts default-off configuration without a provider for safe startup checks', () => {
    expect(parseConfig({ db: ':memory:' }).provider).toBeUndefined();
  });
});
