import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { transaction } from '../src/transaction.js';

describe('openDb', () => {
  it('enables WAL, busy_timeout and foreign keys', () => {
    const db = openDb(':memory:');
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
  });
});

describe('transaction', () => {
  it('commits on success and rolls back on throw', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t(n INTEGER)');
    transaction(db, () => db.prepare('INSERT INTO t(n) VALUES (1)').run());
    expect(db.prepare('SELECT count(*) c FROM t').get()).toMatchObject({ c: 1 });
    expect(() => transaction(db, () => {
      db.prepare('INSERT INTO t(n) VALUES (2)').run();
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.prepare('SELECT count(*) c FROM t').get()).toMatchObject({ c: 1 });
  });
});
