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
const crash = (tail: string) => classify(dispatcherCrash(tail), 'crashed', 'session `worker-1` exited with code 1 with the task still in progress');
const ci = (...errors: string[]) => classify(watcherCi(errors), 'ci_failed', 'PR 42 checks failed: build');

/** rule id → [positive evidence lines, negative evidence lines that must NOT fire that rule] */
const FIXTURES: Record<string, { pos: string[]; neg: string[] }> = {
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
    pos: ['Claude AI usage limit reached|1760000000', 'Error code: 429 - insufficient_quota', 'Your credit balance is too low to access the API'],
    neg: ['quota tests passed'],
  },
  'configuration/command-not-found': {
    pos: ['bash: dotnet: command not found', "'pnpm' is not recognized as an internal or external command,"],
    neg: ['Running command: npm test'],
  },
  'configuration/spawn-enoent': {
    pos: ['Error: spawn codex ENOENT'],
    neg: ["ENOENT: no such file or directory, open 'src/missing.ts'"],
  },
  'configuration/missing-module': {
    pos: ["Error: Cannot find module '@agentfactory/core'", 'ModuleNotFoundError: No module named requests'],
    neg: ["src/a.ts(3,20): error TS2307: Cannot find module './b' or its corresponding type declarations."],
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
    pos: ['CONFLICT (content): Merge conflict in src/index.ts', 'Automatic merge failed; fix conflicts and then commit the result.'],
    neg: ['resolves conflicting options', 'conflict-free replicated data type'],
  },
  'delivery/push-rejected': {
    pos: [' ! [rejected]        feature/AF-1 -> feature/AF-1 (non-fast-forward)', 'error: failed to push some refs to https://github.com/o/r.git'],
    neg: ['rejects invalid input'],
  },
  'agent_execution/context-exhausted': {
    pos: ['{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Prompt is too long"}', 'Error: context_length_exceeded'],
    neg: ['keeps context between calls'],
  },
  'agent_execution/max-turns': {
    pos: ['{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":200}'],
    neg: ['turns: 12'],
  },
  'build_test/compiler-error': {
    pos: ["src/Foo.cs(12,5): error CS0246: The type or namespace name 'Bar' could not be found", "src/a.ts(3,20): error TS2307: Cannot find module './b' or its corresponding type declarations."],
    neg: ['0 Error(s)', 'error handling improved'],
  },
  'build_test/build-failed': {
    pos: ['Build FAILED.', 'npm ERR! Test failed.  See above for more details.'],
    neg: ['Build succeeded.'],
  },
  'build_test/test-failures': {
    pos: [' Tests  2 failed | 118 passed (120)', ' FAIL  packages/core/test/a.test.ts > adds', 'Failed!  - Failed:     1, Passed:    41, Skipped:     0', 'AssertionError: expected 1 to be 2'],
    neg: [' Tests  120 passed (120)', 'Tests: 0 failed'],
  },
};

describe('failure-triage rules', () => {
  it('every rule has fixtures and every fixture names a real rule', () => {
    const evidenceRules = FAILURE_TRIAGE_RULE_IDS.filter((id) => !id.includes('/reason-'));
    expect(Object.keys(FIXTURES).sort()).toEqual([...evidenceRules].sort());
  });

  for (const [ruleId, { pos, neg }] of Object.entries(FIXTURES)) {
    const category = ruleId.split('/')[0];
    it(`${ruleId} fires on its positives`, () => {
      for (const line of pos) expect(crash(line), line).toMatchObject({ ruleId, category });
    });
    it(`${ruleId} stays quiet on its negatives`, () => {
      for (const line of neg) expect(crash(line).ruleId, line).not.toBe(ruleId);
    });
  }

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
