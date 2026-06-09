import { defineConfig } from 'vitest/config';

// node:sqlite is registered as a builtin only under its prefixed name, so Vite's
// bare-name builtin check ("sqlite") misclassifies it and tries to bundle it. Neither
// ssr.external nor resolveId({external:true}) is honored by vite-node's SSR transform
// (it still strips the prefix and tries to load bare "sqlite"). The reliable fix is to
// resolve node:sqlite to a virtual module whose code re-exports the real builtin via a
// native CJS require — confined to the test config; production code imports node:sqlite
// directly.
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
