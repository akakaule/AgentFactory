import type { Workspace } from './types.js';

const WS_PALETTE = ['#60A5FA', '#A78BFA', '#4ADE80', '#F59E0B', '#22D3EE', '#F87171'];

export function wsColor(workspaces: Workspace[], slug: string): string {
  const i = workspaces.findIndex((w) => w.name === slug);
  return i === -1 ? 'var(--ink-2)' : WS_PALETTE[i % WS_PALETTE.length]!;
}
