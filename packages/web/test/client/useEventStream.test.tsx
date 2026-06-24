import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useEventStream } from '../../client/src/useEventStream.js';

// ── Fake EventSource ──────────────────────────────────────────────────────────

type EventListener = () => void;

interface FakeES {
  listeners: Record<string, EventListener[]>;
  onerror: (() => void) | null;
  closeSpy: ReturnType<typeof vi.fn>;
  /** Fire a named event to all registered listeners */
  emit(event: string): void;
}

function makeFakeES(): FakeES {
  const es: FakeES = {
    listeners: {},
    onerror: null,
    closeSpy: vi.fn(),
    emit(event: string) {
      for (const fn of es.listeners[event] ?? []) fn();
    },
  };
  return es;
}

// We store the most-recently created fake so tests can drive it.
let lastES: FakeES;

beforeEach(() => {
  vi.useFakeTimers();

  // Replace the global EventSource with a spy factory
  globalThis.EventSource = vi.fn().mockImplementation(() => {
    lastES = makeFakeES();
    const proxy = {
      addEventListener(event: string, fn: EventListener) {
        if (!lastES.listeners[event]) lastES.listeners[event] = [];
        lastES.listeners[event]!.push(fn);
      },
      get onerror() { return lastES.onerror; },
      set onerror(fn) { lastES.onerror = fn; },
      close: lastES.closeSpy,
    };
    return proxy;
  }) as unknown as typeof EventSource;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Reset visibility so a test that backgrounds the tab doesn't leak into the next.
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
});

const setVisibility = (state: 'visible' | 'hidden') => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('useEventStream', () => {
  it('fires onBump when a "version" event is received', () => {
    const onBump = vi.fn();
    renderHook(() => useEventStream(onBump));

    act(() => { lastES.emit('version'); });

    expect(onBump).toHaveBeenCalledTimes(1);
  });

  it('starts polling on onerror and invokes onBump every 3 s', () => {
    const onBump = vi.fn();
    renderHook(() => useEventStream(onBump));

    // Trigger the error path
    act(() => { lastES.onerror?.(); });

    // Advance by exactly 3 s — one tick of the poll interval
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onBump).toHaveBeenCalledTimes(1);

    // Another 3 s → second tick
    act(() => { vi.advanceTimersByTime(3000); });
    expect(onBump).toHaveBeenCalledTimes(2);
  });

  it('stops polling when a "version" event arrives after an error', () => {
    const onBump = vi.fn();
    renderHook(() => useEventStream(onBump));

    // Start polling
    act(() => { lastES.onerror?.(); });

    // Version event should stop polling and call onBump once
    act(() => { lastES.emit('version'); });
    const callsAfterVersion = onBump.mock.calls.length;

    // Advance time — no further calls expected
    act(() => { vi.advanceTimersByTime(9000); });
    expect(onBump.mock.calls.length).toBe(callsAfterVersion);
  });

  it('stops polling when an "open" event arrives after an error', () => {
    const onBump = vi.fn();
    renderHook(() => useEventStream(onBump));

    act(() => { lastES.onerror?.(); });

    // "open" event should stop polling without calling onBump
    act(() => { lastES.emit('open'); });
    const callsAfterOpen = onBump.mock.calls.length;

    act(() => { vi.advanceTimersByTime(9000); });
    expect(onBump.mock.calls.length).toBe(callsAfterOpen);
  });

  it('calls es.close() on unmount', () => {
    const onBump = vi.fn();
    const { unmount } = renderHook(() => useEventStream(onBump));

    unmount();

    expect(lastES.closeSpy).toHaveBeenCalledTimes(1);
  });

  it('releases the SSE connection while the tab is hidden and reopens on return', () => {
    const onBump = vi.fn();
    renderHook(() => useEventStream(onBump));
    const ESMock = globalThis.EventSource as unknown as ReturnType<typeof vi.fn>;
    expect(ESMock).toHaveBeenCalledTimes(1); // foreground on mount → one connection

    // Backgrounding the tab must free the connection slot.
    const firstClose = lastES.closeSpy;
    act(() => setVisibility('hidden'));
    expect(firstClose).toHaveBeenCalledTimes(1);

    // Returning to the foreground reopens a fresh stream and refetches to catch up.
    act(() => setVisibility('visible'));
    expect(ESMock).toHaveBeenCalledTimes(2);
    expect(onBump).toHaveBeenCalled();
  });
});
