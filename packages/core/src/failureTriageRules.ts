/**
 * `failure-triage-rules/v1` — the Phase 1 local classifier. Deterministic regex rules over the
 * evidence text of a failure note; no network, no persistence. Every rule has an id and positive +
 * negative fixtures in test/failureTriageRules.test.ts. v1's signals were starting points; v2 adds
 * the recurring signals v1 missed in the Phase 1 evaluation (docs/2026-10-04-failure-triage-phase1-
 * evaluation.md), each backed by a tuning case or a live note. Unknown is a valid, honest outcome.
 */
import type { FailureTriageCategory, FailureTriageRuleResult } from './types.js';

export const FAILURE_TRIAGE_RULES_VERSION = 'failure-triage-rules/v2';

type Cause = Exclude<FailureTriageCategory, 'unknown'>;
interface Rule {
  id: string; category: Cause; pattern: RegExp;
  /** Further scope on the note's reason/detail. The detail qualifies a signal, never is one (§6.1). */
  when?: (reason: string, detail: string | null) => boolean;
}

/**
 * When several categories match, the first in this order wins: a cause that explains a downstream
 * build/test failure (a 401 during restore, a missing tool, an outage) outranks the failure itself.
 */
export const FAILURE_TRIAGE_PRECEDENCE: readonly Cause[] = ['access', 'configuration', 'infrastructure', 'delivery', 'agent_execution', 'build_test'];

/**
 * A timed-out or abandoned session's log tail shows whatever it was doing when it was stopped —
 * an intermediate compile error the agent was about to fix is not why it timed out. For these
 * reasons only causes that explain a stall are considered.
 */
const STALL_REASONS = new Set(['timeout', 'stale']);
const STALL_CAUSES = new Set<Cause>(['access', 'infrastructure', 'agent_execution']);

/** Reasons whose writer already knows the cause (spec §6.1 explicit-reason fast path). */
const EXPLICIT_REASONS: Record<string, { id: string; category: Cause }> = {
  permission_denied: { id: 'access/reason-permission-denied', category: 'access' },
  merge_conflict: { id: 'delivery/reason-merge-conflict', category: 'delivery' },
  pr_closed: { id: 'delivery/reason-pr-closed', category: 'delivery' },
};

