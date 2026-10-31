import { serve } from '@hono/node-server';
import { openCore } from '@agentfactory/core';
import { buildApp } from './app.js';
import { mountStatic } from './static.js';
import { Notifier, notifierConfigFromEnv } from './notifier.js';
import { CredentialMonitor, credentialCheckIntervalMs } from './credentialMonitor.js';

const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
const port = Number(process.env['PORT'] ?? 8787);

const authMode = process.env['AUTH_MODE'] ?? 'none';
if (authMode !== 'none' && authMode !== 'token') {
  throw new Error(`AUTH_MODE='${authMode}' is not supported yet (Phase 1 supports none|token; oidc lands in Phase 3)`);
}

// HTTP agent routes must validate the execution identity supplied by each request; a
// process-local facade cache must never fence an unrelated remote caller on its behalf.
const core = openCore(dbPath, { autoFence: false });
const app = buildApp(core, { auth: { mode: authMode } });

// Mount static SPA serving AFTER the API/SSE routes so /api/* and /events take precedence.
mountStatic(app);

// Unattended-loop notifier: when AF_NOTIFY_WEBHOOKS is set, alert on "needs a human" events.
const notifyCfg = notifierConfigFromEnv(process.env);
if (notifyCfg) {
  new Notifier(notifyCfg, { core, fetch: (url, init) => fetch(url, init) }).start();
}

// Git-credential monitor: probes each workspace's PAT so a rejected one raises the board banner and
// holds that workspace's implementation work (AF_CREDENTIAL_CHECK_MIN, default 15; 0 = off).
const credentialIntervalMs = credentialCheckIntervalMs(process.env);
new CredentialMonitor(core, { intervalMs: credentialIntervalMs }).start();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentfactory-web] http://localhost:${info.port}  (db: ${dbPath}, auth: ${authMode})`);
  console.log(`[agentfactory-web] credential monitor ${credentialIntervalMs > 0 ? `on — every ${credentialIntervalMs / 60_000} min` : 'off'}`);
  if (notifyCfg) console.log(`[agentfactory-web] notifier on — ${notifyCfg.webhooks.length} webhook(s), events: ${[...notifyCfg.events].join(', ')}`);
});
