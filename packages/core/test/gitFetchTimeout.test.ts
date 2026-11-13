import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchRemoteRef, GitError } from '../src/git.js';

// An origin that accepts the connection and never answers: the fetch must give up on its own
// instead of hanging the reviewer's tick (or a board request) forever.
describe('fetchRemoteRef against a hung origin', () => {
  let server: Server | null = null;
  const sockets: Socket[] = [];
  let repo: string | null = null;
  afterEach(() => {
    for (const s of sockets) s.destroy();
    server?.close();
    if (repo) rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); // Windows frees the killed git's cwd handle a moment later
  });

  it('times out with a GitError instead of hanging', async () => {
    server = createServer((s) => { sockets.push(s); });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    repo = mkdtempSync(join(tmpdir(), 'af-fetch-timeout-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', `http://127.0.0.1:${port}/repo.git`], { cwd: repo });

    const started = Date.now();
    await expect(fetchRemoteRef(repo, 'feature/x', { timeoutMs: 1500 })).rejects.toThrow(GitError);
    await expect(fetchRemoteRef(repo, 'feature/x', { timeoutMs: 1500 })).rejects.toThrow(/timed out/);
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