const RULES: readonly Rule[] = [
  // ── access ──
  { id: 'access/http-401-403', category: 'access', pattern: /\b(?:401|403)\b.*\b(?:unauthori[sz]ed|forbidden)\b|\b(?:unauthori[sz]ed|forbidden)\b.*\b(?:401|403)\b/i },
  { id: 'access/auth-failed', category: 'access', pattern: /\bauthentication (?:failed|required)\b|\bfailed to authenticate\b|\binvalid (?:api[ _-]?key|credentials|x-api-key|bearer token)\b|\b(?:token|credentials?|password) (?:has |have )?expired\b|\bauthentication_error\b/i },
  { id: 'access/git-credentials', category: 'access', pattern: /could not read Username|Permission denied \(publickey|terminal prompts disabled|Authentication failed for '/i },
  { id: 'access/eacces', category: 'access', pattern: /\bEACCES\b/ },
  { id: 'access/quota', category: 'access', pattern: /\binsufficient[_ ]quota\b|\bquota (?:has been )?exceeded\b|exceeded your current quota|credit balance is too low|\busage limit reached\b|\bout of credits\b|\byou(?:'ve| have) (?:hit|reached) your (?:\w+ )?limit\b/i },
  { id: 'access/host-denied', category: 'access', pattern: /The requested URL returned error: 40[13]\b|\bnpm (?:ERR!|error) code E40[13]\b|\bTF400813\b|\bis not authorized to access this resource\b|\bremote: Permission to \S+ denied to\b/i },

  // ── configuration ──
  { id: 'configuration/command-not-found', category: 'configuration', pattern: /\bcommand not found\b|is not recognized as an internal or external command|is not recognized as the name of a cmdlet|^\s*(?:ba|da|z)?sh: (?:line )?\d+: [\w.@/-]+: not found\s*$|Could not execute because the specified command or file was not found/i },
  { id: 'configuration/unknown-workspace', category: 'configuration', pattern: /\bworkspace not found\b/i },
  { id: 'configuration/invalid-branch-ref', category: 'configuration', pattern: /\bcould not prepare review: invalid branch ref\b/ },
  { id: 'configuration/spawn-enoent', category: 'configuration', pattern: /\bspawn\s+\S+\s+ENOENT\b/ },
  // a TypeScript TS2307 "Cannot find module" is a compile error, not an unresolvable runtime module
  { id: 'configuration/missing-module', category: 'configuration', pattern: /^(?!.*\berror TS\d{4}\b).*(?:Cannot find module ['"]|\bERR_MODULE_NOT_FOUND\b|\bMODULE_NOT_FOUND\b|\bNo module named ['"]?\w)/i },
  { id: 'configuration/runtime-version', category: 'configuration', pattern: /\bEBADENGINE\b|\bUnsupported engine\b|\bNETSDK1045\b|The current \.NET SDK does not support targeting|A compatible \.NET SDK was not found|requires Node(?:\.js)? (?:version )?[>=v]?\d/i },
  { id: 'configuration/missing-setting', category: 'configuration', pattern: /\b(?:environment variable|env var)\b.*\b(?:is not set|not set|is required|is missing|missing)\b|\bmissing required (?:config(?:uration)?|setting|environment variable)\b/i },

  // ── infrastructure ──
  { id: 'infrastructure/http-status', category: 'infrastructure', pattern: /\b(?:429|502|503|504|529)\b.*\b(?:too many requests|bad gateway|service unavailable|gateway time-?out|overloaded)\b|\b(?:too many requests|bad gateway|service unavailable|gateway time-?out)\b.*\b(?:429|502|503|504|529)\b/i },
  // the model API failing mid-request (Claude reports `api_error` / "… mid-response"; Codex a dropped stream)
  { id: 'infrastructure/model-api-error', category: 'infrastructure', pattern: /\bAPI Error: [^\n]*\bmid-(?:response|stream)\b|"terminal_reason":"api_error"|\bAPI Error: 5\d\d\b|\bstream disconnected before completion\b/ },
  { id: 'infrastructure/runner-lost', category: 'infrastructure', pattern: /\blost communication with the server\b/ },
  { id: 'infrastructure/rate-limit', category: 'infrastructure', pattern: /\brate[ -]?limit(?:ed)? (?:exceeded|reached|error)\b|\bbeen rate[ -]?limited\b|\brate_limit_error\b|\boverloaded_error\b|\bAPI (?:is )?overloaded\b/i },
  { id: 'infrastructure/network', category: 'infrastructure', pattern: /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH)\b|\bsocket hang up\b|Could not resolve host|Connection (?:timed out|reset by peer)|TLS handshake timeout/i },
  { id: 'infrastructure/disk-full', category: 'infrastructure', pattern: /\bENOSPC\b|No space left on device|There is not enough space on the disk/i },
  { id: 'infrastructure/out-of-memory', category: 'infrastructure', pattern: /JavaScript heap out of memory|\bOutOfMemoryError\b|System\.OutOfMemoryException|\bOOMKilled\b/ },

  // ── delivery ──
  { id: 'delivery/merge-conflict', category: 'delivery', pattern: /^\s*CONFLICT \(|Automatic merge failed|\bMerge conflict in\b|\bcould not apply [0-9a-f]{7,40}\b|\bResolve all conflicts manually\b/ },
  { id: 'delivery/push-rejected', category: 'delivery', pattern: /\[(?:remote )?rejected\]|failed to push some refs|\bnon-fast-forward\b|Updates were rejected/i },
  { id: 'delivery/branch-in-use', category: 'delivery', pattern: /\bis already (?:checked out|used by worktree) at '/ },

  // ── agent_execution ──
  { id: 'agent_execution/context-exhausted', category: 'agent_execution', pattern: /\bprompt is too long\b|\bcontext (?:length|window) (?:exceeded|limit)|\bmaximum context length\b|\bcontext_length_exceeded\b|input is too long for (?:the )?requested model|\bconversation (?:is )?too long\b|\bexceeds the context window\b/i },
  { id: 'agent_execution/max-turns', category: 'agent_execution', pattern: /\berror_max_turns\b|\bmax(?:imum)? (?:number of )?turns (?:reached|exceeded)\b|\breached max(?:imum)? turns\b/i },
  // malformed agent output or tool protocol: the reviewer's unparseable/empty verdict, invalid MCP
  // tool arguments, a tool_use the CLI never answered
  { id: 'agent_execution/invalid-output', category: 'agent_execution', pattern: /\breview round failed: (?:Unexpected end of JSON input|Unexpected token\b|.*\bis not valid JSON\b)|\bengine produced no verdict\b|\bMCP error -32602\b|\btool_use`? ids were found without `?tool_result\b/ },
  // a Claude session that ended its turn normally and exited cleanly while its task was still
  // claimed — it stopped (often "I'll wait for …" in headless mode) without the required submit
  // step. A non-zero exit means something failed after the turn, so that case stays unexplained.
  {
    id: 'agent_execution/ended-without-submit', category: 'agent_execution', pattern: /"type":"result","subtype":"success","is_error":false\b/,
    when: (reason, detail) => reason === 'crashed' && /\bexited with code 0\b/.test(detail ?? ''),
  },

  // ── build_test ──
  { id: 'build_test/compiler-error', category: 'build_test', pattern: /\berror (?:CS|TS|FS|CA|IDE|SA)\d{4}\b|\berror BC\d{5}\b|\berror\[E\d{4}\]|\berror NU1(?:60|90)\d\b/ },
  { id: 'build_test/build-failed', category: 'build_test', pattern: /^\s*Build FAILED\.?\s*$|\bnpm ERR! Test failed\b/ },
  { id: 'build_test/test-failures', category: 'build_test', pattern: /\bTests?:?\s+[1-9]\d* failed\b|^\s*FAIL\s+\S+\.(?:test|spec)\.|Failed!\s+-\s+Failed:\s+[1-9]|^\s*[1-9]\d* failing\b|\bAssertionError\b|\bAssert\.\w+\(\) Failure\b|^FAILED \S+::\S+|^=+ [1-9]\d* failed\b/ },
  { id: 'build_test/lint-errors', category: 'build_test', pattern: /✖ [1-9]\d* problems? \([1-9]\d* errors?\b/ },
];

const MATCHED_LINE_MAX = 200;

/** A bounded, single-line excerpt of `line` that keeps the match visible. */
function excerpt(line: string, index: number): string {
  const trimmed = line.trim();
  if (trimmed.length <= MATCHED_LINE_MAX) return trimmed;
  const offset = line.length - line.trimStart().length;
  const start = Math.max(0, Math.min(index - offset - 60, trimmed.length - MATCHED_LINE_MAX + 2));
  const body = trimmed.slice(start, start + MATCHED_LINE_MAX - 2);
  return `${start > 0 ? '…' : ''}${body}${start + MATCHED_LINE_MAX - 2 < trimmed.length ? '…' : ''}`;
}

/**
 * Classify one failure note. `reason` is the parsed `failure/v1` reason; `text` is the evidence
 * text (see failureTriageEvidence.ts), or null when the episode has no usable evidence.
 */
export function classifyByRules(reason: string, detail: string | null, text: string | null): FailureTriageRuleResult {
  const explicit = EXPLICIT_REASONS[reason];
  if (explicit) {
    return { version: FAILURE_TRIAGE_RULES_VERSION, category: explicit.category, ruleId: explicit.id, matchedLine: detail ? excerpt(detail, 0) : null, alsoMatched: [] };
  }
  const none: FailureTriageRuleResult = { version: FAILURE_TRIAGE_RULES_VERSION, category: 'unknown', ruleId: null, matchedLine: null, alsoMatched: [] };
  if (text === null || text === '') return none;

  const applicable = RULES.filter((rule) => (!STALL_REASONS.has(reason) || STALL_CAUSES.has(rule.category)) && (!rule.when || rule.when(reason, detail)));
  const categories = new Set(applicable.map((rule) => rule.category)).size;
  const firstHit = new Map<Cause, { id: string; line: string; index: number }>();
  for (const line of text.split('\n')) {
    for (const rule of applicable) {
      if (firstHit.has(rule.category)) continue;
      const match = rule.pattern.exec(line);
      if (match) firstHit.set(rule.category, { id: rule.id, line, index: match.index });
    }
    if (firstHit.size === categories) break;
  }
  const matched = FAILURE_TRIAGE_PRECEDENCE.filter((category) => firstHit.has(category));
  const winner = matched[0];
  if (!winner) return none;
  const hit = firstHit.get(winner)!;
  return { version: FAILURE_TRIAGE_RULES_VERSION, category: winner, ruleId: hit.id, matchedLine: excerpt(hit.line, hit.index), alsoMatched: matched.slice(1) };
}

/** Every rule id (the explicit-reason ids included) — for coverage reporting in tests. */
export const FAILURE_TRIAGE_RULE_IDS: readonly string[] = [...Object.values(EXPLICIT_REASONS).map((r) => r.id), ...RULES.map((r) => r.id)];
