import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';

// Ensure RTL cleans up the DOM after each test (required when vitest globals are not enabled).
// We only need this in jsdom (browser-like) environments — guard with typeof document.
if (typeof document !== 'undefined') {
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  });
}

// Global no-op EventSource stub so components using useEventStream/useTasks don't crash.
// Per-test suites may override globalThis.EventSource before each test.
if (typeof globalThis.EventSource === 'undefined') {
  class NoOpEventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;
    onerror: (() => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onopen: (() => void) | null = null;
    addEventListener(_type: string, _listener: () => void) {}
    removeEventListener(_type: string, _listener: () => void) {}
    dispatchEvent(_event: Event): boolean { return true; }
    close() {}
    constructor(_url: string, _init?: EventSourceInit) {}
  }
  (globalThis as unknown as { EventSource: typeof NoOpEventSource }).EventSource = NoOpEventSource;
}
