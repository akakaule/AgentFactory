import { parseFailureComment } from '@agentfactory/core';
import type { ActivityFeedRow, AttentionReason, CaptureNotificationsInput, NotificationOutboxEntry, NotificationEventType, SupervisorView, Task, Status } from '@agentfactory/core';

/**
 * The unattended-loop notifier. A poll loop in the always-on web process that derives "you're
 * needed" events from the activity feed (a task entered review, a failure note was posted) and
 * from supervisor/queue state, and POSTs a Slack-incoming-webhook-compatible `{ text }` payload to
 * each configured URL. Polling the activity log (not hooking a single op) makes it process-agnostic:
 * it catches agent-driven transitions from the MCP process too, not just web-server actions —
 * consistent with the codebase's derive-from-activity philosophy.
 *
 * Dedup is structural, not time-based: the core captures activity and state occurrences plus one
 * outbox row per destination in the same transaction that advances the source cursor. Delivery is
 * at-least-once: a timeout after a receiver accepted a POST can duplicate an alert on retry.
 */

export type NotifyEvent = NotificationEventType;
export const ALL_NOTIFY_EVENTS: readonly NotifyEvent[] = ['in_review', 'failed', 'skip_listed', 'supervisor_down', 'queue_empty', 'blocked', 'setup_needed', 'delivery_wait', 'delivery_stalled'];
/** Sensible default: the "needs a human" events, without the noisier transient-failure / queue-empty ones. */
export const DEFAULT_NOTIFY_EVENTS: readonly NotifyEvent[] = ['in_review', 'skip_listed', 'supervisor_down', 'blocked', 'setup_needed', 'delivery_stalled'];

const CURSOR_KEY = 'notify_cursor';

/** The slice of Core the notifier reads. */
export interface NotifierCore {
  activitySince(sinceId: number, limit?: number): ActivityFeedRow[];
  latestActivityId(): number;
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;
  listSupervisors(): SupervisorView[];
  listTasks(opts?: { status?: Status | undefined }): Task[];
  captureNotifications?: (input: CaptureNotificationsInput) => void | Promise<void>;
  listNotificationOutbox?: (now?: string, limit?: number) => NotificationOutboxEntry[] | Promise<NotificationOutboxEntry[]>;
  settleNotificationOutbox?: (id: number, input: { ok: boolean; now?: string; retryAt?: string; error?: string }) => boolean | Promise<boolean>;
}

/** Minimal fetch surface (global `fetch` satisfies it); injectable so tests don't hit the network. */
export type NotifyFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface NotifierConfig {
  webhooks: string[];
  events: Set<NotifyEvent>;
  pollMs: number;
  appUrl?: string;
  timeoutMs?: number;
  maxAttempts?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  reviewWaitMs?: number;
  deliveryWaitMs?: number;
}

export interface NotifierDeps {
  core: NotifierCore;
  fetch: NotifyFetch;
  console?: Pick<Console, 'log' | 'warn' | 'error'> | undefined;
}

