import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { Core } from './types.js';
import { taskRoutes } from './routes/tasks.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { agentPromptRoutes } from './routes/agentPrompts.js';
import { analyticsRoutes } from './routes/analytics.js';
import { attachmentRoutes } from './routes/attachments.js';
import { agentRoutes } from './routes/agents.js';
import { supervisorRoutes } from './routes/supervisors.js';
import { supervisorSettingsRoutes } from './routes/supervisorSettings.js';
import { otelRoutes } from './routes/otel.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { authRoutes } from './routes/auth.js';
import { authMiddleware, type AuthConfig } from './auth.js';
import { mapError } from './errors.js';
import { registerSse } from './sse.js';
import { createTelemetryStore, type TelemetryStore } from './telemetry.js';

export function buildApp(core: Core, opts: { sseIntervalMs?: number; auth?: AuthConfig; telemetry?: TelemetryStore } = {}): Hono {
  const auth = opts.auth ?? { mode: 'none' };
  // One ring shared between the OTLP receiver (writes) and the /api/telemetry read route.
  const telemetry = opts.telemetry ?? createTelemetryStore();
  const app = new Hono();
  // Guard the data surface (/api/* and /events); the SPA shell (mounted later in the
  // production entry) and /auth stay public so the login flow can bootstrap. In 'none'
  // mode the guard resolves an anon principal and never 401s — today's local behavior.
  // Public liveness probe (no auth): is the server up and the DB reachable? Returns the board
  // version string so a watchdog can also detect a wedged DB. Registered before the guards.
  app.get('/health', (c) => {
    try {
      return c.json({ ok: true, version: core.getVersion() });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 503);
    }
  });
  const guard = authMiddleware(core, auth);
  app.use('/api/*', guard);
  app.use('/events', guard);
  app.use('/v1/*', guard); // OTLP ingest — token mode requires a (service) token in OTLP headers
  app.route('/auth', authRoutes(core, auth));
  app.route('/api/tasks', taskRoutes(core));
  app.route('/api/workspaces', workspaceRoutes(core));
  app.route('/api/agent-prompts', agentPromptRoutes(core));
  app.route('/api/analytics', analyticsRoutes(core));
  app.route('/api/attachments', attachmentRoutes(core));
  app.route('/api/agents', agentRoutes(core));
  app.route('/api/supervisors', supervisorRoutes(core));
  app.route('/api/supervisor-settings', supervisorSettingsRoutes(core));
  app.route('/api/telemetry', telemetryRoutes(telemetry)); // live OTel feed (read side)
  app.route('/v1', otelRoutes(core, telemetry)); // OTLP/HTTP logs receiver → task_metric + live feed (POST /v1/logs)
  registerSse(app, core, opts.sseIntervalMs ?? 1000);
  app.onError((err, c) => {
    const httpErr = err instanceof HTTPException ? err : mapError(err);
    return httpErr.getResponse();
  });
  return app;
}
