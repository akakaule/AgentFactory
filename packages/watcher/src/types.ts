import type { Core } from '@agentfactory/core';

/** T or a promise of T — a sync core and the networked HttpCore both satisfy the slice (#45);
 *  the watcher awaits every call. */
type Awaitable<T> = T | Promise<T>;
type AwaitableSlice<T, K extends keyof T> = {
  [P in K]: T[P] extends (...a: infer A) => infer R ? (...a: A) => Awaitable<Awaited<R>> : T[P];
};

/** The slice of core the watcher drives — reads, heartbeat, delivery ops, and the workspace PAT. */
export type WatcherCore = AwaitableSlice<
  Core,
  | 'listWorkspaces' | 'listTasks' | 'getTask'
  | 'recordSupervisorHeartbeat' | 'getWorkspacePat'
  | 'beginDelivery' | 'recordDeliveryCheck' | 'completeDelivery' | 'failDelivery'
>;

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
  core: WatcherCore;
  fetchJson: FetchJson;
  /** Origin-URL resolver (core's resolveOriginUrl in production; a fake in tests). */
  resolveOrigin: (repoPath: string) => string | null;
  env: Record<string, string | undefined>;
  now: () => number;
  console: Pick<Console, 'log' | 'warn' | 'error'>;
}
