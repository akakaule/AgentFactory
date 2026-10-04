import { describe, it, expect } from 'vitest';
import { classifyByRules, FAILURE_TRIAGE_RULE_IDS, FAILURE_TRIAGE_RULES_VERSION } from '../src/failureTriageRules.js';
import { failureEvidenceText, normalizeFailureText } from '../src/failureTriageEvidence.js';
import { buildFailureComment } from '../src/failure.js';

/** A dispatcher crash note, shaped exactly like releaseAndRetry writes it. */
const dispatcherCrash = (tail: string, reason: 'crashed' | 'timeout' = 'crashed') =>
  buildFailureComment({
    reason, source: 'dispatcher', attempt: 1, maxAttempts: 3,
    detail: reason === 'timeout'
      ? 'session `worker-1` timed out after 60m with the task still in progress'
      : 'session `worker-1` exited with code 1 with the task still in progress',
    body: `Releasing the claim for retry.\n\nLog tail:\n\`\`\`\n${tail}\n\`\`\``,
  });

/** A watcher CI bounce, shaped like ciFailureBody with captured build errors. */
const watcherCi = (errors: string[]) =>
  buildFailureComment({
    reason: 'ci_failed', source: 'watcher', attempt: 1, maxAttempts: 3, detail: 'PR 42 checks failed: build',
    body: `PR: https://github.com/o/r/pull/42 (open, head feature/AF-1-x)\nFailing checks:\n- build — https://github.com/o/r/actions/runs/1\n\nBuild errors:\n\`\`\`text\n${errors.join('\n')}\n\`\`\`\n\nThe branch and PR still exist. Fix the failures and push to the SAME branch — do not open a new PR.`,
  });

const classify = (body: string, reason: string, detail: string | null) => classifyByRules(reason, detail, failureEvidenceText(body, detail));
const CRASH_DETAIL = 'session `worker-1` exited with code 1 with the task still in progress';
const crash = (tail: string, detail = CRASH_DETAIL) => classify(dispatcherCrash(tail), 'crashed', detail);
const CLEAN_EXIT = 'session `worker-1` exited with code 0 with the task still in progress';
const ci = (...errors: string[]) => classify(watcherCi(errors), 'ci_failed', 'PR 42 checks failed: build');

