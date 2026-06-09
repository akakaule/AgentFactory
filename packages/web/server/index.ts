import { serve } from '@hono/node-server';
import { openCore } from '@agentfactory/core';
import { buildApp } from './app.js';

const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
const port = Number(process.env['PORT'] ?? 8787);

const core = openCore(dbPath);
const app = buildApp(core);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[agentfactory-web] http://localhost:${info.port}  (db: ${dbPath})`);
});
