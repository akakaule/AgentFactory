import { streamSSE } from 'hono/streaming';
import type { Hono } from 'hono';
import type { Core } from './types.js';

export function registerSse(app: Hono, core: Core, intervalMs = 1000): void {
  app.get('/events', (c) =>
    streamSSE(c, async (stream) => {
      let last = core.getVersion();
      await stream.writeSSE({ event: 'version', data: String(last) });
      while (!stream.closed && !stream.aborted) {
        const v = core.getVersion();
        if (v !== last) {
          last = v;
          await stream.writeSSE({ event: 'version', data: String(v) });
        } else {
          await stream.writeSSE({ event: 'ping', data: '1' });
        }
        await stream.sleep(intervalMs);
      }
    }),
  );
}
