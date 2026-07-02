import type { Core } from '@agentfactory/core';

/** A JSON HTTP response as the providers consume it (headers lower-cased). */
export interface FetchResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export type FetchJson = (url: string, init: { headers: Record<string, string> }) => Promise<FetchResponse>;

/**
 * Everything the watcher touches outside its own logic, injected for tests —
 * the dispatcher's DispatcherDeps pattern, minus all spawn/session machinery.
 */
export interface WatcherDeps {
  core: Core;
  fetchJson: FetchJson;
  /** Origin-URL resolver (core's resolveOriginUrl in production; a fake in tests). */
  resolveOrigin: (repoPath: string) => string | null;
  env: Record<string, string | undefined>;
  now: () => number;
  console: Pick<Console, 'log' | 'warn' | 'error'>;
}