/** rule id → [positive evidence lines, negative evidence lines that must NOT fire that rule], read as a crash note with `detail` (default: exit code 1) */
const FIXTURES: Record<string, { pos: string[]; neg: string[]; detail?: string }> = {
  'access/http-401-403': {
    pos: ['error NU1301: Unable to load the service index for source https://pkgs.dev.azure.com/x/_packaging/feed/nuget/v3/index.json. Response status code does not indicate success: 401 (Unauthorized).',
      'remote: HTTP 403 Forbidden'],
    neg: ['✓ returns 401 for anonymous requests (12 ms)', 'expected status 403'],
  },
  'access/auth-failed': {
    pos: ['fatal: Authentication failed', 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}', 'Error: token has expired'],
    neg: ['it("handles authentication", ...)', 'refreshing expired cache'],
  },
  'access/git-credentials': {
    pos: ["fatal: could not read Username for 'https://github.com': terminal prompts disabled", 'git@github.com: Permission denied (publickey).'],
    neg: ['git push origin feature/AF-1-x'],
  },
  'access/eacces': {
    pos: ["Error: EACCES: permission denied, open '/usr/lib/node_modules/x'"],
    neg: ['handles eacces-like strings in lowercase'],
  },
  'access/quota': {
    pos: ['Claude AI usage limit reached|1760000000', 'Error code: 429 - insufficient_quota', 'Your credit balance is too low to access the API',
      '{"type":"error","message":"You\'ve hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Jan 1st, 2027 12:57 AM."}',
      '{"type":"result","is_error":true,"result":"You\'ve reached your session limit · resets 3pm (Europe/Copenhagen)"}'],
    neg: ['quota tests passed', 'Raised the per-tenant limit you have configured', 'you hit the limit switch in the UI test'],
  },
  'access/host-denied': {
    pos: ["fatal: unable to access 'https://dev.azure.com/example/project/_git/app/': The requested URL returned error: 403",
      'npm error code E401', "TF400813: The user 'Build\\00000000' is not authorized to access this resource.",
      'remote: Permission to example/app.git denied to example-bot.'],
    neg: ["fatal: unable to access 'https://github.com/example/app/': The requested URL returned error: 500", 'npm error code E404', 'expect(res.status).toBe(403)'],
  },
  'configuration/command-not-found': {
    pos: ['bash: dotnet: command not found', "'pnpm' is not recognized as an internal or external command,", 'sh: 1: tsc: not found',
      'Could not execute because the specified command or file was not found.'],
    neg: ['Running command: npm test', 'GET /api/orders/9 404 Not Found', 'sh: 1: echo done', 'warning: file not found: README.md'],
  },
  'configuration/spawn-enoent': {
    pos: ['Error: spawn codex ENOENT'],
    neg: ["ENOENT: no such file or directory, open 'src/missing.ts'"],
  },
  'configuration/missing-module': {
    pos: ["Error: Cannot find module '@agentfactory/core'", 'ModuleNotFoundError: No module named requests'],
    neg: ["src/a.ts(3,20): error TS2307: Cannot find module './b' or its corresponding type declarations."],
  },
  'configuration/unknown-workspace': {
    pos: ['{"type":"text","text":"Task not found: workspace not found: C:\\\\git\\\\Example"}', 'get_next_task failed: Task not found: workspace not found: example-app.'],
    neg: ['created workspace example-app', 'Task not found: AF-12'],
  },
  'configuration/invalid-branch-ref': {
    pos: ['could not prepare review: invalid branch ref: feature/AF-1-example (PR 31 source, fast-forwarded)'],
    neg: ['could not prepare review: git diff failed', 'rejects an invalid branch ref in the link label'],
  },
  'configuration/runtime-version': {
    pos: ['npm WARN EBADENGINE Unsupported engine { required: { node: ">=26" } }', 'error NETSDK1045: The current .NET SDK does not support targeting .NET 10.0.'],
    neg: ['node --version'],
  },
  'configuration/missing-setting': {
    pos: ['Error: environment variable GITHUB_TOKEN is not set', 'missing required configuration: board.url'],
    neg: ['reads the environment variable when present'],
  },
  'infrastructure/http-status': {
    pos: ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'HTTP/1.1 503 Service Unavailable'],
    neg: ['maps 503 to a retry in the client', 'processed 429 items'],
  },
  'infrastructure/model-api-error': {
    pos: ['{"type":"result","is_error":true,"result":"API Error: Response stalled mid-stream. The response above may be incomplete."}',
      'API Error: Connection closed mid-response. The response above may be incomplete.',
      '{"type":"result","subtype":"success","is_error":true,"terminal_reason":"api_error"}',
      'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}',
      '{"type":"error","message":"stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)"}'],
    neg: ['{"type":"result","subtype":"success","is_error":false,"terminal_reason":"completed"}', 'handles API Error responses in the client', 'API Error: 400 bad request'],
  },
  'infrastructure/runner-lost': {
    pos: ['The hosted runner: GitHub Actions 12 lost communication with the server. Anything in your workflow that terminates the runner process can cause this error.'],
    neg: ['reconnects after the socket lost its server'],
  },
  'infrastructure/rate-limit': {
    pos: ['Error: rate limit exceeded, retry after 30s', 'You have been rate-limited'],
    neg: ['rateLimit.test.ts passed', 'rate-limit.ts'],
  },
  'infrastructure/network': {
    pos: ['Error: getaddrinfo ENOTFOUND api.anthropic.com', "fatal: unable to access 'https://github.com/o/r/': Could not resolve host: github.com", 'Error: socket hang up'],
    neg: ['network tests: 12 passed'],
  },
  'infrastructure/disk-full': {
    pos: ['Error: ENOSPC: no space left on device, write', 'System.IO.IOException: There is not enough space on the disk.'],
    neg: ['cleared disk cache'],
  },
  'infrastructure/out-of-memory': {
    pos: ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory'],
    neg: ['memory usage: 120MB'],
  },
  'delivery/merge-conflict': {
    pos: ['CONFLICT (content): Merge conflict in src/index.ts', 'Automatic merge failed; fix conflicts and then commit the result.',
      'error: could not apply 1a2b3c4... feat: add order totals', 'hint: Resolve all conflicts manually, mark them as resolved with'],
    neg: ['resolves conflicting options', 'conflict-free replicated data type'],
  },
  'delivery/push-rejected': {
    pos: [' ! [rejected]        feature/AF-1 -> feature/AF-1 (non-fast-forward)', 'error: failed to push some refs to https://github.com/o/r.git'],
    neg: ['rejects invalid input'],
  },
  'delivery/branch-in-use': {
    pos: ["fatal: 'feature/AF-1-example' is already checked out at 'C:/repo/.worktrees/AF-1'", "fatal: 'feature/AF-1-example' is already used by worktree at '/repo/.worktrees/AF-1'"],
    neg: ['checked out feature/AF-1-example'],
  },
  'agent_execution/context-exhausted': {
    pos: ['{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Prompt is too long"}', 'Error: context_length_exceeded',
      '{"type":"turn.failed","error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again."}}'],
    neg: ['keeps context between calls'],
  },
  'agent_execution/max-turns': {
    pos: ['{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":200}', 'claude failed: Error: Reached max turns (40)'],
    neg: ['turns: 12', 'reached the maximum of 40 retries'],
  },
  'agent_execution/invalid-output': {
    pos: ['review round failed: Unexpected end of JSON input', 'review round failed: Unexpected token \'`\', "```json" is not valid JSON', 'engine produced no verdict',
      'MCP error -32602: Invalid arguments for tool submit_result: [{"code":"invalid_type","path":["summary"]}]',
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.12: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01."}}'],
    neg: ['engine exited code 1 with no verdict', 'parses JSON input safely', 'review round failed: git fetch exited 128'],
  },
  'agent_execution/ended-without-submit': {
    pos: ['{"type":"result","subtype":"success","is_error":false,"duration_ms":812345,"num_turns":64,"result":"I\'ll wait for the push to finish."}'],
    neg: ['{"type":"result","subtype":"success","is_error":true,"result":"API Error: 500"}', '{"type":"result","subtype":"error_max_turns","is_error":true}'],
    detail: CLEAN_EXIT,
  },
  'build_test/compiler-error': {
    pos: ["src/Foo.cs(12,5): error CS0246: The type or namespace name 'Bar' could not be found", "src/a.ts(3,20): error TS2307: Cannot find module './b' or its corresponding type declarations.",
      "src/App/App.csproj : error NU1903: Warning As Error: Package 'Example.OpenApi' 2.0.0 has a known high severity vulnerability"],
    neg: ['0 Error(s)', 'error handling improved', 'error NU1301: Unable to load the service index for source https://x/index.json.', 'warning NU1903: Package has a known vulnerability'],
  },
  'build_test/build-failed': {
    pos: ['Build FAILED.', 'npm ERR! Test failed.  See above for more details.'],
    neg: ['Build succeeded.'],
  },
  'build_test/test-failures': {
    pos: [' Tests  2 failed | 118 passed (120)', ' FAIL  packages/core/test/a.test.ts > adds', 'Failed!  - Failed:     1, Passed:    41, Skipped:     0', 'AssertionError: expected 1 to be 2',
      'FAILED tests/test_orders.py::test_create_order - assert 404 == 201', '==================== 1 failed, 52 passed in 3.21s ===================='],
    neg: [' Tests  120 passed (120)', 'Tests: 0 failed', '==================== 52 passed in 3.21s ====================', 'FAILED: build step skipped'],
  },
  'build_test/lint-errors': {
    pos: ['✖ 3 problems (3 errors, 0 warnings)', '✖ 1 problem (1 error, 0 warnings)'],
    neg: ['✖ 2 problems (0 errors, 2 warnings)'],
  },
};

