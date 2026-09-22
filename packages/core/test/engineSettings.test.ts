import { describe, it, expect } from 'vitest';
import { openCore } from '../src/index.js';
import { resolveEngine, normalizeEngineSettings } from '../src/engineSettings.js';

describe('engine settings (board-wide engine availability)', () => {
  it('defaults to every engine enabled and merges partial updates', () => {
    const core = openCore(':memory:');
    expect(core.getEngineSettings()).toEqual({ claude: { enabled: true }, codex: { enabled: true } });

    expect(core.setEngineSettings({ codex: { enabled: false } })).toEqual({ claude: { enabled: true }, codex: { enabled: false } });
    // a later partial update leaves the untouched engine as it was
    expect(core.setEngineSettings({ claude: { enabled: false } })).toEqual({ claude: { enabled: false }, codex: { enabled: false } });
    expect(core.getEngineSettings()).toEqual({ claude: { enabled: false }, codex: { enabled: false } });
  });

  it('ignores unknown engines and non-boolean values; malformed stored JSON reads as all-enabled', () => {
    const core = openCore(':memory:');
    expect(core.setEngineSettings({ gemini: { enabled: false }, codex: { enabled: 'no' } })).toEqual({ claude: { enabled: true }, codex: { enabled: true } });
    core.setKv('engine_settings', '{not json');
    expect(core.getEngineSettings()).toEqual({ claude: { enabled: true }, codex: { enabled: true } });
    expect(normalizeEngineSettings(null)).toEqual({ claude: { enabled: true }, codex: { enabled: true } });
  });

  it('resolveEngine: configured when enabled, else the other enabled engine, else null', () => {
    const both = { claude: { enabled: true }, codex: { enabled: true } };
    expect(resolveEngine('codex', both)).toBe('codex');
    expect(resolveEngine('codex', { claude: { enabled: true }, codex: { enabled: false } })).toBe('claude');
    expect(resolveEngine('claude', { claude: { enabled: false }, codex: { enabled: true } })).toBe('codex');
    expect(resolveEngine('claude', { claude: { enabled: false }, codex: { enabled: false } })).toBeNull();
  });

  it('never bumps the board version (app_kv sits outside the change signal)', () => {
    const core = openCore(':memory:');
    const before = core.getVersion();
    core.setEngineSettings({ codex: { enabled: false } });
    expect(core.getVersion()).toBe(before);
  });
});
