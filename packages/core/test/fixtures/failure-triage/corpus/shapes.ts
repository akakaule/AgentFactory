/**
 * Note builders that mirror the real `failure/v1` writers, so corpus evidence has exactly the
 * header/body framing the rules see in production: dispatcher releaseAndRetry / reapStaleClaims /
 * recordUnclaimedCodexFailure / recordDenial / the max_attempts follow-up, reviewer burnAttempt,
 * and watcher failDelivery (ciFailureBody / mergeConflictBody / the pr_closed body).
 */
import type { CorpusNote } from './types.js';

const WORKER = 'demo#AF-1-a1';

/** A claimed session that exited (dispatcher releaseAndRetry, not timed out). */
export function crash(tail: string, opts: { code?: number | null; attempt?: number; maxAttempts?: number } = {}): CorpusNote {
  return {
    source: 'dispatcher', reason: 'crashed', attempt: opts.attempt ?? 1, maxAttempts: opts.maxAttempts ?? 2,
    detail: `session \`${WORKER}\` exited with code ${opts.code === undefined ? 1 : opts.code ?? 'null'} with the task still in progress`,
    body: `Releasing the claim for retry.\n\nLog tail:\n\`\`\`\n${tail.trim()}\n\`\`\``,
  };
}

/** A claimed session killed at maxSessionMinutes; the kill line is the dispatcher's own boilerplate. */
export function timeout(tail: string, opts: { minutes?: number; attempt?: number; maxAttempts?: number } = {}): CorpusNote {
  const minutes = opts.minutes ?? 60;
  const lines = [tail.trim(), `[dispatcher] session exceeded maxSessionMinutes (${minutes}m); killing`].filter((l) => l !== '');
  return {
    source: 'dispatcher', reason: 'timeout', attempt: opts.attempt ?? 1, maxAttempts: opts.maxAttempts ?? 2,
    detail: `session \`${WORKER}\` timed out after ${minutes}m with the task still in progress`,
    body: `Releasing the claim for retry.\n\nLog tail:\n\`\`\`\n${lines.join('\n')}\n\`\`\``,
  };
}

/** The DB-scan reaper's orphaned-claim release — never carries a log. */
export function stale(minutes: number): CorpusNote {
  return {
    source: 'dispatcher', reason: 'stale', attempt: 1, maxAttempts: 2,
    detail: `claim by \`${WORKER}\` looks abandoned — no heartbeat for ${minutes}m (staleClaimMinutes 120)`,
    body: 'The supervisor found this task `in_progress` with no live agent activity — typically an orphaned claim after a supervisor or session crash. Releasing it back to the queue for pickup.',
  };
}

/** A Codex worker that exited before claiming: the raw log tail is the body, unfenced. */
export function codexUnclaimed(tail: string, opts: { timedOut?: boolean; attempt?: number } = {}): CorpusNote {
  const note: CorpusNote = {
    source: 'dispatcher', reason: opts.timedOut ? 'timeout' : 'crashed', attempt: opts.attempt ?? 1, maxAttempts: 2,
    detail: 'Codex exited before claiming its task; inspect the worker log',
  };
  if (tail.trim()) note.body = tail.trim();
  return note;
}

/** An unclaimed session that hit permission denials (dispatcher recordDenial). */
export function permissionDenied(tools: string[]): CorpusNote {
  return {
    source: 'dispatcher', reason: 'permission_denied', attempt: 1, maxAttempts: 2,
    detail: `permission denied for ${tools.join(', ')}`,
    body: `Session \`${WORKER}\` was permission denied for ${tools.map((t) => `\`${t}\``).join(', ')} and exited without claiming. The worker's tool allowlist or permission mode is misconfigured.`,
  };
}

/** The log-less note the dispatcher posts right after the final attempt's own failure note. */
export function maxAttempts(n = 2): CorpusNote {
  return {
    source: 'dispatcher', reason: 'max_attempts', attempt: n, maxAttempts: n,
    detail: `reached maxAttempts (${n}) and is skip-listed`,
    body: 'No further sessions will be spawned until a human intervenes.',
  };
}

