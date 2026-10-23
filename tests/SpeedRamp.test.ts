import { describe, expect, it } from 'vitest';
import { SPEED_RAMPS, audioFollowsSpeed, rampedFraction, sourceFrameFor } from '@renderer/timing/clipSpeed';
import type { SpeedRampPreset } from '@shared/types';

const clip = (speedRamp?: SpeedRampPreset, reversed = false) => ({ startFrame: 100, durationFrames: 90, sourceOffsetFrames: 30, speed: 1, reversed, speedRamp });

describe('speed ramps', () => {
  it('each ramp shows all of the footage, from its first frame to its last, never going back', () => {
    for (const preset of Object.keys(SPEED_RAMPS) as SpeedRampPreset[]) {
      expect(rampedFraction(preset, 0)).toBe(0);
      expect(rampedFraction(preset, 1)).toBeCloseTo(1, 9);
      let last = -1;
      for (let frame = 100; frame < 190; frame += 1) {
        const shown = sourceFrameFor(clip(preset), frame);
        expect(shown).toBeGreaterThanOrEqual(last);
        last = shown;
      }
      expect(sourceFrameFor(clip(preset), 100)).toBe(30);
      expect(sourceFrameFor(clip(preset), 189)).toBeGreaterThanOrEqual(30 + 85);
      expect(sourceFrameFor(clip(preset), 189)).toBeLessThanOrEqual(30 + 89);
    }
  });

  it('Hero goes slow through the middle: fewer frames of footage a frame there than at the start', () => {
    const step = (at: number) => sourceFrameFor(clip('hero'), at + 10) - sourceFrameFor(clip('hero'), at);
    expect(step(145)).toBeLessThan(step(100) / 3);
  });

  it('backwards along a ramp runs the same frames the other way', () => {
    expect(sourceFrameFor(clip('hero', true), 100)).toBe(30 + 89);
    expect(sourceFrameFor(clip('hero', true), 189)).toBeLessThanOrEqual(30 + 4);
  });

  it('a ramped clip is silent: one playback rate cannot follow it', () => {
    expect(audioFollowsSpeed(clip('hero'))).toBe(false);
    expect(audioFollowsSpeed(clip())).toBe(true);
  });
});
