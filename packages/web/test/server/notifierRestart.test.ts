import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCore, openDb, runMigrations, type DB } from '@agentfactory/core';
import { Notifier, type NotifyEvent, type NotifyFetch } from '../../server/notifier.js';

describe('notifier review episodes across restarts', () => {
  it.each([
    ['acknowledged', true],
    ['delivered and still open', false],
  ])('alerts a resubmitted review whose previous alert was %s, all while the notifier was down', async (_label, acknowledge) => {
    const directory = mkdtempSync(join(tmpdir(), 'af-notifier-'));
    const posts: string[] = [];
    const fetch: NotifyFetch = async (_url, init) => {
      posts.push((JSON.parse(init.body) as { text: string }).text);
      return { ok: true, status: 200 };
    };
    const config = { webhooks: ['http://127.0.0.1:9/review'], events: new Set<NotifyEvent>(['in_review']),
      pollMs: 1000, retryBaseMs: 0, retryMaxMs: 0, maxAttempts: 3 };
    const quiet = { log() {}, warn() {}, error() {} };
    const open = () => {
      const db = openDb(join(directory, 'board.db')); runMigrations(db);
      return { db, core: createCore(db) };
    };
    let db: DB | undefined;
    try {
      let board = open(); db = board.db;
      await new Notifier(config, { core: board.core, fetch, console: quiet }).tick();
      const task = board.core.createTask({ title: 'Review episode fixture', spec: 'test', acceptanceCriteria: 'test' });
      board.core.updateStatus(task.key, 'queued', 'human'); board.core.claimNextTask();
      board.core.updateStatus(task.key, 'in_review', 'agent');
      await new Notifier(config, { core: board.core, fetch, console: quiet }).tick();
      expect(posts).toHaveLength(1);
      if (acknowledge) board.core.resolveAttention(board.core.listAttentionOccurrences()[0]!.id);
      db.close(); db = undefined;

      // Notifier down: changes requested, reclaimed and resubmitted before it polls again.
      board = open(); db = board.db;
      board.core.updateStatus(task.key, 'queued', 'human'); board.core.claimNextTask();
      board.core.updateStatus(task.key, 'in_review', 'agent');
      db.close(); db = undefined;

      board = open(); db = board.db;
      await new Notifier(config, { core: board.core, fetch, console: quiet }).tick();
      expect(posts).toHaveLength(2);
      expect(posts[1]).toContain(task.key);
      const openAlerts = board.core.listOpenAttention({ taskKey: task.key }).occurrences;
      expect(openAlerts).toHaveLength(1);
      await new Notifier(config, { core: board.core, fetch, console: quiet }).tick();
      expect(posts).toHaveLength(2); // the new episode alerts once, not on every poll
    } finally {
      db?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

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
