import type { DB } from '../db.js';
import { transaction } from '../transaction.js';
import { ValidationError } from '../errors.js';
import { nowIso } from '../time.js';
import type { AttentionOccurrence, CaptureNotificationsInput, NotificationOutboxEntry, SettleNotificationInput } from '../types.js';
import { captureNotifications as captureRows, MAX_NOTIFICATION_TEXT, selectAllNotificationOutbox, selectAttentionOccurrences, selectReadyNotificationOutbox, settleNotificationOutbox as settleRow, resolveAttention as resolveRow, snoozeAttention as snoozeRow } from '../repo/notifications.js';

function validateCapture(input: CaptureNotificationsInput): void {
  if (!Number.isInteger(input.sourceCursor) || input.sourceCursor < 0) throw new ValidationError('notification source cursor must be a nonnegative integer');
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) throw new ValidationError('notification maxAttempts must be a positive integer');
  for (const destination of input.destinations) {
    if (!destination.trim()) throw new ValidationError('notification destination is required');
    let parsed: URL;
    try { parsed = new URL(destination); } catch { throw new ValidationError('notification destination must be an absolute URL'); }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new ValidationError('notification destination must use http or https');
  }
  for (const item of input.occurrences) {
    if (!item.key.trim() || !item.target.trim() || !item.text.trim()) throw new ValidationError('notification occurrence key, target, and text are required');
    if (item.text.length > MAX_NOTIFICATION_TEXT) throw new ValidationError(`notification text exceeds ${MAX_NOTIFICATION_TEXT} characters`);
  }
}

export function captureNotifications(db: DB, input: CaptureNotificationsInput, now: () => string = nowIso): void {
  validateCapture(input);
  transaction(db, () => captureRows(db, input, input.now ?? now()));
}

export function listAttentionOccurrences(db: DB): AttentionOccurrence[] {
  return selectAttentionOccurrences(db);
}

export function listNotificationOutbox(db: DB, now: string = nowIso(), limit = 100): NotificationOutboxEntry[] {
  if (!Number.isInteger(limit) || limit < 1) throw new ValidationError('notification outbox limit must be a positive integer');
  return selectReadyNotificationOutbox(db, now, limit);
}

export function listAllNotificationOutbox(db: DB): NotificationOutboxEntry[] {
  return selectAllNotificationOutbox(db);
}

export function settleNotificationOutbox(db: DB, id: number, input: SettleNotificationInput, now: () => string = nowIso): boolean {
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('notification outbox id must be a positive integer');
  if (!input.ok && input.error && input.error.length > 2_000) throw new ValidationError('notification error is too long');
  return transaction(db, () => settleRow(db, id, input, input.now ?? now()));
}

export function resolveAttention(db: DB, id: number, now: () => string = nowIso): boolean {
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('attention id must be a positive integer');
  return transaction(db, () => resolveRow(db, id, now()));
}

export function snoozeAttention(db: DB, id: number, until: string): boolean {
  if (!Number.isInteger(id) || id < 1) throw new ValidationError('attention id must be a positive integer');
  if (!until.trim() || Number.isNaN(Date.parse(until))) throw new ValidationError('attention snooze time must be an ISO timestamp');
  return transaction(db, () => snoozeRow(db, id, new Date(until).toISOString(), nowIso()));
}
