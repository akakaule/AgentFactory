import type { Activity } from './types.js';

/** A user name with the agent that acted for them through a delegate token (AF-202):
 *  "Alvin (via Claude Code)"; the bare name when there was no delegate. */
export function withDelegate(name: string, delegate: string | null | undefined): string {
  return delegate ? `${name} (via ${delegate})` : name;
}

/** Who an activity row names as its actor: the attributed human (with any delegate), else the
 *  machine axis. Shared by every activity render so they read the same. */
export function activityActor(a: Pick<Activity, 'actor' | 'actorName'> & { actorDelegate?: string | null }): string {
  return withDelegate(a.actorName ?? (a.actor === 'agent' ? 'agent' : 'you'), a.actorDelegate);
}
