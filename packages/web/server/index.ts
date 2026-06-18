import { serve } from '@hono/node-server';
import { openCore } from '@agentfactory/core';
import { buildApp } from './app.js';
import { mountStatic } from './static.js';
import { Notifier, notifierConfigFromEnv } from './notifier.js';

const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
const port = Number(process.env['PORT'] ?? 8787);

const authMode = process.env['AUTH_MODE'] ?? 'none';
if (authMode !== 'none' && authMode !== 'token') {
  throw new Error(`AUTH_MODE='${authMode}' is not supported yet (Phase 1 supports none|token; oidc lands in Phase 3)`);
}

const core = openCore(dbPath);
const app = buildApp(core, { auth: { mode: authMode } });

// Mount static SPA serving AFTER the API/SSE routes so /api/* and /events take precedence.
mountStatic(app);

// Unattended-loop notifier: when AF_NOTIFY_WEBHOOKS is set, alert on "needs a human" events.
const notifyCfg = notifierConfigFromEnv(process.env);
if (notifyCfg) {
  new Notifier(notifyCfg, { core, fetch: (url, init) => fetch(url, init) }).start();
}

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentfactory-web] http://localhost:${info.port}  (db: ${dbPath}, auth: ${authMode})`);
  if (notifyCfg) console.log(`[agentfactory-web] notifier on — ${notifyCfg.webhooks.length} webhook(s), events: ${[...notifyCfg.events].join(', ')}`);
});
