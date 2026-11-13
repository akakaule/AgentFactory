import { openCore } from '@agentfactory/core';
import { runMintToken } from './mintTokenCli.js';

/**
 * Mint an API bearer token. The raw token prints once to stdout (JSON) — store it now,
 * it is never recoverable. Bind it to a human with --email, or mint a --service token.
 *
 *   npm run token -- --label "Alvin's phone" --email alvin@example.com --name "Alvin"
 *   npm run token -- --label "ado-bridge" --service
 *   npm run token -- --label "dispatcher-remote" --service --supervisor   (release-claim/delivery/PAT ops)
 *   npm run token -- --label "Claude Code" --email alvin@example.com --delegate
 *     (an agent acting for that user: passes the human routes as the user, never the agent
 *      routes, and the activity log reads "Alvin (via Claude Code)")
 */
const dbPath = process.env['AGENTFACTORY_DB'] ?? './agentfactory.db';
process.exitCode = runMintToken(process.argv.slice(2), () => openCore(dbPath), {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});
