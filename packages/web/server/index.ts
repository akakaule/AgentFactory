import { serve } from '@hono/node-server';
import { openCore } from '@agentfactory/core';
import { buildApp } from './app.js';
import { mountStatic } from './static.js';

const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
const port = Number(process.env['PORT'] ?? 8787);

const core = openCore(dbPath);
const app = buildApp(core);

// Mount static SPA serving AFTER the API/SSE routes so /api/* and /events take precedence.
mountStatic(app);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentfactory-web] http://localhost:${info.port}  (db: ${dbPath})`);
});
