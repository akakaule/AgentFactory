import type { DB } from './db.js';
import { KEY_PREFIX } from './types.js';

// Called inside createTask's transaction after the INSERT, using the new row id.
// key = AF-<id>, seq = id (monotonic, gapless-enough, unique via the row id).
export function assignKeyAndSeq(db: DB, id: number): string {
  const key = `${KEY_PREFIX}-${id}`;
  db.prepare('UPDATE task SET key = ?, seq = ? WHERE id = ?').run(key, id, id);
  return key;
}
