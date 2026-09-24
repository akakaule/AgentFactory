import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { environment: 'node' },
  plugins: [{
    name: 'node-sqlite-virtual', enforce: 'pre' as const,
    resolveId(id: string) { return id === 'node:sqlite' ? '\0virtual:node-sqlite' : null; },
    load(id: string) {
      if (id !== '\0virtual:node-sqlite') return null;
      return "import { createRequire } from 'node:module'; const r=createRequire(import.meta.url); const s=r('node:sqlite'); export const DatabaseSync=s.DatabaseSync; export const StatementSync=s.StatementSync; export default s;";
    },
  }],
});
