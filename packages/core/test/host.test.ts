import { describe, it, expect } from 'vitest';
import { resolveHost, sanitizeHost } from '../src/host.js';

describe('sanitizeHost', () => {
  it('keeps an ordinary hostname as-is', () => {
    expect(sanitizeHost('agentvm01')).toBe('agentvm01');
    expect(sanitizeHost('CTX-0F00PKX224700C')).toBe('CTX-0F00PKX224700C');
    expect(sanitizeHost('build.box_2')).toBe('build.box_2');
  });

  it('drops characters outside [A-Za-z0-9._-] so markup or control text never reaches the board', () => {
    expect(sanitizeHost('  my host\n')).toBe('myhost');
    expect(sanitizeHost('<img src=x>')).toBe('imgsrcx');
  });

  it('caps the length at 64 characters', () => {
    expect(sanitizeHost('a'.repeat(100))).toBe('a'.repeat(64));
  });

  it('turns blank, missing or fully-stripped input into null', () => {
    expect(sanitizeHost('')).toBeNull();
    expect(sanitizeHost('   ')).toBeNull();
    expect(sanitizeHost('<>')).toBeNull();
    expect(sanitizeHost(undefined)).toBeNull();
    expect(sanitizeHost(null)).toBeNull();
  });
});

describe('resolveHost', () => {
  it('prefers AGENTFACTORY_HOST over the OS hostname', () => {
    expect(resolveHost({ AGENTFACTORY_HOST: 'agentvm01' }, () => 'ip-10-0-0-4')).toBe('agentvm01');
  });

  it('falls back to the OS hostname when the override is unset or blank', () => {
    expect(resolveHost({}, () => 'laptop')).toBe('laptop');
    expect(resolveHost({ AGENTFACTORY_HOST: '  ' }, () => 'laptop')).toBe('laptop');
  });

  it('sanitizes whichever value wins', () => {
    expect(resolveHost({ AGENTFACTORY_HOST: 'vm 01' }, () => 'laptop')).toBe('vm01');
    expect(resolveHost({}, () => '')).toBeNull();
  });
});
