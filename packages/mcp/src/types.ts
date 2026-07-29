import type { Core } from '@agentfactory/core';

export type { TaskDetail } from '@agentfactory/core';

type Awaitable<T> = T | Promise<T>;
type AwaitableSlice<T, K extends keyof T> = {
  [P in K]: T[P] extends (...a: infer A) => infer R ? (...a: A) => Awaitable<Awaited<R>> : T[P];
};

/**
 * The slice of core the MCP server drives, with every op Awaitable: the local sync core
 * (AGENTFACTORY_DB) and the networked HttpCore (AGENTFACTORY_BOARD_URL) both satisfy it, and
 * every handler awaits every call. Declaring the surface documents exactly which ops a worker
 * session can reach — and is what keeps the #45 HTTP cut honest.
 */
export type McpCore = AwaitableSlice<
  Core,
  | 'claimNextTask' | 'submitResult' | 'createTask'
  | 'getTask' | 'listTasks' | 'addComment' | 'updateStatus' | 'reportProgress'
  | 'addTaskMetrics' | 'resolveGitAuth' | 'getAttachment'
>;
