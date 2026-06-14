import { serve } from '@hono/node-server';
import { openCore } from '@agentfactory/core';
import { buildApp } from './app.js';
import { mountStatic } from './static.js';

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

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentfactory-web] http://localhost:${info.port}  (db: ${dbPath}, auth: ${authMode})`);
});
