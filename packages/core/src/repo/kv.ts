import type { DB } from '../db.js';

/**
 * `app_kv` — a generic single-row-per-key string store for small server state (the notifier's
 * activity cursor). Outside getVersion() (migration #13), so writes never bump the board version.
 */
export function getKv(db: DB, key: string): string | null {
  const r = db.prepare('SELECT value FROM app_kv WHERE key = ?').get(key) as { value: string } | undefined;
  return r ? r.value : null;
}

export function setKv(db: DB, key: string, value: string): void {
  db.prepare('INSERT INTO app_kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