describe('failure-triage rules', () => {
  it('every rule has fixtures and every fixture names a real rule', () => {
    const evidenceRules = FAILURE_TRIAGE_RULE_IDS.filter((id) => !id.includes('/reason-'));
    expect(Object.keys(FIXTURES).sort()).toEqual([...evidenceRules].sort());
  });

  for (const [ruleId, { pos, neg, detail }] of Object.entries(FIXTURES)) {
    const category = ruleId.split('/')[0];
    it(`${ruleId} fires on its positives`, () => {
      for (const line of pos) expect(crash(line, detail), line).toMatchObject({ ruleId, category });
    });
    it(`${ruleId} stays quiet on its negatives`, () => {
      for (const line of neg) expect(crash(line, detail).ruleId, line).not.toBe(ruleId);
    });
  }

  it('ended-without-submit needs a clean exit of a claimed session', () => {
    const result = '{"type":"result","subtype":"success","is_error":false,"result":"Implemented the change."}';
    expect(crash(result, CLEAN_EXIT).ruleId).toBe('agent_execution/ended-without-submit');
    expect(crash(result).category).toBe('unknown'); // exit code 1: something failed after the turn ended
    expect(classify(dispatcherCrash(result, 'timeout'), 'timeout', 'session `worker-1` timed out after 60m with the task still in progress').category).toBe('unknown');
  });

  it('the explicit-reason fast path labels without evidence', () => {
    expect(classifyByRules('permission_denied', 'permission denied for Bash(git push:*)', null))
      .toMatchObject({ category: 'access', ruleId: 'access/reason-permission-denied', matchedLine: 'permission denied for Bash(git push:*)' });
    expect(classifyByRules('merge_conflict', 'PR 42 has merge conflicts', null)).toMatchObject({ category: 'delivery', ruleId: 'delivery/reason-merge-conflict' });
    expect(classifyByRules('pr_closed', 'PR 42 was closed without merging', null)).toMatchObject({ category: 'delivery', ruleId: 'delivery/reason-pr-closed' });
  });

  it('bare reasons and supervisor boilerplate never match', () => {
    expect(crash('')).toMatchObject({ category: 'unknown', ruleId: null, version: FAILURE_TRIAGE_RULES_VERSION });
    expect(classify(dispatcherCrash('', 'timeout'), 'timeout', 'session `worker-1` timed out after 60m with the task still in progress').category).toBe('unknown');
    expect(ci().category).toBe('unknown'); // a CI-red status with no captured errors
    const denied = buildFailureComment({ reason: 'stale', source: 'dispatcher', detail: 'claim by `worker-1` looks abandoned — no heartbeat for 130m (staleClaimMinutes 120)', attempt: 1, maxAttempts: 3 });
    expect(classify(denied, 'stale', 'claim by `worker-1` looks abandoned — no heartbeat for 130m (staleClaimMinutes 120)').category).toBe('unknown');
    const review = buildFailureComment({ reason: 'review_failed', source: 'reviewer', detail: 'reviewer session exited with code 1', attempt: 1, maxAttempts: 3, body: 'The automated reviewer will retry on the next poll.' });
    expect(classify(review, 'review_failed', 'reviewer session exited with code 1').category).toBe('unknown');
  });

  it('a cause outranks the build failure it explains, and the rest are recorded', () => {
    const r = ci('error NU1301: Unable to load the service index for source https://x/index.json. Response status code does not indicate success: 401 (Unauthorized).', 'Build FAILED.');
    expect(r).toMatchObject({ category: 'access', ruleId: 'access/http-401-403', alsoMatched: ['build_test'] });
  });

  it('a timeout only considers causes that explain a stall', () => {
    const tail = "src/a.ts(3,20): error TS2322: Type 'string' is not assignable to type 'number'.";
    expect(classify(dispatcherCrash(tail, 'timeout'), 'timeout', null).category).toBe('unknown');
    expect(crash(tail).category).toBe('build_test');
    const overloaded = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
    expect(classify(dispatcherCrash(overloaded, 'timeout'), 'timeout', null).category).toBe('infrastructure');
  });

  it('ignores the structured header (the JSON detail is scanned once, as detail)', () => {
    const body = buildFailureComment({ reason: 'crashed', source: 'dispatcher', detail: 'x', attempt: 1, maxAttempts: 3 });
    expect(failureEvidenceText(body, 'x')).toBe('x');
  });

  it('bounds the matched line and keeps the match visible', () => {
    const line = `${'a'.repeat(400)} Could not resolve host: github.com ${'b'.repeat(400)}`;
    const r = crash(line);
    expect(r.matchedLine!.length).toBeLessThanOrEqual(200);
    expect(r.matchedLine).toContain('Could not resolve host');
  });
});

describe('failure-triage evidence normalization', () => {
  it('normalizes CRLF, strips ANSI and control characters, keeps tabs and newlines', () => {
    expect(normalizeFailureText('a\r\nb\rc\u001b[31mred\u001b[0m\u0007\td\u0000')).toBe('a\nb\ncred\td');
    expect(normalizeFailureText('\u001b]8;;https://x\u0007link\u001b]8;;\u0007')).toBe('link');
  });

  it('matches through ANSI colouring and CRLF line endings', () => {
    expect(crash('\u001b[31merror CS0103\u001b[0m: The name x does not exist\r\nBuild FAILED.').category).toBe('build_test');
  });

  it('keeps head and tail of oversized evidence', () => {
    const big = `${'x\n'.repeat(40_000)}error TS2304: Cannot find name 'y'.`;
    const text = failureEvidenceText(dispatcherCrash(big), null);
    expect(text.length).toBeLessThan(70_000);
    expect(text).toContain('characters omitted');
    expect(classifyByRules('crashed', null, text).category).toBe('build_test');
  });

  it('treats a note without a structured header as evidence-free', () => {
    expect(failureEvidenceText('failure/v1 legacy note without json', null)).toBe('');
  });
});
