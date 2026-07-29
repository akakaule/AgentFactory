import { isAbsolute } from 'node:path';
import { z } from 'zod';

/**
 * Shared config plumbing for board-mode supervisors (#46): a supervisor points either at a local
 * SQLite file (`db`) or at a board URL (`board`) — never both, never neither. Each supervisor
 * package applies the XOR in its own schema (see `xorDbBoard`); the building blocks live here so
 * the three configs cannot drift.
 */

/** `board: { url, token? | tokenEnv? }` — the token itself may live in the file (trusted-team
 *  machines) or, preferably, in the environment named by `tokenEnv`. */
export const boardSchema = z
  .object({
    url: z.string().min(1),
    token: z.string().min(1).optional(),
    tokenEnv: z.string().min(1).optional(),
  })
  .strict();

export type BoardConfig = z.infer<typeof boardSchema>;

/** workspace name → absolute machine-local clone path (board `repoPath` is board-central). */
export const repoPathOverridesSchema = z.record(z.string().min(1));

export const DEFAULT_TOKEN_ENV = 'AGENTFACTORY_TOKEN';

/** The XOR refinement each supervisor config applies over its base schema. Kept as a plain
 *  function (not a wrapped schema) because `superRefine` yields a ZodEffects, which cannot be
 *  `.extend`ed — sibling branches extend the exported BASE schema and re-apply this. */
export function xorDbBoard(cfg: { db?: string | undefined; board?: object | undefined }, ctx: z.RefinementCtx): void {
  if (!!cfg.db === !!cfg.board) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['db'],
      message: "set exactly one of 'db' (local sqlite file) or 'board' (remote board url + token)",
    });
  }
}

/**
 * Resolve the effective bearer token: inline `token`, else the env var named by `tokenEnv`,
 * else the conventional AGENTFACTORY_TOKEN. Throws with the variable name in the message —
 * a supervisor must fail fast at startup, not 401 on its first tick.
 */
export function resolveBoardToken(
  b: { token?: string | undefined; tokenEnv?: string | undefined },
  env: Record<string, string | undefined>,
  what = 'board token',
): string {
  const inline = b.token?.trim();
  if (inline) return inline;
  const envName = b.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const fromEnv = env[envName]?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(`${what} missing: set board.token in the config or export ${envName}`);
}

/** Startup guard: overrides describe THIS machine's paths, so platform-local absolute-path
 *  semantics are exactly right (spawn cwd and `git remote get-url` both require absolute). */
export function assertAbsoluteOverrides(overrides: Record<string, string> | undefined, label: string): void {
  for (const [workspace, path] of Object.entries(overrides ?? {})) {
    if (!isAbsolute(path)) {
      throw new Error(`${label}: repoPathOverrides['${workspace}'] must be an absolute path (got '${path}')`);
    }
  }
}
