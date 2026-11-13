import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, runMigrations, createCore, type DB } from '@agentfactory/core';
import { runMintToken } from '../../server/mintTokenCli.js';

/** AF-202 AC2: the `npm run token` CLI refuses bad --delegate combinations without minting. */
describe('mint token CLI', () => {
  let db: DB;
  let out: string[];
  let err: string[];
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const run = (...argv: string[]) => runMintToken(argv, () => createCore(db), { out: (l) => out.push(l), err: (l) => err.push(l) });

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    out = [];
    err = [];
  });

  it.each([
    [['--delegate']],
    [['--delegate', '--email', 'alvin@example.com', '--service']],
    [['--delegate', '--email', 'alvin@example.com', '--supervisor']],
  ])('refuses %j: non-zero exit, no token printed, no row added', (argv) => {
    const tokens = count('api_token');
    const users = count('app_user');
    expect(run('--label', 'Claude Code', ...argv)).not.toBe(0);
    expect(out.join('\n')).not.toMatch(/token/);
    expect(err.join('\n')).toMatch(/--delegate/);
    expect(count('api_token')).toBe(tokens);
    expect(count('app_user')).toBe(users);
  });

  it('mints a delegate token bound to the user', () => {
    expect(run('--label', 'Claude Code', '--email', 'alvin@example.com', '--delegate')).toBe(0);
    const printed = JSON.parse(out.join('\n')) as { delegate: boolean; userId: number; token: string; isService: boolean };
    expect(printed).toMatchObject({ delegate: true, isService: false });
    expect(createCore(db).authenticateToken(printed.token)).toMatchObject({ userId: printed.userId, delegate: true, label: 'Claude Code' });
  });

  it('keeps minting plain user and service tokens with delegate false', () => {
    expect(run('--label', 'phone', '--email', 'alvin@example.com')).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ delegate: false, isService: false });
    expect(run('--label', 'dispatcher', '--supervisor')).toBe(0);
    expect(JSON.parse(out.pop()!)).toMatchObject({ delegate: false, isService: true, isSupervisor: true, userId: null });
  });
});
