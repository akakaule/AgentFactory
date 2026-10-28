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

export const PROTOCOL_VERSION = 9;

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
      /** v8: the task's acceptance criteria (core's parseAcceptanceCriteria) — the submit step asks
       *  for one claim per id. Omitted/empty ⇒ no claims asked for. */
      criteria?: Array<{ id: string; name: string | null }>;
      /** v9: Task Intelligence skipped the spec stage, so the task still has the placeholder
       *  criteria — the worker writes them and submits them as `acceptanceCriteria`. */
      defineCriteria?: boolean;
    };

/** Board text fields (spec, acceptance criteria, plan, summary) are rendered with the board's own
 *  wrapping; prose broken at a column width shows up there as a ragged narrow block. */
export const NO_HARD_WRAP =
  'Write prose as flowing text and do NOT hard-wrap it at a column width: a newline only ends a paragraph, a list item or a heading — the board wraps lines itself.';

/** The board numbers acceptance criteria AC1…ACn by list position and names each by its prefix. */
export const NUMBERED_CRITERIA =
  'Write the acceptance criteria as a numbered list, one verifiable criterion per item, each starting with a short name and a dash (`4. Race — two supervisors …`).';

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
        'Write the spec: rewrite the task intent into a spec precise enough to implement directly — implementation follows this stage with no separate plan (preserve any source-reference lines, e.g. an ADO work-item link, at the top) — and objectively verifiable acceptance criteria.',
        NUMBERED_CRITERIA,
        NO_HARD_WRAP,
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
        NO_HARD_WRAP,
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
  // v7: no PR step. The worker pushes before review; the watcher opens the PR after the
  // implementation review is approved (GitHub and Azure DevOps alike).
  // v8: one claim per acceptance criterion rides the submit; the review panel shows it per criterion.
  // v9: a skipped spec stage leaves placeholder criteria — the worker writes them, then claims them.
  const criteria = input.defineCriteria ? [] : input.criteria ?? [];
  const submitWith = [
    'claimAt (the claimedAt value from this claim)',
    'a branch link (label = the branch name)',
    ...(verify ? ['the `verification` outcome'] : []),
    'best-effort metrics',
    ...(input.defineCriteria
      ? [
        '`acceptanceCriteria`: the numbered criteria you wrote before coding',
        '`criteria`: one `{ id, claim }` per criterion you wrote (AC1…ACn in your list\'s order), a sentence on how the change meets it and which test proves it',
      ]
      : criteria.length > 0
        ? [`\`criteria\`: one \`{ id, claim }\` per acceptance criterion, a sentence on how the change meets it and which test proves it. Ids: ${criteria.map((c) => (c.name ? `${c.id} ${c.name}` : c.id)).join(', ')}`]
        : []),
  ];
  const defineCriteriaStep = input.defineCriteria
    ? [`Task Intelligence rated this task simple, so it skipped the spec stage and its acceptance criteria are still a placeholder. Before you write code, write 2–5 acceptance criteria that say what done means for this task; the reviewer checks your work against them. ${NUMBERED_CRITERIA}`]
    : [];
  return {
    version: PROTOCOL_VERSION,
    stage,
    branch,
    worktree,
    setup: [
      ...(input.managedGit ? [
        'Call task_git with { action: "prepare" } before touching code. Use task_git status, diff, and log for Git inspection; shell Git permissions are not required. Run code edits, tests and builds in the assigned worktree.',
        'On every reclaim inspect status and diff first. Preserve and understand existing edits before committing them; never blindly commit a previous worker\'s changes. Once clean, call task_git merge_default to fetch and merge origin\'s default branch into this task branch.',
        'If merge_default or status reports a merge in progress, inspect the conflicts, resolve files using ordinary edits, inspect diff, then call continue_merge with a Conventional Commit message. Resume the existing merge after an interruption. Do not push or clean up until the merge is finished. Re-run verification after reconciliation.',
        'A failed or missing review is not new code feedback. Inspect the current implementation against the task acceptance criteria and curated feedback, complete any remaining work, verify it, and submit for a fresh review. Do not stop solely because the previous review execution failed.',
      ] : setup),
      'Install dependencies inside the task worktree before building or testing. For an npm repository with package-lock.json, run `npm ci --cache .npm-cache` from the worktree root (keep .npm-cache/ ignored). Do not inherit node_modules or workspace-package links from the parent checkout, and do not repair them with manual junctions. Verify local workspace packages resolve inside this worktree; for projects consuming compiled workspace exports, build before running tests.',
      ...defineCriteriaStep,
    ],
    finish: [
      input.managedGit ? 'Inspect task_git status and diff, then call task_git with { action: "commit", message: "<Conventional Commit message>" } to commit the reviewed work inside the assigned worktree.' : 'Commit all work inside the worktree.',
      verifyStep,
      input.managedGit ? 'Call task_git with { action: "push" } after verification passes.' : `git push -u origin ${branch}`,
      input.managedGit ? 'Return to the repository root, then call task_git with { action: "cleanup" } to remove the published task worktree.' : `git worktree remove ${wt} && git worktree prune`,
      `Call submit_result with ${submitWith.slice(0, -1).join(', ')} and ${submitWith.at(-1)!}. Do not open a pull request: the board opens it after the implementation review is approved.`,
    ],
  };
}
