import { describe, expect, it } from 'vitest';

import { dbToPosition, gainToPosition, positionToDb, positionToGain } from '../src/renderer/audio/faderLaw';

describe('the mixer fader law', () => {
  it('puts unity three quarters of the way up and +6 dB at the top', () => {
    expect(gainToPosition(1)).toBeCloseTo(0.75, 6);
    expect(gainToPosition(2)).toBeCloseTo(1, 6);
    expect(positionToGain(1)).toBe(2);
  });

  it('keeps the bottom for silence and -60 dB just above it', () => {
    expect(gainToPosition(0)).toBe(0);
    expect(positionToGain(0)).toBe(0);
    expect(dbToPosition(-60)).toBeCloseTo(0.02, 6);
  });

  it('goes there and back: a position gives a level that gives the same position', () => {
    for (const position of [0.01, 0.1, 0.3, 0.5, 0.62, 0.8, 0.95]) {
      expect(dbToPosition(positionToDb(position))).toBeCloseTo(position, 6);
    }
  });

  it('only ever rises', () => {
    let last = -Infinity;
    for (let step = 0; step <= 200; step += 1) {
      const gain = positionToGain(step / 200);
      expect(gain).toBeGreaterThanOrEqual(last);
      last = gain;
    }
  });

  it('snaps a thumb within a hair of unity to exactly 0 dB, but lets one keyboard step off it', () => {
    expect(positionToGain(0.7501)).toBe(1);
    expect(positionToGain(0.75 - 1 / 200)).toBeLessThan(1);
    expect(positionToGain(0.75 + 1 / 200)).toBeGreaterThan(1);
  });
});
