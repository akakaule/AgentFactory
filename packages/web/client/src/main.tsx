import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import './board.css';
import { App } from './App.js';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the service worker only in production builds — a SW in dev caches modules and
// causes the stale-build confusion this project has hit before. The SW itself is network-first.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
