import { describe, it, expect } from 'vitest';
import { fitWithin, MAX_EDGE } from '../../client/src/image.js';

describe('fitWithin', () => {
  it('leaves small images untouched', () => {
    expect(fitWithin(800, 600, MAX_EDGE)).toEqual({ width: 800, height: 600 });
  });

  it('scales the long edge down to the max, preserving aspect', () => {
    expect(fitWithin(3136, 1568, 1568)).toEqual({ width: 1568, height: 784 });
    expect(fitWithin(1000, 4000, 1568)).toEqual({ width: 392, height: 1568 });
  });

  it('never collapses a dimension to zero', () => {
    expect(fitWithin(20000, 2, 1568).height).toBeGreaterThanOrEqual(1);
  });
});
