import { describe, expect, it } from 'vitest';
import type { Clip } from '@shared/types';
import {
  SPEED_RAMPS,
  audioFollowsSpeed,
  fractionAlong,
  rampPoints,
  speedAlong,
  sourceFrameFor,
} from '@renderer/timing/clipSpeed';

/**
 * A speed curve of the clip's own, beside the twelve ready-made ramps.
 *
 * The maths is the ramps' own, now taking points rather than a preset's name,
 * so these also pin that the presets still behave as they did.
 */

const clip = (extra: Partial<Clip>): Clip =>
  ({ startFrame: 0, durationFrames: 90, sourceOffsetFrames: 0, speed: 1, ...extra }) as Clip;

describe('the points a clip is ramped along', () => {
  it('prefers the clip’s own curve over a preset', () => {
    const both = clip({ speedRamp: 'hero', speedCurve: [2, 1, 0.5] });
    expect(rampPoints(both)).toEqual([2, 1, 0.5]);
  });

  it('falls back to the preset, then to nothing', () => {
    expect(rampPoints(clip({ speedRamp: 'hero' }))).toEqual(SPEED_RAMPS.hero);
    expect(rampPoints(clip({}))).toBeNull();
  });

  it('refuses a curve that could not be played', () => {
    // Fewer than two points is not a curve; a zero or a negative speed would
    // either stop the footage for ever or run it backwards inside a forwards
    // clip. Any of them drops the curve whole rather than retiming oddly.
    expect(rampPoints(clip({ speedCurve: [1] }))).toBeNull();
    expect(rampPoints(clip({ speedCurve: [1, 0] }))).toBeNull();
    expect(rampPoints(clip({ speedCurve: [1, -2] }))).toBeNull();
    expect(rampPoints(clip({ speedCurve: [1, Number.NaN] }))).toBeNull();
  });
});

describe('a curve’s speed and how far along it is', () => {
  it('reads the speed between its points, in a straight line', () => {
    const points = [1, 3];
    expect(speedAlong(points, 0)).toBeCloseTo(1, 6);
    expect(speedAlong(points, 0.5)).toBeCloseTo(2, 6);
    expect(speedAlong(points, 1)).toBeCloseTo(3, 6);
  });

  it('shows all of the footage by the end, whatever the curve', () => {
    for (const points of [[1, 3], [4, 0.2, 4], [0.1, 0.1, 9], SPEED_RAMPS.montage, SPEED_RAMPS.whip]) {
      expect(fractionAlong(points, 0), String(points)).toBeCloseTo(0, 6);
      expect(fractionAlong(points, 1), String(points)).toBeCloseTo(1, 6);
    }
  });

  it('never goes backwards along the footage', () => {
    // The integral of a positive speed only rises, and a clip that went back on
    // itself mid-ramp would stutter.
    const points = [3, 0.4, 2, 0.5, 4];
    let last = -1;
    for (let u = 0; u <= 1.0001; u += 0.02) {
      const shown = fractionAlong(points, u);
      expect(shown).toBeGreaterThanOrEqual(last - 1e-9);
      last = shown;
    }
  });
});

describe('the footage a curve shows', () => {
  it('starts at the first frame and ends on the last', () => {
    const slow = clip({ speedCurve: [0.5, 4], sourceOffsetFrames: 10 });
    expect(sourceFrameFor(slow, 0)).toBe(10);
    const used = Math.round(90 * 1);
    expect(sourceFrameFor(slow, 89)).toBeLessThanOrEqual(10 + used - 1);
    expect(sourceFrameFor(slow, 89)).toBeGreaterThan(10);
  });

  it('spends longer on the footage where the curve is slow', () => {
    // Slow first, fast after: by halfway it should have shown well under half.
    const ramped = clip({ speedCurve: [0.25, 0.25, 4, 4] });
    const half = sourceFrameFor(ramped, 45);
    const flat = sourceFrameFor(clip({}), 45);
    expect(half).toBeLessThan(flat);
  });
});

describe('the sound', () => {
  it('cannot follow a curve, as it cannot follow a ramp', () => {
    // One playback rate cannot follow a speed that changes, however the change
    // was asked for - so a hand-drawn curve silences the clip just as a preset
    // does. Without this it played on at a constant, wrong rate.
    expect(audioFollowsSpeed(clip({}))).toBe(true);
    expect(audioFollowsSpeed(clip({ speedRamp: 'hero' }))).toBe(false);
    expect(audioFollowsSpeed(clip({ speedCurve: [1, 3] }))).toBe(false);
    // A curve too broken to play is no curve, so the sound carries on.
    expect(audioFollowsSpeed(clip({ speedCurve: [1] }))).toBe(true);
  });
});
