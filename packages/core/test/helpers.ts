import { openDb, type DB } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

export function makeTestDb(): DB {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}
