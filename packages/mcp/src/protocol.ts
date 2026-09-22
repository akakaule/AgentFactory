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

export const PROTOCOL_VERSION = 6;

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
      /** Pinned workers use constrained server-side Git operations. */
      managedGit?: boolean;
      /** What a FIRST claim branches from (latest default branch); ignored on a reclaim. */
      base?: { ref: string; fetch: boolean };
      /** Per-workspace verification command; when set it must pass before push (see git.ts/submitResult). */
      verifyCommand?: string | null;
      /** Set when origin is a GitHub remote ⇒ emit a finish step that opens/updates the PR. */
      github?: { defaultBranch: string | null };
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
        'Call submit_result with { summary, claimAt: the claimedAt value from this claim, spec, acceptanceCriteria }.',
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
        'Call submit_result with { summary, claimAt: the claimedAt value from this claim, plan }.',
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
    // Reuse the branch a prior claim named — normally it already exists (its PR is open), so
    // adding a worktree on it updates the same PR. But the branch name is persisted at claim
    // time, BEFORE the agent runs `git worktree add -b`; if that first claim died in between,
    // the ref was never created. Fall back to creating it so a reclaim recovers instead of
    // stranding on `fatal: invalid reference`. The reuse attempt comes first so a real reclaim
    // keeps its existing commits untouched (re-creating would discard the open PR's work).
    setup.push(`git worktree add ${wt} ${branch} || git worktree add ${wt} -b ${branch}`);
  }
  // Verify-before-handoff runs inside the worktree, so it must come BEFORE the worktree is removed.
  // Without a workspace command, discover the CI checks instead of omitting gates such as Prettier.
  const verify = input.verifyCommand && input.verifyCommand.trim().length > 0 ? input.verifyCommand.trim() : null;
  const verifyStep = verify
    ? `Run \`${verify}\` from the worktree root; it MUST pass before you push. Report its outcome via submit_result \`verification\`.`
    : 'Read the repository CI workflow and run its locally runnable checks from the worktree root, including lint, formatting and type checks when configured, plus the repo tests and build. All must pass before you push; report any CI-only checks you could not run in the result.';
  // When origin is GitHub, open (or reuse, on a reclaim) the PR right after the push and before
  // the worktree is removed. Idempotent and best-effort — a gh/auth failure must not block the
  // submit (the push itself is what the submit guardrail enforces).
  const github = input.github;
  const prStep = github
    ? [
        `Find an open pull request for this branch (best-effort — continue if it fails): ` +
          `\`gh pr list --head ${branch} --state open --json url --jq '.[0].url // empty'\`. ` +
          `Reuse that URL if present. If none is open (including when the previous PR was merged or closed), ` +
          `run \`gh pr create --head ${branch}${github.defaultBranch ? ` --base ${github.defaultBranch}` : ''} --fill\`. ` +
          `Pass the open PR URL as a 'pr' link in submit_result; never reuse a merged or closed PR URL for a repair.`,
      ]
    : [];
  return {
    version: PROTOCOL_VERSION,
    stage,
    branch,
    worktree,
    setup: [
      ...(input.managedGit ? ['Call task_git with { action: "prepare" } before touching code. Use task_git for Git writes; run code edits, read-only Git commands, tests and builds in the task worktree.'] : setup),
      'Install dependencies inside the task worktree before building or testing. For an npm repository with package-lock.json, run `npm ci --cache .npm-cache` from the worktree root (keep .npm-cache/ ignored). Do not inherit node_modules or workspace-package links from the parent checkout, and do not repair them with manual junctions. Verify local workspace packages resolve inside this worktree; for projects consuming compiled workspace exports, build before running tests.',
    ],
    finish: [
      input.managedGit ? 'Call task_git with { action: "commit", message: "<Conventional Commit message>" } to commit all work inside the assigned worktree.' : 'Commit all work inside the worktree.',
      verifyStep,
      input.managedGit ? 'Call task_git with { action: "push" } after verification passes.' : `git push -u origin ${branch}`,
      ...prStep,
      input.managedGit ? 'Return to the repository root, then call task_git with { action: "cleanup" } to remove the published task worktree.' : `git worktree remove ${wt} && git worktree prune`,
      `Call submit_result with claimAt (the claimedAt value from this claim), a branch link (label = the branch name)${github ? `, the PR link (kind 'pr')` : ''}${verify ? ', the `verification` outcome,' : ''} and best-effort metrics.`,
    ],
  };
}
