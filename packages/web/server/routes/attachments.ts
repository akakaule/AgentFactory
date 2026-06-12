import { Hono } from 'hono';
import type { Core } from '../types.js';

export function attachmentRoutes(core: Core) {
  const r = new Hono();

  // ids are append-only, bytes immutable — safe to cache hard
  r.get('/:id', (c) => {
    const a = core.getAttachment(Number(c.req.param('id')));
    return c.body(a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength) as ArrayBuffer, 200, {
      'content-type': a.mime,
      'cache-control': 'private, max-age=31536000, immutable',
    });
  });

  r.delete('/:id', (c) => {
    core.deleteAttachment(Number(c.req.param('id')));
    return c.body(null, 204);
  });

  return r;
}
