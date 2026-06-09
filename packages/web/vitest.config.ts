import { defineConfig } from 'vitest/config';

// node:sqlite is registered as a builtin only under its prefixed name, so Vite's
// bare-name builtin check ("sqlite") misclassifies it and tries to bundle it.
// Full rationale lives in packages/core/vitest.config.ts — the dependency here is
// TRANSITIVE: importing anything from '@agentfactory/core' transitively loads node:sqlite
// (the barrel re-exports openDb). The plugin below is a verbatim copy of the shim there.
export default defineConfig({
  test: { environment: 'node' },
  plugins: [
    {
      name: 'node-sqlite-virtual',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:sqlite') return '\0virtual:node-sqlite';
        return null;
      },
      load(id) {
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
    },
  ],
});
