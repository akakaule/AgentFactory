import { defineWorkspace } from 'vitest/config';

// Vitest 2.x uses a workspace file (not inline `test.projects`, which is v3+) to run
// each package with ITS OWN config — so the node:sqlite shim (core/mcp/web) and the
// jsdom environmentMatchGlobs + react plugin (web client tests) are applied per project.
export default defineWorkspace([
  'packages/core/vitest.config.ts',
  'packages/mcp/vitest.config.ts',
  'packages/web/vitest.config.ts',
  'packages/dispatcher/vitest.config.ts',
  'packages/reviewer/vitest.config.ts',
  'packages/watcher/vitest.config.ts',
]);
