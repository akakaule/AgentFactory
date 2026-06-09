import type { DB } from './db.js';

// BEGIN IMMEDIATE acquires the write lock up front so concurrent claimers cannot
// both read the same row. node:sqlite is synchronous, so the closure runs with no interleaving.
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
