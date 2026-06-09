import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/events': { target: 'http://localhost:8787', ws: false },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
