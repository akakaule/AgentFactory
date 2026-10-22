import { describe, it, expect } from 'vitest';
import { assertBoardCapabilities } from '../src/httpCore.js';
import { AGENT_CAPABILITIES } from '../src/types.js';

describe('assertBoardCapabilities (supervisor startup gate)', () => {
  it('names the coordinated restart when the board predates the capability field', () => {
    // a pre-fence board's whoami body: no `capabilities` at all
    expect(() => assertBoardCapabilities({ label: 'dispatcher-1', supervisor: true }))
      .toThrow(/execution-fence\/v1[\s\S]*coordinated restart/);
  });

  it('names the coordinated restart when the board lacks a required capability', () => {
    expect(() => assertBoardCapabilities({ label: 'reviewer-1', supervisor: false, capabilities: [] }))
      .toThrow(/execution-fence\/v1[\s\S]*coordinated restart/);
  });

  it('passes a board that advertises every required capability', () => {
    expect(() => assertBoardCapabilities({ label: 'watcher-1', supervisor: true, capabilities: [...AGENT_CAPABILITIES] })).not.toThrow();
  });
});
