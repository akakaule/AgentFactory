import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { boardSchema, xorDbBoard, resolveBoardToken, assertAbsoluteOverrides } from '../src/boardConfig.js';

describe('resolveBoardToken', () => {
  it('prefers the inline token', () => {
    expect(resolveBoardToken({ token: 'inline', tokenEnv: 'X' }, { X: 'from-env' })).toBe('inline');
  });

  it('falls back to the named env var, then the AGENTFACTORY_TOKEN default', () => {
    expect(resolveBoardToken({ tokenEnv: 'MY_TOKEN' }, { MY_TOKEN: 'named' })).toBe('named');
    expect(resolveBoardToken({}, { AGENTFACTORY_TOKEN: 'conventional' })).toBe('conventional');
  });

  it('trims and treats blank as missing', () => {
    expect(resolveBoardToken({ token: '  padded  ' }, {})).toBe('padded');
    expect(() => resolveBoardToken({ token: '  ' }, {})).toThrow(/AGENTFACTORY_TOKEN/);
  });

  it('throws naming the env var it looked for', () => {
    expect(() => resolveBoardToken({ tokenEnv: 'AF_DISPATCH' }, {})).toThrow(/AF_DISPATCH/);
    expect(() => resolveBoardToken({}, {}, 'dispatcher board token')).toThrow(/dispatcher board token/);
  });
});

describe('assertAbsoluteOverrides', () => {
  it('accepts absolute paths for the running platform', () => {
    const abs = process.platform === 'win32' ? 'C:\\clones\\shop' : '/clones/shop';
    expect(() => assertAbsoluteOverrides({ shop: abs }, 'dispatcher')).not.toThrow();
    expect(() => assertAbsoluteOverrides(undefined, 'dispatcher')).not.toThrow();
  });

  it('rejects relative paths, naming the workspace and supervisor', () => {
    expect(() => assertAbsoluteOverrides({ shop: './clone' }, 'watcher')).toThrow(/watcher.*shop.*\.\/clone/);
  });
});

describe('xorDbBoard', () => {
  const schema = z
    .object({ db: z.string().min(1).optional(), board: boardSchema.optional() })
    .superRefine(xorDbBoard);

  it('accepts exactly one of db / board', () => {
    expect(schema.safeParse({ db: './x.db' }).success).toBe(true);
    expect(schema.safeParse({ board: { url: 'http://b' } }).success).toBe(true);
  });

  it('rejects both and neither', () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ db: './x.db', board: { url: 'http://b' } }).success).toBe(false);
  });

  it('boardSchema is strict — unknown keys rejected', () => {
    expect(schema.safeParse({ board: { url: 'http://b', tokn: 'typo' } }).success).toBe(false);
  });
});
