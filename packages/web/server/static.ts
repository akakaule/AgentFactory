import { serveStatic } from '@hono/node-server/serve-static';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hono } from 'hono';

// Resolve the client dist directory relative to THIS compiled file's location.
// Compiled output lives at packages/web/server/dist/static.js
// Client bundle lives at   packages/web/client/dist/
// Relative from compiled file: ../../client/dist
//
// We use import.meta.url so the path is always correct regardless of process.cwd().
// @hono/node-server serveStatic accepts absolute paths even though the docs mention
// "relative to cwd" — the implementation uses path.join(root, filename) and
// fs.statSync, which honour absolute paths correctly.
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CLIENT_DIR = join(__dirname, '../../client/dist');

// Mounted ONLY in the production entry (server/index.ts), AFTER the API/SSE routes,
// so /api/* and /events take precedence and everything else is served from the SPA bundle.
export function mountStatic(app: Hono, clientDir: string = DEFAULT_CLIENT_DIR): void {
  // Serve any static asset that exists in the client/dist directory.
  app.use('/*', serveStatic({ root: clientDir }));
  // SPA fallback: any unmatched request returns index.html so client-side routing works.
  app.get('*', serveStatic({ path: join(clientDir, 'index.html') }));
}
