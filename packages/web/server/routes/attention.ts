import { Hono } from 'hono';
import type { Core } from '../types.js';
import { validated } from '../validate.js';
import { attentionSnoozeBody } from '../schemas.js';
import { rejectService } from '../auth.js';

/** Board-authoritative attention and notification delivery state. */
export function attentionRoutes(core: Core): Hono {
  const r = new Hono();
  r.get('/', (c) => c.json({ occurrences: core.listAttentionOccurrences(), outbox: core.listAllNotificationOutbox() }));
  r.post('/:id/resolve', rejectService, (c) => c.json({ resolved: core.resolveAttention(Number(c.req.param('id'))) }));
  r.post('/:id/snooze', rejectService, validated('json', attentionSnoozeBody), (c) =>
    c.json({ snoozed: core.snoozeAttention(Number(c.req.param('id')), c.req.valid('json').until) }));
  return r;
}
