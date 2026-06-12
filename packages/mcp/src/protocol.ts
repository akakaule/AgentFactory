/**
 * The worker protocol delivered as data in the claim payload — computed fresh by the
 * server on every claim, so it can never go stale the way a tool description does.
 * The agent follows these steps verbatim instead of re-deriving conventions from prose.
 */
export interface Protocol {
  version: number;
  branch: string;
  worktree: string;
  setup: string[];
  finish: string[];
}

export const PROTOCOL_VERSION = 2;

export interface ProtocolInput {
  repoPath: string;
  key: string;
  branch: string;
  /** true ⇒ branch named this claim (first claim / legacy) ⇒ create with `-b`. */
  branchCreated: boolean;
}

export function buildProtocol({ repoPath, key, branch, branchCreated }: ProtocolInput): Protocol {
  // Forward slashes only: Windows backslash paths lose their backslashes when the
  // agent pastes the command into a POSIX shell; git accepts / on every platform.
  const worktree = `${repoPath.replace(/\\/g, '/').replace(/\/+$/, '')}/.worktrees/${key}`;
  const wt = `"${worktree}"`; // quoted in commands so paths with spaces survive
  const setup = branchCreated
    ? [`git worktree add ${wt} -b ${branch}`]
    : [`git worktree add ${wt} ${branch}`]; // reuse the existing branch — updates the same PR
  return {
    version: PROTOCOL_VERSION,
    branch,
    worktree,
    setup,
    finish: [
      'Commit all work inside the worktree.',
      `git push -u origin ${branch}`,
      `git worktree remove ${wt} && git worktree prune`,
      'Call submit_result with a branch link (label = the branch name) and best-effort metrics.',
    ],
  };
}
