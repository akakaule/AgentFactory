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
  const worktree = `${repoPath}/.worktrees/${key}`;
  const setup = branchCreated
    ? [`git worktree add ${worktree} -b ${branch}`]
    : [`git worktree add ${worktree} ${branch}`]; // reuse the existing branch — updates the same PR
  return {
    version: PROTOCOL_VERSION,
    branch,
    worktree,
    setup,
    finish: [
      'Commit all work inside the worktree.',
      `git push -u origin ${branch}`,
      `git worktree remove ${worktree} && git worktree prune`,
      'Call submit_result with a branch link (label = the branch name) and best-effort metrics.',
    ],
  };
}
