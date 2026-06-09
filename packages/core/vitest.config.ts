import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
  plugins: [
    {
      name: 'node-sqlite-external',
      enforce: 'pre',
      resolveId(id) {
        if (id === 'node:sqlite') {
          return '\0virtual:node-sqlite';
        }
      },
      load(id) {
        if (id === '\0virtual:node-sqlite') {
          // Re-export from node:sqlite using a CJS require so Vite doesn't bundle it
          return `
import { createRequire } from 'node:module';
const _require = createRequire(import.meta.url);
const _sqlite = _require('node:sqlite');
export const DatabaseSync = _sqlite.DatabaseSync;
export const StatementSync = _sqlite.StatementSync;
export const Session = _sqlite.Session;
export const constants = _sqlite.constants;
export const backup = _sqlite.backup;
export default _sqlite;
`;
        }
      },
    },
  ],
});
