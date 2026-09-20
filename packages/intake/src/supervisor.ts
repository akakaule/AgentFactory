import { intakeRevision, type Core, type IntakeAssessmentV1, type Task, type TaskDetail, type TaskIntakeState } from '@agentfactory/core';
import type { IntakeConfig } from './config.js';
import { IntakeProviderError, type TaskIntakeDecisionProvider } from './provider.js';

type Awaitable<T> = T | Promise<T>;
type AwaitableSlice<T, K extends keyof T> = { [P in K]: T[P] extends (...a: infer A) => infer R ? (...a: A) => Awaitable<Awaited<R>> : T[P] };
export type IntakeCore = AwaitableSlice<Core, 'listTasks' | 'getTask' | 'listWorkspaces' | 'recordSupervisorHeartbeat' | 'intakeRuntimeSettings' | 'beginIntakeAssessment' | 'recordIntakeAssessment' | 'settleRetry'>;
export interface IntakeSupervisorDeps { core: IntakeCore; provider: TaskIntakeDecisionProvider; now?: () => number; console?: Pick<Console, 'log' | 'warn' | 'error'>; exit?: (code: number) => void; }

export class IntakeSupervisor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private authFailed = false;
  constructor(private readonly config: IntakeConfig, private readonly deps: IntakeSupervisorDeps) {}
  start(): void { void this.safeTick(); this.timer = setInterval(() => void this.safeTick(), this.config.pollSeconds * 1000); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }
  async safeTick(): Promise<void> {
    if (this.ticking || this.authFailed) return;
    this.ticking = true;
    try { await this.tick(); }
    catch (error) {
      if (error instanceof IntakeProviderError && error.kind === 'auth') { this.authFailed = true; this.stop(); this.deps.console?.error('[intake] provider authentication failed; stopping'); this.deps.exit?.(1); return; }
      this.deps.console?.error('[intake] tick failed:', error);
    } finally { this.ticking = false; }
  }
  async tick(): Promise<void> {
    if (this.authFailed) return;
    const settings = await this.deps.core.intakeRuntimeSettings();
    const workspaces = settings.workspaces;
    const list = await this.deps.core.listTasks();
    const settleBefore = (this.deps.now?.() ?? Date.now()) - settings.settleSeconds * 1000;
    const candidates = list.filter((task) => task.kind === 'code' && !task.archivedAt && (task.status === 'queued' || task.status === 'backlog' || task.status === 'in_progress') && workspaces.includes(task.workspace) && (task.intake == null || task.intake.state === 'stale') && Date.parse(task.updatedAt) <= settleBefore);
    candidates.sort((a, b) => statusRank(a.status) - statusRank(b.status) || a.updatedAt.localeCompare(b.updatedAt) || a.key.localeCompare(b.key));
    await this.deps.core.recordSupervisorHeartbeat({ name: this.config.name, kind: 'intake', workspaces, inFlight: 0, capacity: this.config.maxPerTick, pollSeconds: this.config.pollSeconds });
    if (settings.mode === 'off' || candidates.length === 0) return;
    for (const task of candidates.slice(0, Math.min(settings.maxPerTick, this.config.maxPerTick))) await this.assess(task.key, settings.maxAttempts);
  }
  private async assess(key: string, maxAttempts: number): Promise<void> {
    const detail = await this.deps.core.getTask(key);
    const latestSettings = await this.deps.core.intakeRuntimeSettings();
    if (latestSettings.mode === 'off' || !latestSettings.workspaces.includes(detail.workspace)) return;
    const revision = intakeRevision(detail);
    const begun = await this.deps.core.beginIntakeAssessment(key, revision, latestSettings.maxAttempts);
    if (begun.status === 'busy' || begun.status === 'deferred' || begun.status === 'already_assessed' || begun.status === 'ineligible') return;
    if (begun.status === 'exhausted') {
      const unavailable = unavailableAssessment(detail, null, 'unavailable', this.deps.now?.() ?? Date.now());
      await this.deps.core.recordIntakeAssessment(key, unavailable);
      return;
    }
    const reservation = begun.reservation!;
    const started = this.deps.now?.() ?? Date.now();
    const input: TaskIntakeState = {
      key: detail.key, title: detail.title, spec: detail.spec, acceptanceCriteria: detail.acceptanceCriteria, stage: detail.stage, plan: detail.plan,
      links: detail.links.map(({ kind, label }) => ({ kind, label })), attachmentCount: detail.attachments.length, workspacePolicy: latestSettings.sendWorkspacePolicy ? detail.policy : null,
    };
    try {
      const result = await this.deps.provider.assess(input, AbortSignal.timeout(this.config.provider?.timeoutSeconds ? this.config.provider.timeoutSeconds * 1000 : 20_000));
      const assessment: IntakeAssessmentV1 = { schema: 'intake/v1', status: 'assessed', taskKey: key, sourceRevision: revision, attemptId: reservation.id, stage: detail.stage, questionSet: 'intake-questions/v1', provider: { name: this.deps.provider.name, model: result.model }, usage: result.usage, assessedAt: new Date().toISOString(), latencyMs: Math.max(0, (this.deps.now?.() ?? Date.now()) - started), decisions: result.decisions };
      await this.deps.core.recordIntakeAssessment(key, assessment);
      await this.deps.core.settleRetry(reservation.id, { state: 'succeeded' });
    } catch (error) {
      const providerError = error instanceof IntakeProviderError ? error : new IntakeProviderError('network', 'provider request failed');
      if (providerError.kind === 'auth') { await this.deps.core.settleRetry(reservation.id, { state: 'cancelled' }); throw providerError; }
      if (providerError.kind === 'input_too_large') {
        await this.deps.core.settleRetry(reservation.id, { state: 'cancelled', reason: 'input_too_large' });
        await this.deps.core.recordIntakeAssessment(key, unavailableAssessment(detail, null, 'input_too_large', this.deps.now?.() ?? Date.now()));
        return;
      }
      if (providerError.kind === 'unavailable') {
        await this.deps.core.recordIntakeAssessment(key, unavailableAssessment(detail, reservation.id, providerError.kind, this.deps.now?.() ?? Date.now()));
        return;
      }
      await this.deps.core.settleRetry(reservation.id, { state: 'failed', reason: providerError.kind });
    }
  }
}

function statusRank(status: Task['status']): number { return status === 'queued' ? 0 : status === 'backlog' ? 1 : 2; }
function unavailableAssessment(detail: TaskDetail, attemptId: string | null, kind: 'unavailable' | 'invalid_response' | 'input_too_large', now: number): IntakeAssessmentV1 {
  return { schema: 'intake/v1', status: 'unavailable', taskKey: detail.key, sourceRevision: intakeRevision(detail), attemptId, stage: detail.stage, questionSet: 'intake-questions/v1', provider: { name: 'intake', model: null }, usage: { inputTokens: null, outputTokens: null }, assessedAt: new Date(now).toISOString(), latencyMs: 0, error: { kind, detail: kind === 'input_too_large' ? 'provider input limit exceeded' : 'assessment unavailable' } };
}
