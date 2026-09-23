import { describe, expect, it } from 'vitest';

import { fadeGainAt, fadeLengths, hasFade } from '@renderer/timing/clipFades';

/**
 * The fade envelope: one shape, used by the picture and by the sound.
 */

const clip = (fadeIn = 0, fadeOut = 0, durationFrames = 100) => ({
  durationFrames,
  fadeInFrames: fadeIn,
  fadeOutFrames: fadeOut,
});

describe('a clip with no fades', () => {
  it('comes through whole, from end to end', () => {
    for (const frame of [0, 1, 50, 99, 100]) {
      expect(fadeGainAt(clip(), frame)).toBe(1);
    }
    expect(hasFade(clip())).toBe(false);
  });
});

describe('fading in', () => {
  it('starts at nothing and arrives at full by the end of the fade', () => {
    const fading = clip(10);
    expect(fadeGainAt(fading, 0)).toBe(0);
    expect(fadeGainAt(fading, 5)).toBeCloseTo(0.5, 6);
    expect(fadeGainAt(fading, 10)).toBe(1);
    expect(fadeGainAt(fading, 40)).toBe(1);
  });

  it('is a one-frame ramp when it is one frame long, not a frame of black', () => {
    const fading = clip(1);
    expect(fadeGainAt(fading, 0)).toBe(0);
    expect(fadeGainAt(fading, 1)).toBe(1);
  });
});

describe('fading out', () => {
  it('holds full until the fade begins, then reaches nothing at the end', () => {
    const fading = clip(0, 20);
    expect(fadeGainAt(fading, 79)).toBe(1);
    expect(fadeGainAt(fading, 80)).toBe(1);
    expect(fadeGainAt(fading, 90)).toBeCloseTo(0.5, 6);
    expect(fadeGainAt(fading, 100)).toBe(0);
  });
});

describe('both ends at once', () => {
  it('fades in, holds, and fades out', () => {
    const fading = clip(10, 10);
    expect(fadeGainAt(fading, 0)).toBe(0);
    expect(fadeGainAt(fading, 10)).toBe(1);
    expect(fadeGainAt(fading, 50)).toBe(1);
    expect(fadeGainAt(fading, 95)).toBeCloseTo(0.5, 6);
    expect(fadeGainAt(fading, 100)).toBe(0);
  });

  it('shares the clip out when the two would overlap', () => {
    // 80 asked for in, 40 out, in a clip of 100: they cannot both have it.
    const crowded = fadeLengths(clip(80, 40));
    expect(crowded.fadeIn + crowded.fadeOut).toBe(100);
    expect(crowded.fadeIn).toBeGreaterThan(crowded.fadeOut);
    // And the envelope stays sane: nothing above one, nothing below zero.
    for (let frame = 0; frame <= 100; frame += 1) {
      const gain = fadeGainAt(clip(80, 40), frame);
      expect(gain).toBeGreaterThanOrEqual(0);
      expect(gain).toBeLessThanOrEqual(1);
    }
  });

  it('never lets a fade run past the clip it is on', () => {
    expect(fadeLengths(clip(400, 0)).fadeIn).toBe(100);
    expect(fadeLengths(clip(0, 400, 30)).fadeOut).toBe(30);
  });
});

describe('the edges of the envelope', () => {
  it('holds at the ends rather than running off them', () => {
    const fading = clip(10, 10);
    expect(fadeGainAt(fading, -5)).toBe(0);
    expect(fadeGainAt(fading, 200)).toBe(0);
  });

  it('ignores a negative or fractional request', () => {
    expect(fadeLengths(clip(-20)).fadeIn).toBe(0);
    expect(fadeLengths({ durationFrames: 100, fadeInFrames: 10.4 }).fadeIn).toBe(10);
  });

  it('knows when there is a fade to draw', () => {
    expect(hasFade(clip(5))).toBe(true);
    expect(hasFade(clip(0, 5))).toBe(true);
    expect(hasFade({})).toBe(false);
  });
});
