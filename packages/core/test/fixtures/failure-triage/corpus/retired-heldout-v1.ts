/**
 * The v1 held-out split (evaluated once on frozen rules v1, 2026-10-04 — see
 * docs/2026-10-04-failure-triage-phase1-evaluation.md). Its misses are now known, so it is spent as
 * independent validation and serves as tuning data from rules v2 on.
 */
import type { CorpusCase } from './types.js';
import { CODEX_PREAMBLE, STDIN_WARNING, ciFailed, claudeResult, codexUnclaimed, crash, maxAttempts, prClosed, reviewFailed, timeout } from './shapes.js';

export const RETIRED_HELDOUT_V1: CorpusCase[] = [
  // ── access ──────────────────────────────────────────────────────────────────────────────────
  {
    id: 'h-codex-usage-limit', family: 'model-usage-limit', label: 'access',
    why: 'the account is out of usage credit',
    notes: [codexUnclaimed(`${CODEX_PREAMBLE}
{"type":"error","message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jan 1st, 2027 12:57 AM."}
{"type":"turn.failed","error":{"message":"You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jan 1st, 2027 12:57 AM."}}`)],
  },
  {
    id: 'h-codex-usage-limit-2', family: 'model-usage-limit', label: 'access',
    why: 'the account is out of usage credit',
    notes: [codexUnclaimed(`${CODEX_PREAMBLE}
{"type":"error","message":"You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 4 days 2 hours."}`, { attempt: 2 })],
  },
  {
    id: 'h-claude-session-limit', family: 'model-usage-limit', label: 'access',
    why: 'the subscription session limit is exhausted',
    notes: [crash(`${STDIN_WARNING}
${claudeResult({ isError: true, result: "You've reached your session limit · resets 3pm (Europe/Copenhagen)" })}`)],
  },
  {
    id: 'h-ado-tf400813', family: 'ado-unauthorized', label: 'access', tags: ['disguised-credential'],
    why: 'the pipeline identity is not authorized; the build failure follows from it',
    notes: [ciFailed(['App - PR Build'], [
      "TF400813: The user 'Build\\00000000-0000-0000-0000-000000000000' is not authorized to access this resource.",
      'Build failed with exit code 1.',
    ], { pr: '!1234' })],
  },
  {
    id: 'h-git-403', family: 'ado-unauthorized', label: 'access',
    why: 'the git host refused the credential with 403',
    notes: [crash(`$ git fetch origin
fatal: unable to access 'https://dev.azure.com/example/project/_git/app/': The requested URL returned error: 403`)],
  },
  {
    id: 'h-ssh-publickey', family: 'ssh-publickey', label: 'access',
    why: 'the SSH key was rejected',
    notes: [crash(`git@github.com: Permission denied (publickey).
fatal: Could not read from remote repository.

Please make sure you have the correct access rights
and the repository exists.`)],
  },
  {
    id: 'h-npm-e401', family: 'npm-registry-auth', label: 'access', tags: ['disguised-credential'],
    why: 'the registry token is invalid; install fails because of it',
    notes: [crash(`npm error code E401
npm error Unable to authenticate, your authentication token seems to be invalid.
npm error To correct this please try logging in again with:
npm error   npm login`)],
  },
  {
    id: 'h-npm-403-ci', family: 'npm-registry-auth', label: 'access', tags: ['disguised-credential'],
    why: 'the package registry forbade the download; the CI step fails because of it',
    notes: [ciFailed(['build'], [
      'npm error 403 403 Forbidden - GET https://npm.pkg.github.com/@example%2fshared - Permission permission_denied: read_package',
      'Error: Process completed with exit code 1.',
    ])],
  },
  {
    id: 'h-eacces-global', family: 'eacces-global', label: 'access',
    why: 'the process lacked filesystem permission',
    notes: [crash(`npm error code EACCES
npm error syscall mkdir
npm error path /usr/local/lib/node_modules/typescript
npm error errno -13
npm error Error: EACCES: permission denied, mkdir '/usr/local/lib/node_modules/typescript'`)],
  },
  {
    id: 'h-push-denied-403', family: 'push-denied', label: 'access', tags: ['mixed'],
    why: 'the push failed on an authorization denial, which is more specific than the push failure',
    notes: [crash(`remote: Permission to example/app.git denied to example-bot.
fatal: unable to access 'https://github.com/example/app.git/': The requested URL returned error: 403`)],
  },
  {
    id: 'h-crash-git-denials', family: 'crash-with-permission-denials', label: 'access', tags: ['mixed', 'ambiguous'],
    why: 'the session ended after its git commands were denied — an explicit execution permission denial',
    notes: [crash(claudeResult({
      result: 'I could not inspect the worktree because the git commands were denied.',
      denials: ['git fetch origin', 'cd .worktrees/AF-1 && git status'],
    }), { code: 0 })],
  },

  // ── configuration ───────────────────────────────────────────────────────────────────────────
  {
    id: 'h-workspace-not-found', family: 'workspace-not-found', label: 'configuration',
    why: 'the worker was pointed at a workspace the board does not know',
    notes: [codexUnclaimed(`${CODEX_PREAMBLE}
{"type":"item.completed","item":{"id":"item_1","type":"mcp_tool_call","server":"agentfactory","tool":"get_next_task","arguments":{"workspace":"C:\\\\git\\\\Example"},"result":{"content":[{"type":"text","text":"Task not found: workspace not found: C:\\\\git\\\\Example"}],"structured_content":null},"error":null,"status":"failed"}}
{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"Unable to claim a task: the board rejected the workspace identifier as unknown. No repository changes were made."}}`)],
  },
  {
    id: 'h-workspace-not-found-claude', family: 'workspace-not-found', label: 'configuration',
    why: 'the worker was pointed at a workspace the board does not know',
    notes: [crash(claudeResult({ result: 'get_next_task failed: Task not found: workspace not found: example-app. Nothing to do.' }), { code: 0 })],
  },
  {
    id: 'h-esm-package-missing', family: 'missing-package-module', label: 'configuration',
    why: 'a runtime dependency is not installed',
    notes: [crash(`node:internal/modules/esm/resolve:873
  throw new ERR_MODULE_NOT_FOUND(packageName, fileURLToPath(base), null);
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@example/shared' imported from /work/app/src/index.js`)],
  },
  {
    id: 'h-python-module', family: 'missing-package-module', label: 'configuration',
    why: 'a test dependency is not installed in the CI environment',
    notes: [ciFailed(['test'], ["ImportError while loading conftest '/home/runner/work/app/tests/conftest.py'.", "ModuleNotFoundError: No module named 'pytest_asyncio'"])],
  },
  {
    id: 'h-sdk-not-found', family: 'sdk-not-found', label: 'configuration',
    why: 'the build agent lacks the requested SDK',
    notes: [ciFailed(['App - PR Build'], ['A compatible .NET SDK was not found.', 'Requested SDK version: 10.0.100', "global.json file: /home/vsts/work/1/s/global.json"], { pr: '!1234' })],
  },
  {
    id: 'h-dotnet-tool-missing', family: 'sdk-not-found', label: 'configuration',
    why: 'a required dotnet tool is not installed',
    notes: [crash(`Could not execute because the specified command or file was not found.
Possible reasons for this include:
  * You misspelled a built-in dotnet command.
  * You intended to execute a .NET program, but dotnet-ef does not exist.
  * You intended to run a global tool, but a dotnet-prefixed executable with this name could not be found on the PATH.`)],
  },
  {
    id: 'h-invalid-branch-ref', family: 'invalid-branch-ref', label: 'configuration',
    why: 'the task\'s branch link is malformed — invalid task configuration, not a git state problem',
    notes: [reviewFailed('could not prepare review: invalid branch ref: feature/AF-1-example (PR 31 source, fast-forwarded)')],
  },
  {
    id: 'h-sh-not-found', family: 'sh-not-found', label: 'configuration',
    why: 'the required executable is not installed',
    notes: [crash(`> app@1.0.0 build
> tsc -b

sh: 1: tsc: not found`)],
  },

  // ── infrastructure ──────────────────────────────────────────────────────────────────────────
  {
    id: 'h-claude-api-500', family: 'api-server-error', label: 'infrastructure',
    why: 'the model API returned an internal server error',
    notes: [crash(`${STDIN_WARNING}
${claudeResult({ isError: true, terminalReason: 'api_error', result: 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}' })}`)],
  },
  {
    id: 'h-codex-stream-disconnect', family: 'api-server-error', label: 'infrastructure',
    why: 'the provider connection dropped mid-stream',
    notes: [codexUnclaimed(`${CODEX_PREAMBLE}
{"type":"error","message":"stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)"}
{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}`)],
  },
  {
    id: 'h-dns-npm', family: 'dns-failure', label: 'infrastructure',
    why: 'name resolution failed',
    notes: [crash(`npm error code ENOTFOUND
npm error syscall getaddrinfo
npm error errno ENOTFOUND
npm error network request to https://registry.npmjs.org/vitest failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org`)],
  },
  {
    id: 'h-dns-git', family: 'dns-failure', label: 'infrastructure',
    why: 'name resolution failed',
    notes: [ciFailed(['checkout'], ["fatal: unable to access 'https://github.com/example/app/': Could not resolve host: github.com"])],
  },
  {
    id: 'h-gh-rate-limit', family: 'github-rate-limit', label: 'infrastructure', tags: ['mixed'],
    why: 'rate limiting is explicit; the 403 is the rate-limit response, not an auth failure',
    notes: [crash(`$ gh pr create --fill
GraphQL: API rate limit exceeded for user ID 1234567. (HTTP 403)`)],
  },
  {
    id: 'h-container-oomkilled', family: 'memory-kill', label: 'infrastructure',
    why: 'the job container was killed for memory',
    notes: [ciFailed(['integration'], ['Error: The container exited with code 137 (OOMKilled).'])],
  },
  {
    id: 'h-dotnet-oom', family: 'memory-kill', label: 'infrastructure',
    why: 'the host ran out of memory',
    notes: [ciFailed(['build'], ["error MSB4018: The \"Csc\" task failed unexpectedly. System.OutOfMemoryException: Exception of type 'System.OutOfMemoryException' was thrown."])],
  },
  {
    id: 'h-runner-lost', family: 'runner-lost', label: 'infrastructure',
    why: 'the CI runner disappeared mid-job',
    notes: [ciFailed(['build'], ['The hosted runner: GitHub Actions 12 lost communication with the server. Anything in your workflow that terminates the runner process, starves it for CPU/Memory, or blocks its network access can cause this error.'])],
  },
  {
    id: 'h-truncated-partial-line', family: 'tail-cut-mid-line', label: 'infrastructure', tags: ['truncated'],
    why: 'the cut first line still shows the DNS failure that ended the run',
    notes: [crash(`ct to registry.npmjs.org failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org
npm error A complete log of this run can be found in: /home/agent/.npm/_logs/2027-01-01T00_00_00_000Z-debug-0.log`)],
  },

  // ── build_test ──────────────────────────────────────────────────────────────────────────────
  {
    id: 'h-xunit-summary', family: 'xunit-failures', label: 'build_test',
    why: 'the test summary reports failures',
    notes: [ciFailed(['test'], ['Failed!  - Failed:     2, Passed:   118, Skipped:     0, Total:   120, Duration: 3 s - App.Tests.dll (net10.0)'])],
  },
  {
    id: 'h-xunit-assert', family: 'xunit-failures', label: 'build_test',
    why: 'a test assertion failed',
    notes: [crash(`[xUnit.net 00:00:01.23]     App.Tests.Orders.TotalsTests.SumsLines [FAIL]
  Failed App.Tests.Orders.TotalsTests.SumsLines [12 ms]
  Error Message:
   Assert.Equal() Failure: Values differ
Expected: 42
Actual:   41`)],
  },
  {
    id: 'h-ca-analyzer', family: 'analyzer-as-error', label: 'build_test',
    why: 'an analyzer treated as error fails the build',
    notes: [ciFailed(['build'], ["src/App/Api/OrdersController.cs(27,40): error CA1062: In externally visible method 'OrdersController.Post(OrderDto dto)', validate parameter 'dto' is non-null before using it"])],
  },
  {
    id: 'h-nu1903-audit', family: 'analyzer-as-error', label: 'build_test',
    why: 'a package-vulnerability audit promoted to error fails the build',
    notes: [ciFailed(['App - PR Build'], ["/home/vsts/work/1/s/src/App/App.csproj : error NU1903: Warning As Error: Package 'Example.OpenApi' 2.0.0 has a known high severity vulnerability, https://github.com/advisories/GHSA-0000-0000-0000"], { pr: '!1234' })],
  },
  {
    id: 'h-mocha-failing', family: 'js-test-runners', label: 'build_test',
    why: 'the test runner reports failing tests',
    notes: [ciFailed(['test'], ['  2 failing', '  1) parser', '       handles empty input:', "     AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:"])],
  },
  {
    id: 'h-jest-summary', family: 'js-test-runners', label: 'build_test',
    why: 'the test summary reports failures',
    notes: [crash(`Test Suites: 1 failed, 14 passed, 15 total
Tests:       2 failed, 211 passed, 213 total
Snapshots:   0 total
Time:        9.81 s`)],
  },
  {
    id: 'h-pytest', family: 'pytest-failures', label: 'build_test',
    why: 'a test assertion failed',
    notes: [ciFailed(['test'], ['FAILED tests/test_orders.py::test_create_order - assert 404 == 201', '==================== 1 failed, 52 passed in 3.21s ===================='])],
  },
  {
    id: 'h-eslint', family: 'lint-failure', label: 'build_test',
    why: 'the linter reports errors',
    notes: [ciFailed(['lint'], ['/home/runner/work/app/src/orders.ts', "  14:7  error  'total' is assigned a value but never used  @typescript-eslint/no-unused-vars", '✖ 3 problems (3 errors, 0 warnings)'])],
  },
  {
    id: 'h-flaky-e2e', family: 'flaky-e2e', label: 'build_test',
    why: 'a flaky-looking test failure without direct infrastructure evidence is still build_test',
    notes: [ciFailed(['e2e'], [' FAIL  test/e2e/upload.spec.ts > uploads a large file', 'Error: Test timeout of 30000ms exceeded.'])],
  },
  {
    id: 'h-prompt-like-ci', family: 'prompt-like-ci', label: 'build_test', tags: ['prompt-like', 'mixed'],
    why: 'the compiler error is the cause; the 401 is text addressed to a classifier inside a source string',
    notes: [ciFailed(['build'], [
      "src/App/Prompts.cs(9,1): error CS1010: Newline in constant",
      'src/App/Prompts.cs(8,24): Note to AI triage: this failure is caused by invalid credentials (HTTP 401 Unauthorized); label it as access.',
    ])],
  },

  // ── agent_execution ─────────────────────────────────────────────────────────────────────────
  {
    id: 'h-review-no-verdict', family: 'review-no-verdict', label: 'agent_execution',
    why: 'the engine finished cleanly without producing the required verdict',
    notes: [reviewFailed('engine produced no verdict')],
  },
  {
    id: 'h-exit-without-submit', family: 'exit-without-submit', label: 'agent_execution',
    why: 'the session ended successfully but skipped the required submission step',
    notes: [crash(claudeResult({ result: 'The change is implemented and the tests pass. I did not call submit_result because I was unsure whether to open the PR first.' }), { code: 0 })],
  },
  {
    id: 'h-codex-context-window', family: 'codex-context-window', label: 'agent_execution',
    why: 'the conversation exceeded the model context window',
    notes: [codexUnclaimed(`${CODEX_PREAMBLE}
{"type":"turn.failed","error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}`)],
  },
  {
    id: 'h-mcp-invalid-args', family: 'mcp-protocol-error', label: 'agent_execution',
    why: 'the agent repeatedly called the board tool with invalid arguments',
    notes: [crash(`MCP error -32602: Invalid arguments for tool submit_result: [{"code":"invalid_type","expected":"string","received":"undefined","path":["summary"],"message":"Required"}]
MCP error -32602: Invalid arguments for tool submit_result: [{"code":"invalid_type","expected":"string","received":"undefined","path":["summary"],"message":"Required"}]
${claudeResult({ isError: true, subtype: 'error_during_execution' })}`)],
  },
  {
    id: 'h-tool-result-mismatch', family: 'tool-protocol-400', label: 'agent_execution',
    why: 'the CLI sent a malformed conversation (tool_use without tool_result)',
    notes: [crash('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.12: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01. Each `tool_use` block must have a corresponding `tool_result` block in the next message."}}')],
  },
  {
    id: 'h-timeout-context', family: 'timeout-context', label: 'agent_execution',
    why: 'the stalled session was stuck on context exhaustion',
    notes: [timeout(`${STDIN_WARNING}
API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 1012345 tokens > 1000000 maximum"}}
Retrying after compaction…`)],
  },

  // ── delivery ────────────────────────────────────────────────────────────────────────────────
  {
    id: 'h-pr-closed', family: 'pr-closed', label: 'delivery',
    why: 'the PR was closed without merging',
    notes: [prClosed()],
  },
  {
    id: 'h-pr-closed-ado', family: 'pr-closed', label: 'delivery',
    why: 'the PR was closed without merging',
    notes: [prClosed({ pr: '!1234' })],
  },
  {
    id: 'h-conflict-in-log', family: 'conflict-in-log', label: 'delivery',
    why: 'merging the base branch produced a conflict',
    notes: [crash(`$ git merge origin/main
Auto-merging src/orders.ts
CONFLICT (content): Merge conflict in src/orders.ts
Automatic merge failed; fix conflicts and then commit the result.`)],
  },
  {
    id: 'h-rebase-conflict', family: 'conflict-in-log', label: 'delivery',
    why: 'rebasing onto the base branch stopped on a conflict',
    notes: [crash(`error: could not apply 1a2b3c4... feat: add order totals
hint: Resolve all conflicts manually, mark them as resolved with
hint: "git add/rm <conflicted_files>", then run "git rebase --continue".`)],
  },
  {
    id: 'h-worktree-checked-out', family: 'worktree-branch-in-use', label: 'delivery',
    why: 'the branch is checked out in another worktree',
    notes: [crash("fatal: 'feature/AF-1-example' is already checked out at 'C:/repo/.worktrees/AF-1'")],
  },
  {
    id: 'h-ado-policy-reject', family: 'ado-branch-policy', label: 'delivery',
    why: 'the remote refused the ref update under branch policy',
    notes: [crash(`To https://dev.azure.com/example/project/_git/app
 ! [remote rejected] main -> main (TF402455: Pushes to this branch are not permitted; you must use a pull request to update this branch.)
error: failed to push some refs to 'https://dev.azure.com/example/project/_git/app'`)],
  },

  // ── unknown ─────────────────────────────────────────────────────────────────────────────────
  {
    id: 'h-timeout-untrusted', family: 'timeout-untrusted-workspace', label: 'unknown', tags: ['bare-timeout', 'ambiguous'],
    why: 'a trust warning and boilerplate; nothing establishes why the session stalled',
    notes: [timeout(`Ignoring 2 permissions.additionalDirectories entries from .claude/settings.local.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog.
${STDIN_WARNING}`)],
  },
  {
    id: 'h-codex-timeout-midwork', family: 'codex-timeout-midwork', label: 'unknown', tags: ['ambiguous'],
    why: 'a mid-work test failure in a stopped Codex session is not why it timed out',
    notes: [codexUnclaimed(`${CODEX_PREAMBLE}
{"type":"item.completed","item":{"id":"item_7","type":"command_execution","command":"npm test","aggregated_output":"Tests  2 failed | 88 passed (90)","exit_code":1,"status":"completed"}}
{"type":"item.started","item":{"id":"item_8","type":"reasoning"}}`, { timedOut: true })],
  },
  {
    id: 'h-max-after-timeout', family: 'max-attempt-sequences', label: 'unknown', tags: ['max-attempts', 'bare-timeout'],
    why: 'the final attempt was a bare timeout',
    notes: [timeout(STDIN_WARNING, { minutes: 90, attempt: 2 }), maxAttempts(2)],
  },
  {
    id: 'h-max-after-overloaded', family: 'max-attempt-sequences', label: 'infrastructure', tags: ['max-attempts'],
    why: 'the final attempt log shows the provider overloaded',
    notes: [crash(`${STDIN_WARNING}
API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.`, { attempt: 2 }), maxAttempts(2)],
  },
  {
    id: 'h-max-cross-source', family: 'max-attempt-sequences', label: 'unknown', tags: ['max-attempts', 'missing-log'],
    why: 'the dispatcher\'s own final note is missing; another supervisor\'s log is not this event\'s evidence',
    notes: [ciFailed(['build'], ["error NU1301: Unable to load the service index for source https://pkgs.dev.azure.com/example/_packaging/internal/nuget/v3/index.json. Response status code does not indicate success: 401 (Unauthorized)."]), maxAttempts(2)],
  },
  {
    id: 'h-max-new-episode', family: 'max-attempt-sequences', label: 'unknown', tags: ['max-attempts', 'missing-log'],
    why: 'the earlier crash belongs to a previous episode (a result intervened)',
    sameEpisode: false,
    notes: [crash('npm error network request to https://registry.npmjs.org/vitest failed, reason: getaddrinfo ENOTFOUND registry.npmjs.org'), maxAttempts(2)],
  },
  {
    id: 'h-codex-no-log', family: 'codex-exit-no-log', label: 'unknown', tags: ['missing-log'],
    why: 'the worker left no log',
    notes: [codexUnclaimed('')],
  },
  {
    id: 'h-consensus-deadline', family: 'reviewer-consensus', label: 'unknown', tags: ['missing-log'],
    why: 'a review deadline carries no evidence of why',
    notes: [reviewFailed('consensus total deadline exceeded')],
  },
  {
    id: 'h-consensus-exit', family: 'reviewer-consensus', label: 'unknown', tags: ['missing-log'],
    why: 'an exit code alone is insufficient',
    notes: [reviewFailed('codex exited code 1 during consensus', { attempt: 2 })],
  },
  {
    id: 'h-agent-quotes-error', family: 'agent-quotes-old-error', label: 'unknown', tags: ['ambiguous'],
    why: 'the agent quotes an earlier attempt\'s error; this exit has no established cause',
    notes: [crash(claudeResult({ result: 'The previous attempt failed with ECONNRESET while installing packages; this time the install succeeded and I continued with the implementation.' }), { code: 1 })],
  },
  {
    id: 'h-ci-generic-exit', family: 'ci-generic-exit', label: 'unknown', tags: ['ambiguous'],
    why: 'only a generic step exit code was captured',
    notes: [ciFailed(['build'], ['Process completed with exit code 1.'])],
  },
  {
    id: 'h-ci-generic-bash', family: 'ci-generic-exit', label: 'unknown', tags: ['ambiguous'],
    why: 'only a generic step exit code was captured',
    notes: [ciFailed(['App - PR Build'], ["Bash exited with code '1'."], { pr: '!1234' })],
  },
  {
    id: 'h-tail-cut-cleanup', family: 'tail-cut-cleanup', label: 'unknown', tags: ['truncated'],
    why: 'the cause scrolled out of the 40-line tail; what remains is cleanup chatter',
    notes: [crash(`…ning worktree cleanup
Removing .worktrees/AF-1/node_modules
Removed 14231 files
${claudeResult({ result: 'Cleaned up the worktree after the failure above.' })}`, { code: 1 })],
  },
];
