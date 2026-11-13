import type { Core } from '@agentfactory/core';

/** Where runMintToken writes: stdout carries the JSON (and the raw token), stderr the notes/errors. */
export interface MintIo { out: (line: string) => void; err: (line: string) => void; }

/**
 * The `npm run token` CLI, as a function so it can be tested: returns the process exit code.
 * Flag combinations are checked before the core is opened, so a refused mint creates neither a
 * user nor a token. `openCore` is only called once the flags are valid.
 */
export function runMintToken(argv: readonly string[], openCore: () => Pick<Core, 'createUser' | 'createApiToken'>, io: MintIo): number {
  const arg = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  const label = arg('--label') ?? 'cli token';
  const email = arg('--email');
  const name = arg('--name');
  const isService = has('--service') || has('--supervisor'); // supervisor implies service
  const isSupervisor = has('--supervisor');
  const delegate = has('--delegate');

  if (delegate && !email) {
    io.err('--delegate needs --email: a delegate token acts on behalf of a user');
    return 1;
  }
  if (delegate && isService) {
    io.err('--delegate cannot be combined with --service or --supervisor');
    return 1;
  }

  const core = openCore();
  let userId: number | null = null;
  if (email) userId = core.createUser({ email, displayName: name ?? email }).id;
  const minted = core.createApiToken({ label, userId, isService, isSupervisor, delegate });

  io.out(JSON.stringify({ id: minted.id, label, userId, isService, isSupervisor, delegate: minted.delegate, token: minted.token }, null, 2));
  io.err('\nStore this token now — only its hash is kept, it will not be shown again.');
  return 0;
}
