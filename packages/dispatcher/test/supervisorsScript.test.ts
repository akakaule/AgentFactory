import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Guards the combined-supervisors launcher contract (AF-84): one command brings up
// dispatcher + reviewer + watcher as THREE separate child processes via concurrently,
// a crash in one must not kill the others, and the web server stays out of it.
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

describe('combined supervisors scripts', () => {
  it('declares concurrently as a devDependency', () => {
    expect(rootPkg.devDependencies['concurrently']).toBeDefined();
  });

  it('supervisors:dev launches all three tsx supervisors with name/colour tags', () => {
    const s = rootPkg.scripts['supervisors:dev'];
    expect(s).toBeDefined();
    expect(s).toContain('concurrently');
    expect(s).toContain('-n disp,rev,watch');
    expect(s).toContain('-c blue,magenta,green');
    expect(s).toContain('npm:dispatcher:dev -- dispatcher.config.json');
    expect(s).toContain('npm:reviewer:dev -- reviewer.config.json');
    expect(s).toContain('npm:watcher:dev -- watcher.config.json');
  });

  it('supervisors launches all three dist supervisors with name/colour tags', () => {
    const s = rootPkg.scripts['supervisors'];
    expect(s).toBeDefined();
    expect(s).toContain('concurrently');
    expect(s).toContain('-n disp,rev,watch');
    expect(s).toContain('-c blue,magenta,green');
    expect(s).toContain('node packages/dispatcher/dist/index.js dispatcher.config.json');
    expect(s).toContain('node packages/reviewer/dist/index.js reviewer.config.json');
    expect(s).toContain('node packages/watcher/dist/index.js watcher.config.json');
  });

  it('never kills the surviving supervisors when one crashes', () => {
    for (const name of ['supervisors', 'supervisors:dev']) {
      const s = rootPkg.scripts[name] ?? '';
      expect(s, `${name} must not use --kill-others*`).not.toMatch(/--kill-others/);
      expect(s, `${name} must not use the -k shorthand`).not.toMatch(/(^|\s)-k(\s|$)/);
    }
  });

  it('leaves the web server out of the combined scripts', () => {
    for (const name of ['supervisors', 'supervisors:dev']) {
      expect(rootPkg.scripts[name] ?? '').not.toMatch(/web/);
    }
  });

  it('keeps the individual per-supervisor scripts', () => {
    expect(rootPkg.scripts['dispatcher']).toBe('node packages/dispatcher/dist/index.js');
    expect(rootPkg.scripts['dispatcher:dev']).toBe('tsx packages/dispatcher/src/index.ts');
    expect(rootPkg.scripts['reviewer']).toBe('node packages/reviewer/dist/index.js');
    expect(rootPkg.scripts['reviewer:dev']).toBe('tsx packages/reviewer/src/index.ts');
    expect(rootPkg.scripts['watcher']).toBe('node packages/watcher/dist/index.js');
    expect(rootPkg.scripts['watcher:dev']).toBe('tsx packages/watcher/src/index.ts');
  });
});
