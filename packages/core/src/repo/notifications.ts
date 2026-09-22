import type { DB } from '../db.js';
import type { AttentionOccurrence, CaptureNotificationsInput, NotificationOutboxEntry, NotificationOutboxState, SettleNotificationInput } from '../types.js';

export const MAX_NOTIFICATION_TEXT = 16_384;

type OccurrenceRow = {
  id: number; event_key: string; state_key: string | null; event_type: AttentionOccurrence['eventType'];
  reason: AttentionOccurrence['reason']; target: string; task_key: string | null; text: string;
  first_seen_at: string; last_seen_at: string; resolved_at: string | null; snoozed_until: string | null;
};

function occurrenceFromRow(r: OccurrenceRow): AttentionOccurrence {
  return {
    id: r.id, key: r.event_key, stateKey: r.state_key, eventType: r.event_type, reason: r.reason,
    target: r.target, taskKey: r.task_key, text: r.text, firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at, resolvedAt: r.resolved_at, snoozedUntil: r.snoozed_until,
  };
}

function insertOutbox(db: DB, occurrenceId: number, text: string, destinations: string[], maxAttempts: number, now: string): void {
  for (const destination of destinations) {
    db.prepare(
      `INSERT OR IGNORE INTO notification_outbox
       (occurrence_id, destination, text, state, attempts, max_attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    ).run(occurrenceId, destination, text, maxAttempts, now, now, now);
  }
}

/** Capture activity/state-derived attention and advance the source cursor in the same transaction. */
export function captureNotifications(db: DB, input: CaptureNotificationsInput, now: string): void {
  const current = db.prepare("SELECT value FROM app_kv WHERE key = 'notify_cursor'").get() as { value: string } | undefined;
  const currentCursor = current ? Number(current.value) : 0;
  if (input.sourceCursor < currentCursor) throw new Error(`notification cursor cannot move backwards (${input.sourceCursor} < ${currentCursor})`);

  for (const item of input.occurrences) {
    let occurrenceId: number | null = null;
    const boundaryKey = item.stateKey ? `notify_state:${item.stateKey}` : null;
    const boundary = boundaryKey ? db.prepare('SELECT value FROM app_kv WHERE key = ?').get(boundaryKey) as { value: string } | undefined : undefined;
    if (item.active === false) {
      if (item.stateKey) {
        db.prepare("INSERT INTO app_kv(key, value) VALUES (?, 'inactive') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(boundaryKey!);
        db.prepare('UPDATE attention_occurrence SET resolved_at = COALESCE(resolved_at, ?), last_seen_at = ? WHERE state_key = ? AND resolved_at IS NULL')
          .run(now, now, item.stateKey);
      }
      continue;
    }

    const existing = db.prepare('SELECT * FROM attention_occurrence WHERE event_key = ?').get(item.key) as OccurrenceRow | undefined;
    // Acknowledgement is independent of the source boundary. Only an observed inactive -> active
    // transition starts a new occurrence; conservatively reuse legacy rows without boundary data.
    const latestState = item.stateKey ? db.prepare('SELECT * FROM attention_occurrence WHERE state_key = ? ORDER BY id DESC LIMIT 1').get(item.stateKey) as OccurrenceRow | undefined : undefined;
    const reusable = item.stateKey ? (boundary?.value === 'inactive' ? undefined : latestState) : existing;
    if (reusable) {
      occurrenceId = reusable.id;
      db.prepare('UPDATE attention_occurrence SET last_seen_at = ? WHERE id = ? AND resolved_at IS NULL').run(now, reusable.id);
    }
    if (occurrenceId === null) {
      let eventKey = item.key;
      if (existing && !reusable) {
        const nextId = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM attention_occurrence').get() as { n: number }).n;
        eventKey = `${item.key}:${nextId}`;
      }
      const result = db.prepare(
        `INSERT INTO attention_occurrence
         (event_key, state_key, event_type, reason, target, task_key, text, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(eventKey, item.stateKey ?? null, item.eventType, item.reason, item.target, item.taskKey ?? null, item.text, now, now);
      occurrenceId = Number(result.lastInsertRowid);
    }
    insertOutbox(db, occurrenceId, item.text, input.destinations, input.maxAttempts, now);
    if (boundaryKey) db.prepare("INSERT INTO app_kv(key, value) VALUES (?, 'active') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(boundaryKey);
  }
  db.prepare("INSERT INTO app_kv(key, value) VALUES ('notify_cursor', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(String(input.sourceCursor));
}

export function selectAttentionOccurrences(db: DB): AttentionOccurrence[] {
  const rows = db.prepare('SELECT * FROM attention_occurrence ORDER BY id ASC').all() as unknown as OccurrenceRow[];
  return rows.map(occurrenceFromRow);
}

type OutboxRow = {
  id: number; occurrence_id: number; destination: string; text: string; state: NotificationOutboxState;
  attempts: number; max_attempts: number; next_attempt_at: string; last_error: string | null;
  sent_at: string | null; created_at: string; updated_at: string; event_type: NotificationOutboxEntry['eventType'];
  reason: NotificationOutboxEntry['reason']; target: string; task_key: string | null;
};

function outboxFromRow(r: OutboxRow): NotificationOutboxEntry {
  return {
    id: r.id, occurrenceId: r.occurrence_id, destination: r.destination, text: r.text, state: r.state,
    attempts: r.attempts, maxAttempts: r.max_attempts, nextAttemptAt: r.next_attempt_at,
    lastError: r.last_error, sentAt: r.sent_at, createdAt: r.created_at, updatedAt: r.updated_at,
    eventType: r.event_type, reason: r.reason, target: r.target, taskKey: r.task_key,
  };
}

export function selectReadyNotificationOutbox(db: DB, now: string, limit: number): NotificationOutboxEntry[] {
  const rows = db.prepare(
      `SELECT o.*, a.event_type, a.reason, a.target, a.task_key
       FROM notification_outbox o JOIN attention_occurrence a ON a.id = o.occurrence_id
      WHERE o.state IN ('pending','failed') AND o.next_attempt_at <= ?
        AND a.resolved_at IS NULL
        AND (a.snoozed_until IS NULL OR a.snoozed_until <= ?)
      ORDER BY o.id ASC LIMIT ?`,
  ).all(now, now, limit) as unknown as OutboxRow[];
  return rows.map(outboxFromRow);
}

export function selectAllNotificationOutbox(db: DB): NotificationOutboxEntry[] {
  const rows = db.prepare(
    `SELECT o.*, a.event_type, a.reason, a.target, a.task_key
       FROM notification_outbox o JOIN attention_occurrence a ON a.id = o.occurrence_id
      ORDER BY o.id ASC`,
  ).all() as unknown as OutboxRow[];
  return rows.map(outboxFromRow);
}

export function settleNotificationOutbox(db: DB, id: number, input: SettleNotificationInput, now: string): boolean {
  const row = db.prepare('SELECT state, attempts, max_attempts FROM notification_outbox WHERE id = ?').get(id) as { state: NotificationOutboxState; attempts: number; max_attempts: number } | undefined;
  if (!row || row.state === 'succeeded' || row.state === 'permanently_failed') return false;
  const attempts = row.attempts + 1;
  if (input.ok) {
    db.prepare("UPDATE notification_outbox SET state = 'succeeded', attempts = ?, sent_at = ?, updated_at = ?, last_error = NULL WHERE id = ?")
      .run(attempts, now, now, id);
  } else {
    const permanentlyFailed = attempts >= row.max_attempts;
    db.prepare(
      `UPDATE notification_outbox SET state = ?, attempts = ?, next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    ).run(permanentlyFailed ? 'permanently_failed' : 'failed', attempts, input.retryAt ?? now, input.error ?? 'notification delivery failed', now, id);
  }
  return true;
}

export function resolveAttention(db: DB, id: number, now: string): boolean {
  const result = db.prepare('UPDATE attention_occurrence SET resolved_at = COALESCE(resolved_at, ?), last_seen_at = ? WHERE id = ?').run(now, now, id);
  return result.changes > 0;
}

export function snoozeAttention(db: DB, id: number, until: string, now: string): boolean {
  const result = db.prepare('UPDATE attention_occurrence SET snoozed_until = ?, last_seen_at = ? WHERE id = ?').run(until, now, id);
  return result.changes > 0;
}
