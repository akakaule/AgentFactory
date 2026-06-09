import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Core } from './types.js';
import { taskRoutes } from './routes/tasks.js';
import { mapError } from './errors.js';
import { registerSse } from './sse.js';

export function buildApp(core: Core, opts: { sseIntervalMs?: number } = {}): Hono {
  const app = new Hono();
  app.route('/api/tasks', taskRoutes(core));
  registerSse(app, core, opts.sseIntervalMs ?? 1000);
  app.onError((err, c) => {
    const httpErr = err instanceof HTTPException ? err : mapError(err);
    return httpErr.getResponse();
  });
  return app;
}
