import { Hono } from 'hono';
import type { Core } from '../types.js';

export function attachmentRoutes(core: Core) {
  const r = new Hono();

  // ids are append-only, bytes immutable — safe to cache hard. Row metadata rides response
  // headers so createHttpCore can reconstruct the full AttachmentRow (bytes stay the body).
  // The filename is TRUNCATED before encoding: an unbounded value overflows the HTTP header
  // frame (Undici HEADERS_OVERFLOW) — truncate the raw string first so the %-encoding is never
  // cut mid-sequence (decodeURIComponent on the client would throw).
  r.get('/:id', (c) => {
    const a = core.getAttachment(Number(c.req.param('id')));
    return c.body(a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength) as ArrayBuffer, 200, {
      'content-type': a.mime,
      'cache-control': 'private, max-age=31536000, immutable',
      'x-attachment-task-id': String(a.taskId),
      'x-attachment-filename': encodeURIComponent(a.filename.slice(0, 200)),
    });
  });

  r.delete('/:id', (c) => {
    core.deleteAttachment(Number(c.req.param('id')));
    return c.body(null, 204);
  });

  return r;
}
