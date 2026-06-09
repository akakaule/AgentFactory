import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// node:sqlite is a prefix-only builtin that Vite misclassifies; re-export the real builtin
// via a virtual module. Required because server tests import @agentfactory/core (which loads
// node:sqlite). See packages/core/vitest.config.ts for the full rationale.
const nodeSqliteShim = {
  name: 'node-sqlite-virtual',
  enforce: 'pre' as const,
  resolveId(id: string) { return id === 'node:sqlite' ? '\0virtual:node-sqlite' : null; },
  load(id: string) {
    if (id === '\0virtual:node-sqlite') {
      return [
        "import { createRequire } from 'node:module';",
        'const _require = createRequire(import.meta.url);',
        "const _sqlite = _require('node:sqlite');",
        'export const DatabaseSync = _sqlite.DatabaseSync;',
        'export const StatementSync = _sqlite.StatementSync;',
        'export default _sqlite;',
      ].join('\n');
    }
    return null;
  },
};

export default defineConfig({
  plugins: [react(), nodeSqliteShim],
  test: {
    environment: 'node',
    environmentMatchGlobs: [['**/test/client/**', 'jsdom']],
    setupFiles: ['./test/setup.client.ts'],
  },
});
