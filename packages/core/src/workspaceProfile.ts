/**
 * Workspace repository profile (AF-151): the delivery facts a workspace can pin — the base branch
 * PRs target, the check names that must pass, and how CI gates a delivery. Every field is optional;
 * an unset field keeps today's behaviour, so the effective profile always says where each value
 * came from: `configured` on the workspace, `detected` from the repo, or the built-in `default`.
 */
import type { CiMode, Workspace } from './types.js';

export type ProfileSource = 'configured' | 'detected' | 'default';
export interface EffectiveWorkspaceProfile {
  /** `unresolved` = nothing configured and the default branch could not be detected. */
  baseBranch: { value: string; source: 'configured' | 'detected' } | { value: null; source: 'unresolved' };
  requiredChecks: { value: string[]; source: 'configured' | 'default' };
  ciMode: { value: CiMode; source: 'configured' | 'default' };
}

/** The default `ciMode`: today's watcher rule (any red check bounces the delivery). */
export const DEFAULT_CI_MODE: CiMode = 'legacy';

/** Resolve a workspace's effective profile. `detectedBaseBranch` is the repo's default branch as
 *  detected by the caller (bare name, e.g. `main`), or null when it could not be determined. */
export function effectiveWorkspaceProfile(
  ws: Pick<Workspace, 'baseBranch' | 'requiredChecks' | 'ciMode'>,
  detectedBaseBranch: string | null,
): EffectiveWorkspaceProfile {
  return {
    baseBranch: ws.baseBranch !== null ? { value: ws.baseBranch, source: 'configured' }
      : detectedBaseBranch !== null ? { value: detectedBaseBranch, source: 'detected' }
      : { value: null, source: 'unresolved' },
    requiredChecks: ws.requiredChecks !== null ? { value: ws.requiredChecks, source: 'configured' } : { value: [], source: 'default' },
    ciMode: ws.ciMode !== null ? { value: ws.ciMode, source: 'configured' } : { value: DEFAULT_CI_MODE, source: 'default' },
  };
}

/** Parse the stored required_checks JSON; anything unreadable reads as not configured. */
export function parseRequiredChecks(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string') ? (v as string[]) : null;
  } catch {
    return null;
  }
}
