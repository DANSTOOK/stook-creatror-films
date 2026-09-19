import { describe, expect, it } from 'vitest';
import { assetLengthFrames, assetLengthSeconds } from '../src/renderer/media/assetLength';

describe('media length at the project rate', () => {
  // Kratos: 19 minutes of footage, imported while the project was at 30 fps.
  const footage = { durationFrames: 19 * 60 * 30, durationSeconds: 19 * 60 };

  it('is the same wall-clock length at whatever rate the project runs', () => {
    expect(assetLengthFrames(footage, 30)).toBe(34_200);
    expect(assetLengthFrames(footage, 24)).toBe(27_360);
    expect(assetLengthFrames(footage, 60)).toBe(68_400);
  });

  it('does not keep the import rate after the project changes', () => {
    // The bug: 34,200 frames read at 24 fps is 23.75 minutes of a 19-minute file.
    expect(assetLengthFrames(footage, 24) / 24 / 60).toBeCloseTo(19, 6);
  });

  it('comes back exactly when the rate change is undone', () => {
    const at24 = assetLengthFrames(footage, 24);
    const back = assetLengthFrames(footage, 30);
    expect(at24).not.toBe(back);
    expect(back).toBe(footage.durationFrames);
  });

  it('falls back to the stored frames for projects saved before seconds were kept', () => {
    expect(assetLengthFrames({ durationFrames: 150 }, 24)).toBe(150);
    expect(assetLengthSeconds({ durationFrames: 150 }, 30)).toBe(5);
  });

  it('never gives a zero-length clip', () => {
    expect(assetLengthFrames({ durationFrames: 0, durationSeconds: 0.001 }, 24)).toBe(1);
  });

  it('shows the file\'s own length', () => {
    expect(assetLengthSeconds(footage, 24)).toBe(1140);
  });
});
