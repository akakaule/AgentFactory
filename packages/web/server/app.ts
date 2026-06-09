import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Core } from './types.js';
import { taskRoutes } from './routes/tasks.js';
import { mapError } from './errors.js';

export function buildApp(core: Core): Hono {
  const app = new Hono();
  app.route('/api/tasks', taskRoutes(core));
  // SSE endpoint (/events) and prod static serving are mounted in later tasks.
  app.onError((err, c) => {
    const httpErr = err instanceof HTTPException ? err : mapError(err);
    return httpErr.getResponse();
  });
  return app;
}
