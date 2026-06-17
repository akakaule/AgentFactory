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

export const PROTOCOL_VERSION = 5;

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
      /** What a FIRST claim branches from (latest default branch); ignored on a reclaim. */
      base?: { ref: string; fetch: boolean };
      /** Per-workspace verification command; when set it must pass before push (see git.ts/submitResult). */
      verifyCommand?: string | null;
    };

// Forward slashes only: Windows backslash paths lose their backslashes when the
// agent pastes them into a POSIX shell; git accepts / on every platform.
const fwd = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

// Defense-in-depth: the base ref is server-resolved (already validated in git.ts), but the
// same ref discipline costs nothing — no leading '-', no '..', conservative charset.
const SAFE_REF = /^(?!-)(?!.*\.\.)[\w./-]+$/;

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
  const setup: string[] = [];
  if (branchCreated) {
    // First claim: branch from the latest default branch when one was resolved (fetch first so
    // origin/<default> is current), else from current HEAD (legacy fallback — never block).
    const base = input.base && SAFE_REF.test(input.base.ref) ? input.base : undefined;
    if (base?.fetch) setup.push('git fetch origin');
    setup.push(base ? `git worktree add ${wt} -b ${branch} ${base.ref}` : `git worktree add ${wt} -b ${branch}`);
  } else {
    setup.push(`git worktree add ${wt} ${branch}`); // reuse the existing branch — updates the same PR
  }
  // Verify-before-handoff runs inside the worktree, so it must come BEFORE the worktree is removed.
  // When the workspace sets no command, fall back to the repo's own tests + build (today's behaviour).
  const verify = input.verifyCommand && input.verifyCommand.trim().length > 0 ? input.verifyCommand.trim() : null;
  const verifyStep = verify
    ? `Run \`${verify}\` from the worktree root; it MUST pass before you push. Report its outcome via submit_result \`verification\`.`
    : 'Run the repo tests and build from the worktree root; both must pass before you push.';
  return {
    version: PROTOCOL_VERSION,
    stage,
    branch,
    worktree,
    setup,
    finish: [
      'Commit all work inside the worktree.',
      verifyStep,
      `git push -u origin ${branch}`,
      `git worktree remove ${wt} && git worktree prune`,
      `Call submit_result with a branch link (label = the branch name)${verify ? ', the `verification` outcome,' : ''} and best-effort metrics.`,
    ],
  };
}
