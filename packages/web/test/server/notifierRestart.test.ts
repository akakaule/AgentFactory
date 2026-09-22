import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, openDb, runMigrations, type DB } from '@agentfactory/core';
import { Notifier } from '../../server/notifier.js';

describe('notifier disk and receiver recovery', () => {
  it('reopens SQLite between two failed POSTs and success, without resending a successful destination', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'af-notifier-'));
    const counts = { good: 0, flaky: 0 };
    const receiver = createServer((req, res) => {
      req.resume();
      const key = req.url === '/good' ? 'good' : 'flaky';
      counts[key]++;
      res.writeHead(key === 'good' || counts.flaky >= 3 ? 200 : 500).end();
    });
    await new Promise<void>(resolve => receiver.listen(0, '127.0.0.1', resolve));
    const address = receiver.address() as { port: number };
    const base = `http://127.0.0.1:${address.port}`;
    let db: DB | undefined;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        db = openDb(join(directory, 'board.db')); runMigrations(db);
        const core = createCore(db);
        const notifier = new Notifier({ webhooks: [`${base}/good`, `${base}/flaky`],
          events: new Set(['blocked']), pollMs: 1000, retryBaseMs: 0, retryMaxMs: 0, maxAttempts: 3,
        }, { core, fetch, console: { log() {}, warn() {}, error() {} } });
        if (attempt === 0) {
          await notifier.tick();
          const task = core.createTask({ title: 'Local recovery fixture', spec: 'test', acceptanceCriteria: 'test' });
          core.updateStatus(task.key, 'queued', 'human'); core.claimNextTask();
          core.updateStatus(task.key, 'blocked', 'agent', 'test blocker');
        }
        await notifier.tick();
        if (attempt === 2) expect(core.listAllNotificationOutbox().map(o => o.state)).toEqual(['succeeded', 'succeeded']);
        db.close(); db = undefined;
      }
      expect(counts).toEqual({ good: 1, flaky: 3 });
    } finally {
      db?.close();
      await new Promise<void>((resolve, reject) => receiver.close(error => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
