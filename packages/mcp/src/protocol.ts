/**
 * The worker protocol delivered as data in the claim payload — computed fresh by the
 * server on every claim, so it can never go stale the way a tool description does.
 * The agent follows these steps verbatim instead of re-deriving conventions from prose.
 *
 * One shape per stage: doc stages (description/plan) carry no git at all — their
 * deliverable travels through submit_result fields; only the implementation stage
 * gets a branch and worktree.
 */
export type Protocol =
  | { version: number; stage: 'description' | 'plan'; setup: string[]; finish: string[] }
  | { version: number; stage: 'implementation'; branch: string; worktree: string; setup: string[]; finish: string[] };

export const PROTOCOL_VERSION = 3;

export type ProtocolInput =
  | { stage: 'description'; repoPath: string; key: string }
  | { stage: 'plan'; repoPath: string; key: string }
  | {
      stage: 'implementation';
      repoPath: string;
      key: string;
      branch: string;
      /** true ⇒ branch named this claim (first claim / legacy) ⇒ create with `-b`. */
      branchCreated: boolean;
    };

// Forward slashes only: Windows backslash paths lose their backslashes when the
// agent pastes them into a POSIX shell; git accepts / on every platform.
const fwd = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

export function buildProtocol(input: ProtocolInput): Protocol {
  if (input.stage === 'description') {
    return {
      version: PROTOCOL_VERSION,
      stage: input.stage,
      setup: [],
      finish: [
        'Write the feature description: a rewritten spec (preserve any source-reference lines, e.g. an ADO work-item link, at the top) and objectively verifiable acceptance criteria.',
        'Do NOT touch the repository — no branch, no worktree, no code changes.',
        'Call submit_result with { summary, spec, acceptanceCriteria }.',
      ],
    };
  }
  if (input.stage === 'plan') {
    return {
      version: PROTOCOL_VERSION,
      stage: input.stage,
      setup: [],
      finish: [
        `Read the workspace repository at ${fwd(input.repoPath)} (read-only) to ground the plan in the real code.`,
        'Write a step-by-step implementation plan: the files to change, the approach, and a test plan.',
        'Do NOT create a branch or worktree, and make no commits.',
        'Call submit_result with { summary, plan }.',
      ],
    };
  }
  const { stage, repoPath, key, branch, branchCreated } = input;
  const worktree = `${fwd(repoPath)}/.worktrees/${key}`;
  const wt = `"${worktree}"`; // quoted in commands so paths with spaces survive
  const setup = branchCreated
    ? [`git worktree add ${wt} -b ${branch}`]
    : [`git worktree add ${wt} ${branch}`]; // reuse the existing branch — updates the same PR
  return {
    version: PROTOCOL_VERSION,
    stage,
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