/** Reviewer burnAttempt: the detail is the whole diagnosis; the body is fixed text. */
export function reviewFailed(detail: string, opts: { attempt?: number; maxAttempts?: number } = {}): CorpusNote {
  const attempt = opts.attempt ?? 1;
  const max = opts.maxAttempts ?? 2;
  return {
    source: 'reviewer', reason: 'review_failed', attempt, maxAttempts: max, detail,
    body: attempt >= max
      ? 'The automated reviewer is skip-listing this task — review it manually.'
      : 'The automated reviewer will retry on the next poll.',
  };
}

const PR_URL = 'https://github.com/example/app/pull/42';

/** Watcher ci_failed bounce; `errors` are the provider's captured excerpts (empty when none). */
export function ciFailed(checks: string[], errors: string[] = [], opts: { pr?: string; attempt?: number } = {}): CorpusNote {
  const list = checks.map((name) => `- ${name} — https://github.com/example/app/actions/runs/1001`).join('\n');
  const errorBlock = errors.length ? `\n\nBuild errors:\n\`\`\`text\n${errors.join('\n')}\n\`\`\`` : '';
  return {
    source: 'watcher', reason: 'ci_failed', attempt: opts.attempt ?? 1, maxAttempts: 2,
    detail: `PR ${opts.pr ?? '#42'} checks failed: ${checks.join(', ')}`,
    body: `PR: ${PR_URL} (open, head feature/AF-1-example)\nFailing checks:\n${list}${errorBlock}\n\nThe branch and PR still exist. Fix the failures and push to the SAME branch — do not open a new PR.`,
  };
}

export function mergeConflict(problem: string | null, opts: { pr?: string } = {}): CorpusNote {
  return {
    source: 'watcher', reason: 'merge_conflict', attempt: 1, maxAttempts: 2,
    detail: `PR ${opts.pr ?? '#42'} has merge conflicts`,
    body: `PR: ${PR_URL} (open, head feature/AF-1-example)${problem ? `\nMerge conflict detail: ${problem}` : ''}\n\nResolve the conflict: merge latest base branch into feature/AF-1-example, fix the conflicts, run verification, and push to the SAME branch - do not open a new PR.`,
  };
}

export function prClosed(opts: { pr?: string } = {}): CorpusNote {
  return {
    source: 'watcher', reason: 'pr_closed', attempt: 1, maxAttempts: 2,
    detail: `PR ${opts.pr ?? '#42'} was closed without merging`,
    body: `PR: ${PR_URL} (closed unmerged, head feature/AF-1-example)\n\nThe branch still exists. If the close was intentional, a human should re-scope or archive this task; otherwise fix and reopen a PR from the SAME branch.`,
  };
}

/** A Claude `-p --output-format stream-json` final result line, as it lands in a log tail. */
export function claudeResult(fields: { subtype?: string; isError?: boolean; result?: string; terminalReason?: string; denials?: string[] }): string {
  return JSON.stringify({
    type: 'result', subtype: fields.subtype ?? 'success', is_error: fields.isError ?? false, duration_ms: 812345, num_turns: 64,
    result: fields.result ?? '', total_cost_usd: 3.21,
    permission_denials: (fields.denials ?? []).map((command, i) => ({ tool_name: 'Bash', tool_use_id: `toolu_0${i}`, tool_input: { command } })),
    terminal_reason: fields.terminalReason ?? 'completed',
  });
}

/** The stdin warning every headless Claude session prints first — boilerplate, never a cause. */
export const STDIN_WARNING = 'Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.';

/** Codex `exec --json` framing lines that precede any real event. */
export const CODEX_PREAMBLE = [
  '{"type":"thread.started","thread_id":"00000000-0000-0000-0000-000000000001"}',
  '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"clamping SessionEnd hook timeout to 3s in hooks.json"}}',
  '{"type":"turn.started"}',
].join('\n');