/** Build a NotifierConfig from env, or null when no webhooks are configured (notifier disabled). */
export function notifierConfigFromEnv(env: Record<string, string | undefined>): NotifierConfig | null {
  const webhooks = (env['AF_NOTIFY_WEBHOOKS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (webhooks.length === 0) return null;
  const requested = (env['AF_NOTIFY_EVENTS'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const chosen = (requested.length ? requested : DEFAULT_NOTIFY_EVENTS).filter(
    (e): e is NotifyEvent => (ALL_NOTIFY_EVENTS as readonly string[]).includes(e),
  );
  const pollSec = Number(env['AF_NOTIFY_POLL_SEC'] ?? '15');
  const timeoutMs = Number(env['AF_NOTIFY_TIMEOUT_MS'] ?? '10000');
  const maxAttempts = Number(env['AF_NOTIFY_MAX_ATTEMPTS'] ?? '5');
  const retryBaseSec = Number(env['AF_NOTIFY_RETRY_BASE_SEC'] ?? '15');
  const retryMaxSec = Number(env['AF_NOTIFY_RETRY_MAX_SEC'] ?? '900');
  const port = env['PORT'] ?? '8787';
  const reviewWait = Number(env['AF_NOTIFY_REVIEW_WAIT_SEC'] ?? '1800');
  const deliveryWait = Number(env['AF_NOTIFY_DELIVERY_WAIT_SEC'] ?? '3600');
  return {
    webhooks: [...new Set(webhooks)], events: new Set(chosen),
    pollMs: (Number.isFinite(pollSec) && pollSec > 0 ? pollSec : 15) * 1000,
    appUrl: env['AF_APP_URL']?.trim() || `http://localhost:${port}`,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 10000,
    maxAttempts: Number.isInteger(maxAttempts) && maxAttempts > 0 ? maxAttempts : 5,
    retryBaseMs: Number.isFinite(retryBaseSec) && retryBaseSec > 0 ? retryBaseSec * 1000 : 15000,
    retryMaxMs: Number.isFinite(retryMaxSec) && retryMaxSec > 0 ? retryMaxSec * 1000 : 900000,
    reviewWaitMs: Number.isFinite(reviewWait) && reviewWait >= 0 ? reviewWait * 1000 : 1800000,
    deliveryWaitMs: Number.isFinite(deliveryWait) && deliveryWait >= 0 ? deliveryWait * 1000 : 3600000,
  };
}

export class Notifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private initialized = false;
  private tickInFlight: Promise<void> | null = null;
  private readonly down = new Set<string>(); // supervisors currently alerted as down (edge detection)
  private queueEmpty = false;

  constructor(private readonly cfg: NotifierConfig, private readonly deps: NotifierDeps) {}

  private get console(): Pick<Console, 'log' | 'warn' | 'error'> {
    return this.deps.console ?? console;
  }

  start(): void {
    if (this.timer) return;
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), this.cfg.pollMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.console.error(`[notifier] tick failed: ${(err as Error).message}`);
    }
  }

  async tick(): Promise<void> {
    if (this.tickInFlight) return this.tickInFlight;
    const work = this.runTick();
    this.tickInFlight = work;
    try {
      await work;
    } finally {
      if (this.tickInFlight === work) this.tickInFlight = null;
    }
  }

  private async runTick(): Promise<void> {
    this.ensureCursor();
    if (this.deps.core.captureNotifications && this.deps.core.listNotificationOutbox && this.deps.core.settleNotificationOutbox) {
      await this.durableTick();
      return;
    }
    await this.processActivity();
    await this.processState();
  }

  /** First run: skip history — start the cursor at the latest activity id so only NEW events alert. */
  private ensureCursor(): void {
    if (this.initialized) return;
    const stored = this.deps.core.getKv(CURSOR_KEY);
    if (stored !== null) {
      this.cursor = Number(stored) || 0;
    } else {
      this.cursor = this.deps.core.latestActivityId();
      this.deps.core.setKv(CURSOR_KEY, String(this.cursor));
    }
    this.initialized = true;
  }

  private async processActivity(): Promise<void> {
    const rows = this.deps.core.activitySince(this.cursor, 200);
    for (const row of rows) {
      const ev = this.classify(row);
      if (ev && this.cfg.events.has(ev.type)) await this.send(ev.text);
      this.cursor = row.id;
    }
    if (rows.length) this.deps.core.setKv(CURSOR_KEY, String(this.cursor));
  }

  private classify(row: ActivityFeedRow): { type: NotifyEvent; text: string } | null {
    if (row.type === 'status_change' && row.toStatus === 'in_review') {
      return { type: 'in_review', text: this.taskText(`:eyes: *${row.taskKey}* needs review — ${row.taskTitle} _(${row.workspace})_`, row.taskKey) };
    }
    if (row.type === 'comment') {
      const f = parseFailureComment(row.body);
      if (f) {
        const skip = f.reason === 'max_attempts' || (f.attempt !== null && f.maxAttempts !== null && f.attempt >= f.maxAttempts);
        if (skip) return { type: 'skip_listed', text: this.taskText(`:rotating_light: *${row.taskKey}* skip-listed (${f.reason}, attempt ${f.attempt ?? '?'}/${f.maxAttempts ?? '?'}) — needs you. Action: fix the cause, then restart the task. ${row.taskTitle}`, row.taskKey) };
        return { type: 'failed', text: this.taskText(`:warning: *${row.taskKey}* failed: ${f.reason} (attempt ${f.attempt ?? '?'}/${f.maxAttempts ?? '?'}). Action: automatic retry within the remaining budget; inspect the task if it persists.${f.detail ? ` — ${f.detail}` : ''}`, row.taskKey) };
      }
    }
    return null;
  }

  private async processState(): Promise<void> {
    if (this.cfg.events.has('supervisor_down')) {
      for (const s of this.deps.core.listSupervisors()) {
        if (!s.healthy && !this.down.has(s.name)) {
          this.down.add(s.name);
          await this.send(`:red_circle: supervisor *${s.name}* (${s.kind}) is down — not seen in ${s.staleSeconds}s`);
        } else if (s.healthy && this.down.has(s.name)) {
          this.down.delete(s.name);
          await this.send(`:large_green_circle: supervisor *${s.name}* recovered`);
        }
      }
    }
    if (this.cfg.events.has('queue_empty')) {
      const queued = this.deps.core.listTasks({ status: 'queued' }).length;
      if (queued === 0 && !this.queueEmpty) {
        this.queueEmpty = true;
        await this.send(':inbox_tray: the queue is empty — no work left to dispatch');
      } else if (queued > 0) {
        this.queueEmpty = false;
      }
    }
  }

  /** New path: capture all derived events before attempting any network delivery. */
  private async durableTick(): Promise<void> {
    const rows = this.deps.core.activitySince(this.cursor, 200);
    const tasks = this.deps.core.listTasks();
    const occurrences: CaptureNotificationsInput['occurrences'] = [];
    for (const row of rows) {
      const task = tasks.find(t => t.key === row.taskKey);
      // Current task state owns review/blocked/setup/exhaustion edges; activity still captures
      // transient failures and legacy tasks that cannot be resolved through listTasks.
      if (task && row.type === 'status_change' && row.toStatus === 'in_review') continue;
      const event = this.classify(row);
      if (!event || !this.cfg.events.has(event.type)) continue;
      if (task && (event.type === 'skip_listed' || this.needsSetup(task))) continue;
      occurrences.push({
        key: `activity:${row.id}`, eventType: event.type,
        reason: this.reasonFor(event.type), target: row.taskKey, taskKey: row.taskKey, text: event.text,
      });
    }
    const nextCursor = rows.length ? rows[rows.length - 1]!.id : this.cursor;
    occurrences.push(...this.stateOccurrences(), ...this.taskOccurrences(tasks));
    await this.deps.core.captureNotifications!({
      sourceCursor: nextCursor, destinations: this.cfg.webhooks,
      maxAttempts: this.cfg.maxAttempts ?? 5, occurrences,
      now: new Date().toISOString(),
    });
    this.cursor = nextCursor;
    await this.deliverOutbox();
  }

  private stateOccurrences(): CaptureNotificationsInput['occurrences'] {
    const out: CaptureNotificationsInput['occurrences'] = [];
    if (this.cfg.events.has('supervisor_down')) {
      for (const s of this.deps.core.listSupervisors()) {
        out.push({
          key: `supervisor:${s.name}:down`, stateKey: `supervisor:${s.name}:down`, eventType: 'supervisor_down',
          reason: 'supervisor_unavailable', target: s.name,
          text: this.supervisorText(s), active: !s.healthy,
        });
      }
    }
    if (this.cfg.events.has('queue_empty')) {
      const empty = this.deps.core.listTasks({ status: 'queued' }).length === 0;
      out.push({
        key: 'queue:empty', stateKey: 'queue:empty', eventType: 'queue_empty', reason: 'queue_empty', target: 'queue',
        text: ':inbox_tray: the queue is empty — no work left to dispatch', active: empty,
      });
    }
    return out;
  }

  private async deliverOutbox(): Promise<void> {
    const ready = await this.deps.core.listNotificationOutbox!(new Date().toISOString(), 100);
    for (const item of ready) {
      const now = new Date().toISOString();
      try {
        const res = await this.fetchWithTimeout(item.destination, item.text, item.occurrenceId);
        if (!res.ok) throw new Error(`webhook returned ${res.status}`);
        await this.deps.core.settleNotificationOutbox!(item.id, { ok: true, now });
      } catch (err) {
        const delay = Math.min((this.cfg.retryBaseMs ?? 15000) * 2 ** item.attempts, this.cfg.retryMaxMs ?? 900000);
        const retryAt = new Date(Date.now() + delay).toISOString();
        const error = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
        await this.deps.core.settleNotificationOutbox!(item.id, { ok: false, now, retryAt, error });
        this.console.warn(`[notifier] ${item.destination}: ${error} — retry at ${retryAt}`);
      }
    }
  }

  private async fetchWithTimeout(url: string, text: string, occurrenceId: number): Promise<{ ok: boolean; status: number }> {
    const timeoutMs = this.cfg.timeoutMs ?? 10000;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`webhook timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        this.deps.fetch(url, {
          method: 'POST', headers: { 'content-type': 'application/json', 'X-AgentFactory-Event-Id': String(occurrenceId) }, body: JSON.stringify({ text }), signal: controller.signal,
        }),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private reasonFor(type: NotifyEvent): AttentionReason {
    if (type === 'in_review') return 'review_ready';
    if (type === 'skip_listed') return 'attempts_exhausted';
    if (type === 'supervisor_down') return 'supervisor_unavailable';
    if (type === 'queue_empty') return 'queue_empty';
    if (type === 'blocked' || type === 'setup_needed' || type === 'delivery_wait' || type === 'delivery_stalled') return type;
    return 'failed';
  }

  private needsSetup(task: Task): boolean {
    return !!task.failure && (task.failure.reason === 'spawn_failed' ||
      /credentials?|authentication|unauthorized|permission|not found|missing (?:cli|checkout|token)/i.test(task.failure.detail ?? ''));
  }

  private taskOccurrences(tasks: Task[]): CaptureNotificationsInput['occurrences'] {
    const out: CaptureNotificationsInput['occurrences'] = [];
    for (const task of tasks) {
      const age = Date.now() - Date.parse(task.updatedAt);
      const reviewReady = task.status === 'in_review' && (task.stage === 'implementation' ||
        task.aiReview?.verdict === 'findings' || task.aiReview?.verdict === 'disputed' ||
        task.failure?.skipListed === true || age >= (this.cfg.reviewWaitMs ?? 1800000));
      const deliveryAge = Date.now() - Date.parse(task.delivery?.stateChangedAt ?? task.updatedAt);
      const stalled = task.status === 'delivering' && (task.delivery?.checksState === 'failing' ||
        deliveryAge >= (this.cfg.deliveryWaitMs ?? 3600000));
      const setup = this.needsSetup(task) && task.status !== 'done';
      const attempts = task.failure ? ` Attempt ${task.failure.attempt ?? '?'}/${task.failure.maxAttempts ?? '?'}.` : '';
      const states: Array<[NotifyEvent, boolean, string]> = [
        ['in_review', reviewReady, 'needs review. Action: inspect the findings and deliverable, then approve or request changes.'],
        ['blocked', task.status === 'blocked' && !setup, 'is blocked. Automatic work is paused. Action: answer the blocker shown on the task, then unblock it.'],
        ['setup_needed', setup, `needs setup repair.${attempts} Action: repair credentials, permissions or tool installation before restarting the task.`],
        ['skip_listed', task.status !== 'done' && task.failure?.skipListed === true && !setup,
          `is skip-listed and needs you.${attempts} No automatic retries remain. Action: inspect the failure, fix its cause, then restart the task.`],
        ['delivery_wait', task.status === 'delivering' && !stalled, 'is awaiting delivery. Action: inspect PR checks and merge readiness; the watcher is monitoring.'],
        ['delivery_stalled', stalled, 'has stalled delivery. Action: inspect the PR and failing or pending checks; resolve the delivery blocker.'],
      ];
      for (const [eventType, active, message] of states) {
        if (!this.cfg.events.has(eventType)) continue;
        const stateKey = `task:${task.key}:${eventType}`;
        out.push({ key: stateKey, stateKey, eventType, reason: this.reasonFor(eventType), target: task.key,
          taskKey: task.key, active, text: this.taskText(`*${task.key}* ${message} ${task.title}`, task.key) });
      }
    }
    return out;
  }

  private taskText(text: string, taskKey: string): string {
    const url = this.taskUrl(taskKey);
    const suffix = url ? ` — <${url}|open task>` : '';
    return `${text.slice(0, Math.max(0, 16384 - suffix.length))}${suffix}`;
  }

  private taskUrl(taskKey: string): string | null {
    const base = this.cfg.appUrl?.trim();
    if (!base) return null;
    try {
      const url = new URL(base);
      if (!['http:', 'https:'].includes(url.protocol)) return null;
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
      url.searchParams.set('task', taskKey);
      return url.toString().length <= 2048 ? url.toString() : null;
    } catch { return null; }
  }

  private supervisorText(s: SupervisorView): string {
    return `:red_circle: supervisor *${s.name.slice(0, 500)}* (${s.kind}) is down — not seen in ${s.staleSeconds}s. Action: inspect its logs and restart the supervisor.`;
  }

  private async send(text: string): Promise<void> {
    for (const url of this.cfg.webhooks) {
      try {
        const res = await this.deps.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (!res.ok) this.console.warn(`[notifier] webhook returned ${res.status}`);
      } catch (err) {
        this.console.warn(`[notifier] webhook failed: ${(err as Error).message}`);
      }
    }
  }
}
