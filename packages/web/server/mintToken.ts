import { openCore } from '@agentfactory/core';

/**
 * Mint an API bearer token. The raw token prints once to stdout (JSON) — store it now,
 * it is never recoverable. Bind it to a human with --email, or mint a --service token.
 *
 *   npm run token -- --label "Alvin's phone" --email alvin@example.com --name "Alvin"
 *   npm run token -- --label "ado-bridge" --service
 *   npm run token -- --label "dispatcher-remote" --service --supervisor   (release-claim/delivery/PAT ops)
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (flag: string): boolean => process.argv.includes(flag);

const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
const label = arg('--label') ?? 'cli token';
const email = arg('--email');
const name = arg('--name');
const isService = has('--service') || has('--supervisor'); // supervisor implies service
const isSupervisor = has('--supervisor');

const core = openCore(dbPath);
let userId: number | null = null;
if (email) {
  const user = core.createUser({ email, displayName: name ?? email });
  userId = user.id;
}
const minted = core.createApiToken({ label, userId, isService, isSupervisor });

console.log(JSON.stringify({ id: minted.id, label, userId, isService, isSupervisor, token: minted.token }, null, 2));
console.error('\nStore this token now — only its hash is kept, it will not be shown again.');
