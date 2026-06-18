import { parseFailureComment } from '@agentfactory/core';
import type { ActivityFeedRow, SupervisorView, Task, Status } from '@agentfactory/core';

/**
 * The unattended-loop notifier. A poll loop in the always-on web process that derives "you're
 * needed" events from the activity feed (a task entered review, a failure note was posted) and
 * from supervisor/queue state, and POSTs a Slack-incoming-webhook-compatible `{ text }` payload to
 * each configured URL. Polling the activity log (not hooking a single op) makes it process-agnostic:
 * it catches agent-driven transitions from the MCP process too, not just web-server actions —
 * consistent with the codebase's derive-from-activity philosophy.
 *
 * Dedup is structural, not time-based: activity events are deduped by the durable `app_kv` cursor
 * (each row processed once, ever); state events (supervisor down, queue empty) fire on the edge
 * (tracked in memory) so they alert once per transition, not every poll.
 */

export type NotifyEvent = 'in_review' | 'failed' | 'skip_listed' | 'supervisor_down' | 'queue_empty';
export const ALL_NOTIFY_EVENTS: readonly NotifyEvent[] = ['in_review', 'failed', 'skip_listed', 'supervisor_down', 'queue_empty'];
/** Sensible default: the "needs a human" events, without the noisier transient-failure / queue-empty ones. */
export const DEFAULT_NOTIFY_EVENTS: readonly NotifyEvent[] = ['in_review', 'skip_listed', 'supervisor_down'];

const CURSOR_KEY = 'notify_cursor';

/** The slice of Core the notifier reads. */
export interface NotifierCore {
  activitySince(sinceId: number, limit?: number): ActivityFeedRow[];
  latestActivityId(): number;
  getKv(key: string): string | null;
  setKv(key: string, value: string): void;
  listSupervisors(): SupervisorView[];
  listTasks(opts?: { status?: Status | undefined }): Task[];
}

/** Minimal fetch surface (global `fetch` satisfies it); injectable so tests don't hit the network. */
export type NotifyFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

export interface NotifierConfig {
  webhooks: string[];
  events: Set<NotifyEvent>;
  pollMs: number;
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
  return { webhooks, events: new Set(chosen), pollMs: (Number.isFinite(pollSec) && pollSec > 0 ? pollSec : 15) * 1000 };
}

export class Notifier {
  private timer: ReturnType<typeof setInterval> | null = null;
  private cursor = 0;
  private initialized = false;
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
    this.ensureCursor();
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
      return { type: 'in_review', text: `:eyes: *${row.taskKey}* needs review — ${row.taskTitle} _(${row.workspace})_` };
    }
    if (row.type === 'comment') {
      const f = parseFailureComment(row.body);
      if (f) {
        const skip = f.reason === 'max_attempts' || (f.attempt !== null && f.maxAttempts !== null && f.attempt >= f.maxAttempts);
        if (skip) return { type: 'skip_listed', text: `:rotating_light: *${row.taskKey}* skip-listed (${f.reason}) — needs you. ${row.taskTitle}` };
        return { type: 'failed', text: `:warning: *${row.taskKey}* failed: ${f.reason}${f.detail ? ` — ${f.detail}` : ''}` };
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
