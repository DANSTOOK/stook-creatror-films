import { describe, expect, it } from 'vitest';
import { recommendedAudioBitrateKbps, recommendedBitrateKbps } from '@shared/utils/bitrate';

/**
 * Bitrate selection.
 *
 * Checked against YouTube's published SDR upload table, which is the anchor the
 * formula was derived from. Agreement within 30% is the bar: the table is a set
 * of round numbers, not a curve, so matching it exactly would be overfitting.
 *
 * https://support.google.com/youtube/answer/1722171
 */

const within = (actual: number, expected: number, tolerance = 0.3): boolean =>
  Math.abs(actual - expected) / expected <= tolerance;

describe('recommendedBitrateKbps', () => {
  it('tracks the published table at standard frame rates', () => {
    const cases: [string, number, number, number, number][] = [
      // label, width, height, fps, YouTube kbps
      ['360p30', 640, 360, 30, 1000],
      ['480p30', 854, 480, 30, 2500],
      ['720p30', 1280, 720, 30, 5000],
      ['1080p30', 1920, 1080, 30, 8000],
      ['1440p30', 2560, 1440, 30, 16000],
      ['2160p30', 3840, 2160, 30, 40000],
    ];

    for (const [label, width, height, fps, expected] of cases) {
      const actual = recommendedBitrateKbps(width, height, fps);
      expect(within(actual, expected), `${label}: got ${actual}, table says ${expected}`).toBe(true);
    }
  });

  it('tracks the published table at high frame rates', () => {
    expect(within(recommendedBitrateKbps(1920, 1080, 60), 12000)).toBe(true);
    expect(within(recommendedBitrateKbps(1280, 720, 60), 7500)).toBe(true);
  });

  it('charges sub-linearly for frame rate, not double for double', () => {
    const thirty = recommendedBitrateKbps(1920, 1080, 30);
    const sixty = recommendedBitrateKbps(1920, 1080, 60);
    const ratio = sixty / thirty;

    // YouTube's HFR column is exactly 1.5x its standard column.
    expect(ratio).toBeGreaterThan(1.4);
    expect(ratio).toBeLessThan(1.6);
  });

  it('scales with pixel count', () => {
    const small = recommendedBitrateKbps(640, 360, 30);
    const quadrupled = recommendedBitrateKbps(1280, 720, 30);
    expect(quadrupled / small).toBeCloseTo(4, 0);
  });

  it('sizes a vertical phone clip sensibly rather than inheriting a 1080p figure', () => {
    // The real case: 474x850 was being exported at a fixed 12 Mbps, producing
    // six seconds heavier than the 43-second source.
    const kbps = recommendedBitrateKbps(474, 850, 30);

    expect(kbps).toBeLessThan(3000);
    expect(kbps).toBeGreaterThan(1000);
  });

  it('clamps rather than returning something unusable', () => {
    expect(recommendedBitrateKbps(16, 16, 30)).toBeGreaterThanOrEqual(500);
    expect(recommendedBitrateKbps(15360, 8640, 120)).toBeLessThanOrEqual(120000);
  });

  it('survives nonsense input', () => {
    expect(recommendedBitrateKbps(1920, 1080, 0)).toBeGreaterThan(0);
    expect(recommendedBitrateKbps(1920, 1080, Number.NaN)).toBeGreaterThan(0);
    expect(Number.isFinite(recommendedBitrateKbps(0, 0, 30))).toBe(true);
  });
});

describe('recommendedAudioBitrateKbps', () => {
  it('scales with the channel count', () => {
    expect(recommendedAudioBitrateKbps(1)).toBe(128);
    expect(recommendedAudioBitrateKbps(2)).toBe(256);
    expect(recommendedAudioBitrateKbps(6)).toBe(512);
  });
});
